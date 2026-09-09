const redisUrl = process.env.KV_REST_API_URL;
const redisToken = process.env.KV_REST_API_TOKEN;
const adminSecret = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD;

async function redis(command, ...args) {
  if (!redisUrl || !redisToken) throw new Error("Redis analytics is not configured.");
  const path = [command, ...args.map(v => encodeURIComponent(String(v)))].join("/");
  const r = await fetch(redisUrl.replace(/\/$/, "") + "/" + path, {
    headers: { Authorization: "Bearer " + redisToken }
  });
  if (!r.ok) throw new Error("Redis request failed.");
  return r.json();
}

function authorized(req) {
  const h = req.headers.authorization || "";
  return !!adminSecret && h === "Bearer " + adminSecret;
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function sourceFromEvent(e) {
  let source = String(e?.utm_source || "").trim().toLowerCase();
  if (source) return source;

  try {
    const ref = e?.referrer ? new URL(e.referrer) : null;
    const host = ref ? String(ref.hostname || "").toLowerCase().replace(/^www\./, "") : "";
    const currentHost = String(e?.host || "").toLowerCase().replace(/^www\./, "");
    if (host && host !== "localhost" && (!currentHost || host !== currentHost)) return host;
  } catch (_) {}

  return "direct";
}

function isPrimaryBuyClick(e) {
  if (e?.event !== "buy_click") return false;
  const d = e?.data && typeof e.data === "object" ? e.data : {};
  if (["hero", "purchase_card", "package_preview"].includes(String(d.cta || ""))) return true;
  return ["heroGetSuccess", "package-buy-button", "package-preview-buy"].includes(String(d.id || ""));
}

async function setHash(key, values) {
  const entries = Object.entries(values).filter(([, value]) => Number.isFinite(Number(value)) && Number(value) !== 0);
  if (!entries.length) return;
  const args = [];
  for (const [field, value] of entries) args.push(field, Math.round(Number(value)));
  await redis("hset", key, ...args);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });
  if (!authorized(req)) return res.status(401).json({ message: "Unauthorized" });

  try {
    const body = req.body || {};
    if (body.confirm !== "REBUILD_ANALYTICS_DIMENSIONS") {
      return res.status(400).json({ message: "Confirmation required." });
    }

    const rawResponse = await redis("lrange", "analytics:events", "0", "9999");
    const rows = Array.isArray(rawResponse.result) ? rawResponse.result : [];

    const byDay = new Map();
    let parsedEvents = 0;
    let oldest = null;
    let newest = null;

    for (const raw of rows) {
      let e;
      try { e = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { continue; }
      const ts = Number(e?.ts);
      if (!e || !Number.isFinite(ts)) continue;
      parsedEvents++;
      oldest = oldest == null ? ts : Math.min(oldest, ts);
      newest = newest == null ? ts : Math.max(newest, ts);

      const day = dayKey(ts);
      if (!byDay.has(day)) {
        byDay.set(day, {
          pages: {},
          sources: {},
          devices: {},
          buyClicks: 0,
          paymentAttempts: 0,
          paymentFailures: 0
        });
      }
      const d = byDay.get(day);

      if (e.event === "page_view") {
        const page = String(e.page || "").slice(0, 200);
        if (page) d.pages[page] = (d.pages[page] || 0) + 1;
        const source = sourceFromEvent(e);
        d.sources[source] = (d.sources[source] || 0) + 1;
        const device = String(e.device || "").slice(0, 20);
        if (device) d.devices[device] = (d.devices[device] || 0) + 1;
      }

      if (isPrimaryBuyClick(e)) d.buyClicks++;
      if (e.event === "payment_attempt" && e.data?.order_id) d.paymentAttempts++;
      if (e.event === "payment_failed" && e.data?.order_id) d.paymentFailures++;
    }

    // Only rewrite days represented in the retained raw stream. We cannot
    // safely reconstruct days whose raw events have already fallen out of the
    // capped stream.
    for (const [day, d] of byDay) {
      await Promise.all([
        redis("del", "analytics:pages:" + day),
        redis("del", "analytics:sources:" + day),
        redis("del", "analytics:devices:" + day)
      ]);
      await Promise.all([
        setHash("analytics:pages:" + day, d.pages),
        setHash("analytics:sources:" + day, d.sources),
        setHash("analytics:devices:" + day, d.devices)
      ]);

      // Preserve all other event counters. Only replace metrics whose old
      // aggregation rules were known to be wrong.
      await redis("hset", "analytics:counter:" + day, "buy_click", d.buyClicks, "payment_attempt_unique", d.paymentAttempts, "payment_failed_unique", d.paymentFailures);
    }

    return res.status(200).json({
      ok: true,
      message: "Historical analytics dimensions rebuilt from the retained raw event stream.",
      affected_days: byDay.size,
      parsed_events: parsedEvents,
      oldest_event: oldest,
      newest_event: newest,
      note: "Only days represented in the retained 10,000-event stream were rebuilt. Verified purchase and revenue aggregates were preserved."
    });
  } catch (error) {
    console.error("Analytics migration error:", error);
    return res.status(500).json({ message: error.message || "Unable to rebuild historical analytics." });
  }
};

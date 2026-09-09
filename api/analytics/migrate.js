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
  return new Date(ts || Date.now()).toISOString().slice(0, 10);
}

function sourceFromEvent(e) {
  const explicit = String(e?.utm_source || "").trim().toLowerCase();
  if (explicit) return explicit;
  try {
    const ref = e?.referrer ? new URL(e.referrer) : null;
    const host = ref ? String(ref.hostname || "").toLowerCase().replace(/^www\./, "") : "";
    const currentHost = String(e?.host || "").toLowerCase().replace(/^www\./, "");
    if (host && (!currentHost || host !== currentHost) && host !== "localhost") return host;
  } catch (_) {}
  return "direct";
}

function isPrimaryBuyClick(e) {
  if (e?.event !== "buy_click") return false;
  const id = String(e?.data?.id || "").trim();
  const cta = String(e?.data?.cta || "").trim();
  return cta === "hero" || cta === "purchase_card" || cta === "package_preview" ||
    id === "heroGetSuccess" || id === "package-buy-button" || id === "package-preview-buy";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });
  if (!authorized(req)) return res.status(401).json({ message: "Unauthorized" });

  try {
    const confirm = String(req.body?.confirm || "");
    if (confirm !== "REBUILD_ANALYTICS_DIMENSIONS") {
      return res.status(400).json({
        message: "Confirmation required. Send confirm=REBUILD_ANALYTICS_DIMENSIONS to run the one-time rebuild."
      });
    }

    const rawResult = await redis("lrange", "analytics:events", "0", "9999");
    const rows = Array.isArray(rawResult.result) ? rawResult.result : [];
    const days = new Set();
    const pages = {}, sources = {}, devices = {}, buyClicks = {}, attempts = {}, failures = {};
    let parsed = 0;
    let oldest = Infinity;
    let newest = 0;

    for (const raw of rows) {
      let e;
      try { e = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { continue; }
      if (!e) continue;
      const ts = Number(e.ts);
      if (!Number.isFinite(ts)) continue;
      parsed++;
      oldest = Math.min(oldest, ts);
      newest = Math.max(newest, ts);
      const day = dayKey(ts);
      days.add(day);

      if (e.event === "page_view") {
        const page = String(e.page || "/");
        pages[day] ||= {};
        pages[day][page] = (pages[day][page] || 0) + 1;
        const source = sourceFromEvent(e);
        sources[day] ||= {};
        sources[day][source] = (sources[day][source] || 0) + 1;
        const device = String(e.device || "unknown");
        devices[day] ||= {};
        devices[day][device] = (devices[day][device] || 0) + 1;
      }

      if (isPrimaryBuyClick(e)) {
        buyClicks[day] = (buyClicks[day] || 0) + 1;
      }
      const orderId = String(e?.data?.order_id || "").trim();
      if (orderId && e.event === "payment_attempt") attempts[day] = (attempts[day] || 0) + 1;
      if (orderId && e.event === "payment_failed") failures[day] = (failures[day] || 0) + 1;
    }

    // Only days represented by the retained raw event stream are rebuilt.
    // Redis intentionally caps this stream at 10,000 events, so the response
    // tells the admin exactly what historical window was available for repair.
    const affectedDays = [...days].sort();
    for (const day of affectedDays) {
      await Promise.all([
        redis("del", "analytics:pages:" + day),
        redis("del", "analytics:sources:" + day),
        redis("del", "analytics:devices:" + day)
      ]);
      const counterKey = "analytics:counter:" + day;
      await Promise.all([
        redis("hdel", counterKey, "buy_click"),
        redis("hdel", counterKey, "payment_attempt_unique"),
        redis("hdel", counterKey, "payment_failed_unique")
      ]);

      for (const [key, value] of Object.entries(pages[day] || {})) await redis("hincrby", "analytics:pages:" + day, key, value);
      for (const [key, value] of Object.entries(sources[day] || {})) await redis("hincrby", "analytics:sources:" + day, key, value);
      for (const [key, value] of Object.entries(devices[day] || {})) await redis("hincrby", "analytics:devices:" + day, key, value);
      if (buyClicks[day]) await redis("hincrby", counterKey, "buy_click", buyClicks[day]);
      if (attempts[day]) await redis("hincrby", counterKey, "payment_attempt_unique", attempts[day]);
      if (failures[day]) await redis("hincrby", counterKey, "payment_failed_unique", failures[day]);
    }

    return res.status(200).json({
      success: true,
      message: "Analytics dimensions rebuilt from the retained raw event stream.",
      parsed_events: parsed,
      affected_days: affectedDays.length,
      oldest_event: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
      newest_event: newest ? new Date(newest).toISOString() : null,
      note: "The raw analytics stream is capped at 10,000 events. Events older than the retained stream cannot be reconstructed by this migration. Verified purchase/revenue records were not deleted."
    });
  } catch (error) {
    console.error("Analytics migration error:", error);
    return res.status(500).json({ message: error.message || "Analytics migration failed." });
  }
};

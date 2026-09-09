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
  return new Date(ts || Date.now()).toISOString().slice(0,10);
}

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase().replace(/^www\./, "");
}

function sourceFromEvent(e) {
  const explicit = String(e?.utm_source || "").trim().toLowerCase();
  if (explicit) return explicit.slice(0,100);
  try {
    const ref = e?.referrer ? new URL(e.referrer) : null;
    const host = normalizeHost(ref && ref.hostname);
    const currentHost = normalizeHost(e?.host);
    if (host && (!currentHost || host !== currentHost) && host !== "localhost") return host.slice(0,100);
  } catch (_) {}
  return "direct";
}

function primaryBuyCta(e) {
  if (e?.event !== "buy_click") return "";
  const id = String(e?.data?.id || "").trim();
  const cta = String(e?.data?.cta || "").trim();
  if (cta === "hero" || cta === "purchase_card" || cta === "package_preview") return cta;
  if (id === "heroGetSuccess") return "hero";
  if (id === "package-buy-button") return "purchase_card";
  if (id === "package-preview-buy") return "package_preview";
  return "";
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
    const pages = {}, sources = {}, devices = {}, buyCtas = {};
    const eventCounts = {}, attempts = {}, failures = {};
    let parsed = 0, oldest = Infinity, newest = 0;

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

      eventCounts[day] ||= {};
      eventCounts[day][e.event] = (eventCounts[day][e.event] || 0) + 1;

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

      const cta = primaryBuyCta(e);
      if (cta) {
        buyCtas[day] ||= {};
        buyCtas[day][cta] = (buyCtas[day][cta] || 0) + 1;
      }

      const orderId = String(e?.data?.order_id || "").trim();
      if (orderId && e.event === "payment_attempt") attempts[day] = (attempts[day] || 0) + 1;
      if (orderId && e.event === "payment_failed") failures[day] = (failures[day] || 0) + 1;
    }

    const affectedDays = [...days].sort();
    for (const day of affectedDays) {
      await Promise.all([
        redis("del", "analytics:pages:" + day),
        redis("del", "analytics:sources:" + day),
        redis("del", "analytics:devices:" + day),
        redis("del", "analytics:buy_ctas:" + day)
      ]);

      const counterKey = "analytics:counter:" + day;
      await Promise.all([
        redis("hdel", counterKey, "page_view"),
        redis("hdel", counterKey, "checkout_view"),
        redis("hdel", counterKey, "buy_click"),
        redis("hdel", counterKey, "payment_attempt_unique"),
        redis("hdel", counterKey, "payment_failed_unique")
      ]);

      const pv = eventCounts[day]?.page_view || 0;
      if (pv) await redis("hincrby", counterKey, "page_view", pv);
      const checkoutViews = eventCounts[day]?.checkout_view || 0;
      if (checkoutViews) await redis("hincrby", counterKey, "checkout_view", checkoutViews);
      const totalBuyCtas = Object.values(buyCtas[day] || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      if (totalBuyCtas) await redis("hincrby", counterKey, "buy_click", totalBuyCtas);
      if (attempts[day]) await redis("hincrby", counterKey, "payment_attempt_unique", attempts[day]);
      if (failures[day]) await redis("hincrby", counterKey, "payment_failed_unique", failures[day]);

      for (const [key, value] of Object.entries(pages[day] || {})) await redis("hincrby", "analytics:pages:" + day, key, value);
      for (const [key, value] of Object.entries(sources[day] || {})) await redis("hincrby", "analytics:sources:" + day, key, value);
      for (const [key, value] of Object.entries(devices[day] || {})) await redis("hincrby", "analytics:devices:" + day, key, value);
      for (const [key, value] of Object.entries(buyCtas[day] || {})) await redis("hincrby", "analytics:buy_ctas:" + day, key, value);
    }

    return res.status(200).json({
      success: true,
      message: "Analytics dimensions and matching counters rebuilt successfully.",
      parsed_events: parsed,
      affected_days: affectedDays.length,
      oldest_event: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
      newest_event: newest ? new Date(newest).toISOString() : null,
      note: "Only the retained raw event stream (up to 10,000 events) can be reconstructed. Verified purchase and revenue records were left untouched."
    });
  } catch (error) {
    console.error("Analytics migration error:", error);
    return res.status(500).json({ message: error.message || "Analytics migration failed." });
  }
};

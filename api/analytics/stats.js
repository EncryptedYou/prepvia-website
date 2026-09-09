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

function isoDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function startOfUtcDay(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function endOfUtcDay(ts) {
  return startOfUtcDay(ts) + 86400000;
}

function parseRange(req) {
  const q = req.query || {};
  const now = Date.now();
  const range = String(q.range || "today").toLowerCase();

  if (range === "custom") {
    const start = Date.parse(String(q.start || ""));
    const endRaw = String(q.end || "");
    const endParsed = Date.parse(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(endParsed) || endParsed <= start) {
      throw new Error("Invalid custom date range.");
    }
    return { start, end: endParsed, range: "custom" };
  }

  const today = startOfUtcDay(now);
  switch (range) {
    case "yesterday":
      return { start: today - 86400000, end: today, range };
    case "7d":
    case "last_7_days":
      return { start: today - 6 * 86400000, end: today + 86400000, range: "7d" };
    case "30d":
    case "last_30_days":
      return { start: today - 29 * 86400000, end: today + 86400000, range: "30d" };
    case "this_week": {
      const d = new Date(today);
      const day = d.getUTCDay();
      return { start: today - day * 86400000, end: today + 86400000, range };
    }
    case "last_week": {
      const d = new Date(today);
      const day = d.getUTCDay();
      const thisWeek = today - day * 86400000;
      return { start: thisWeek - 7 * 86400000, end: thisWeek, range };
    }
    case "this_month": {
      const d = new Date(today);
      const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      return { start, end: today + 86400000, range };
    }
    case "last_month": {
      const d = new Date(today);
      const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
      const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      return { start, end, range };
    }
    case "today":
    default:
      return { start: today, end: today + 86400000, range: "today" };
  }
}

function addCounts(target, hash) {
  const raw = hash && hash.result;
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const key = String(raw[i]);
      const n = Number(raw[i + 1] || 0);
      if (Number.isFinite(n)) target[key] = (target[key] || 0) + n;
    }
    return;
  }
  const obj = raw && typeof raw === "object" ? raw : {};
  for (const [key, value] of Object.entries(obj)) {
    const n = Number(value || 0);
    if (Number.isFinite(n)) target[key] = (target[key] || 0) + n;
  }
}

async function getDailyAggregates(start, end) {
  const first = startOfUtcDay(start);
  const last = startOfUtcDay(end - 1);
  const days = [];
  for (let t = first; t <= last; t += 86400000) days.push(isoDate(t));

  const results = await Promise.all(days.map(async day => {
    const [counter, revenue, visitors, sessions, pages, sources, devices, scroll, buyCtas] = await Promise.all([
      redis("hgetall", "analytics:counter:" + day),
      redis("hget", "analytics:revenue:" + day, "value"),
      redis("smembers", "analytics:visitors:" + day),
      redis("smembers", "analytics:sessions:" + day),
      redis("hgetall", "analytics:pages:" + day),
      redis("hgetall", "analytics:sources:" + day),
      redis("hgetall", "analytics:devices:" + day),
      redis("hgetall", "analytics:scroll:" + day),
      redis("hgetall", "analytics:buy_ctas:" + day)
    ]);
    return { day, counter, revenue: Number(revenue.result || 0), visitors, sessions, pages, sources, devices, scroll, buyCtas };
  }));

  const events = {}, pages = {}, sources = {}, devices = {}, scroll = {}, buyCtas = {};
  const visitorIds = new Set(), sessionIds = new Set();
  let revenue = 0;
  for (const row of results) {
    addCounts(events, row.counter);
    addCounts(pages, row.pages);
    addCounts(sources, row.sources);
    addCounts(devices, row.devices);
    addCounts(scroll, row.scroll);
    addCounts(buyCtas, row.buyCtas);
    revenue += Number.isFinite(row.revenue) ? row.revenue : 0;
    const v = row.visitors && Array.isArray(row.visitors.result) ? row.visitors.result : [];
    const ss = row.sessions && Array.isArray(row.sessions.result) ? row.sessions.result : [];
    v.forEach(id => visitorIds.add(String(id)));
    ss.forEach(id => sessionIds.add(String(id)));
  }
  return { events, pages, sources, devices, scroll, revenue, visitors: visitorIds.size, sessions: sessionIds.size, days: results };
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ message: "Unauthorized" });

  if (req.method !== "GET") return res.status(405).json({ message: "Method not allowed" });

  try {
    const now = Date.now();
    const { start, end, range } = parseRange(req);
    const activeCutoff = now - 90 * 1000;

    await redis("zremrangebyscore", "analytics:active", "-inf", activeCutoff);

    const [daily, active, visitorsTotal, eventsRaw] = await Promise.all([
      getDailyAggregates(start, end),
      redis("zcard", "analytics:active"),
      redis("scard", "analytics:visitors"),
      redis("lrange", "analytics:events", "0", "9999")
    ]);

    const rows = Array.isArray(eventsRaw.result) ? eventsRaw.result : [];
    let eventRevenue = 0;

    for (const raw of rows) {
      let e;
      try { e = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { continue; }
      const ts = Number(e?.ts);
      if (!e || ts < start || ts >= end) continue;
      if (e.event === "purchase") {
        const amount = Number(e.data && e.data.amount);
        if (Number.isFinite(amount)) eventRevenue += amount;
      }
    }

    // Daily aggregates are authoritative for page views, top pages, traffic
    // sources and devices. This avoids the 10,000-event stream cap for normal
    // dashboard ranges and uses the repaired dimensions after migration.
    const eventCounts = daily.events;
    const pageViews = Object.values(daily.pages).reduce((sum, value) => sum + Number(value || 0), 0);
    const buyClicks = Object.values(daily.buyCtas).reduce((sum, value) => sum + Number(value || 0), 0);
    const checkoutViews = Number(eventCounts.checkout_view || 0);
    const paymentAttempts = Number(eventCounts.payment_attempt_unique || 0);
    const paymentFailures = Number(eventCounts.payment_failed_unique || 0);
    const purchases = Number(eventCounts.purchase || 0);
    const revenue = Number(Math.max(daily.revenue, eventRevenue).toFixed(2));

    const funnel = {
      visitors: daily.visitors,
      sessions: daily.sessions,
      page_views: pageViews,
      buy_clicks: buyClicks,
      checkout_views: checkoutViews,
      payment_attempts: paymentAttempts,
      payment_failures: paymentFailures,
      purchases,
      revenue
    };

    return res.status(200).json({
      generated_at: now,
      range,
      start,
      end,
      active_users: Number(active.result || 0),
      unique_visitors_total: Number(visitorsTotal.result || 0),
      funnel,
      conversion_rate: buyClicks ? Number((purchases / buyClicks * 100).toFixed(2)) : 0,
      visitor_to_purchase_rate: daily.visitors ? Number((purchases / daily.visitors * 100).toFixed(2)) : 0,
      payment_success_rate: paymentAttempts ? Number(Math.min(100, Math.max(0, purchases / paymentAttempts * 100)).toFixed(2)) : 0,
      events: eventCounts,
      top_pages: Object.entries(daily.pages).sort((a,b) => b[1] - a[1]).slice(0, 8).map(([page,count]) => ({ page, count })),
      traffic_sources: Object.entries(daily.sources).sort((a,b) => b[1] - a[1]).slice(0, 8).map(([source,count]) => ({ source, count })),
      devices: Object.entries(daily.devices).sort((a,b) => b[1] - a[1]).map(([device,count]) => ({ device, count })),
      buy_ctas: Object.entries(daily.buyCtas).sort((a,b) => b[1] - a[1]).map(([cta,count]) => ({ cta, count })),
      scroll_depth: daily.scroll
    });
  } catch (error) {
    console.error("Analytics stats error:", error);
    return res.status(400).json({ message: error.message || "Unable to load analytics." });
  }
};

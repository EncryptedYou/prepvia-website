const { } = require("./store");

const redisUrl = process.env.KV_REST_API_URL;
const redisToken = process.env.KV_REST_API_TOKEN;
const adminSecret = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD;

async function redis(command, ...args) {
  if (!redisUrl || !redisToken) throw new Error("Redis analytics is not configured.");
  const path = [command, ...args.map(v => encodeURIComponent(String(v)))].join("/");
  const r = await fetch(redisUrl.replace(/\/$/, "") + "/" + path, {
    headers: {Authorization:"Bearer " + redisToken}
  });
  if (!r.ok) throw new Error("Redis request failed.");
  return r.json();
}

function authorized(req) {
  const h = req.headers.authorization || "";
  return !!adminSecret && h === "Bearer " + adminSecret;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({message:"Method not allowed"});
  if (!authorized(req)) return res.status(401).json({message:"Unauthorized"});

  try {
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    const activeCutoff = now - 90 * 1000;

    await redis("zremrangebyscore", "analytics:active", "-inf", activeCutoff);

    const [events, active, visitors, todayVisitors] = await Promise.all([
      redis("lrange","analytics:events","0","9999"),
      redis("zcard","analytics:active"),
      redis("scard","analytics:visitors"),
      redis("scard","analytics:visitors:" + new Date().toISOString().slice(0,10))
    ]);

    const rows = Array.isArray(events.result) ? events.result : [];
    const counts = {};
    const pages = {};
    const sources = {};
    const devices = {};
    const scroll = {};
    let revenue24h = 0;
    let purchases24h = 0;
    let buyClicks24h = 0;
    let checkout24h = 0;
    let paymentAttempts24h = 0;
    let paymentFailures24h = 0;
    let pageViews24h = 0;

    rows.forEach(raw => {
      let e;
      try { e = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { return; }
      if (!e || Number(e.ts) < cutoff) return;

      counts[e.event] = (counts[e.event] || 0) + 1;

      if (e.event === "page_view") pageViews24h++;
      if (e.event === "buy_click") buyClicks24h++;
      if (e.event === "checkout_view") checkout24h++;
      if (e.event === "payment_attempt") paymentAttempts24h++;
      if (e.event === "payment_failed") paymentFailures24h++;

      if (e.event === "purchase") {
        purchases24h++;
        const amount = Number(e.data && e.data.amount);
        if (Number.isFinite(amount)) revenue24h += amount;
      }

      if (e.page) pages[e.page] = (pages[e.page] || 0) + 1;
      if (e.utm_source) sources[e.utm_source] = (sources[e.utm_source] || 0) + 1;
      if (e.device) devices[e.device] = (devices[e.device] || 0) + 1;

      if (e.event === "scroll_depth" && e.data && e.data.percent_scrolled != null) {
        const m = String(e.data.percent_scrolled);
        scroll[m] = (scroll[m] || 0) + 1;
      }
    });

    const funnel = {
      visitors_today: Number(todayVisitors.result || 0),
      page_views_24h: pageViews24h,
      buy_clicks_24h: buyClicks24h,
      checkout_views_24h: checkout24h,
      payment_attempts_24h: paymentAttempts24h,
      payment_failures_24h: paymentFailures24h,
      purchases_24h: purchases24h,
      revenue_24h: Number(revenue24h.toFixed(2))
    };

    return res.status(200).json({
      generated_at: now,
      active_users: Number(active.result || 0),
      unique_visitors_total: Number(visitors.result || 0),
      funnel,
      conversion_rate: buyClicks24h ? Number((purchases24h / buyClicks24h * 100).toFixed(2)) : 0,
      payment_success_rate: paymentAttempts24h ? Number(((paymentAttempts24h - paymentFailures24h) / paymentAttempts24h * 100).toFixed(2)) : 0,
      events_24h: counts,
      top_pages: Object.entries(pages).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([page,count])=>({page,count})),
      traffic_sources: Object.entries(sources).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([source,count])=>({source,count})),
      devices: Object.entries(devices).sort((a,b)=>b[1]-a[1]).map(([device,count])=>({device,count})),
      scroll_depth: scroll
    });
  } catch (error) {
    console.error("Analytics stats error:", error);
    return res.status(500).json({message:"Unable to load analytics."});
  }
};

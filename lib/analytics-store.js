const redisUrl = process.env.KV_REST_API_URL;
const redisToken = process.env.KV_REST_API_TOKEN;

async function redis(command, ...args) {
  if (!redisUrl || !redisToken) throw new Error("Redis analytics is not configured.");
  const path = [command, ...args.map(v => encodeURIComponent(String(v)))].join("/");
  const r = await fetch(redisUrl.replace(/\/$/, "") + "/" + path, {
    headers: { Authorization: "Bearer " + redisToken }
  });
  if (!r.ok) throw new Error("Redis request failed.");
  return r.json();
}

function dayKey(ts) { return new Date(ts || Date.now()).toISOString().slice(0,10); }
function normalizeHost(value) { return String(value || "").trim().toLowerCase().replace(/^www\./, ""); }

function sourceFromPayload(payload) {
  const explicit = String(payload.utm_source || "").trim().toLowerCase();
  if (explicit) return explicit.slice(0,100);
  try {
    const ref = payload.referrer ? new URL(payload.referrer) : null;
    const host = normalizeHost(ref && ref.hostname);
    const currentHost = normalizeHost(payload.host);
    if (host && host !== currentHost && host !== "localhost") return host.slice(0,100);
  } catch (_) {}
  return "direct";
}

function ctaFromData(data) {
  const cta = String(data?.cta || "").trim();
  if (cta === "hero" || cta === "purchase_card" || cta === "package_preview") return cta;
  const id = String(data?.id || "").trim();
  if (id === "heroGetSuccess") return "hero";
  if (id === "package-buy-button") return "purchase_card";
  if (id === "package-preview-buy") return "package_preview";
  return "";
}

async function recordEvent(event, payload = {}) {
  const now = Date.now();
  const day = dayKey(now);
  const safe = {
    event: String(event || "").slice(0,50), ts: now,
    visitor_id: String(payload.visitor_id || "").slice(0,100),
    session_id: String(payload.session_id || "").slice(0,100),
    page: String(payload.page || "").slice(0,200),
    page_title: String(payload.page_title || "").slice(0,160),
    referrer: String(payload.referrer || "").slice(0,300),
    utm_source: String(payload.utm_source || "").slice(0,100),
    utm_medium: String(payload.utm_medium || "").slice(0,100),
    utm_campaign: String(payload.utm_campaign || "").slice(0,150),
    device: String(payload.device || "").slice(0,20),
    host: String(payload.host || "").slice(0,200),
    data: payload.data && typeof payload.data === "object" ? payload.data : {}
  };

  // Payment events are deduplicated by the real Razorpay order/payment identifier.
  if ((safe.event === "payment_attempt" || safe.event === "payment_failed") && safe.data?.order_id) {
    const prefix = safe.event === "payment_attempt" ? "payment_attempt" : "payment_failed";
    const key = "analytics:" + prefix + ":" + String(safe.data.order_id).slice(0,120);
    const dedupe = await redis("set", key, "1", "nx", "ex", 31536000);
    if (dedupe && dedupe.result !== "OK") return safe;
  }

  // Page views are only valid for the homepage. Deduplicate by session on the server too,
  // so duplicate browser requests/tabs cannot inflate views, sources, or devices.
  if (safe.event === "page_view") {
    const page = safe.page || "/";
    if (page !== "/" && page !== "/index.html") return safe;
    if (!safe.session_id) return safe;
    const viewKey = "analytics:index_view:session:" + safe.session_id.slice(0,100);
    const first = await redis("set", viewKey, "1", "nx", "ex", 2592000);
    if (first && first.result !== "OK") return safe;
  }

  await redis("lpush", "analytics:events", JSON.stringify(safe));
  await redis("ltrim", "analytics:events", "0", "9999");

  if (safe.session_id) {
    await redis("zadd", "analytics:active", now, safe.session_id);
    await redis("sadd", "analytics:sessions:" + day, safe.session_id);
  }
  if (safe.event === "page_view" && safe.visitor_id) {
    const firstVisitor = await redis("sadd", "analytics:visitors", safe.visitor_id);
    if (firstVisitor?.result === 1) {
      await redis("sadd", "analytics:new_visitors:" + day, safe.visitor_id);
    }
    // Keep daily unique visitors for diagnostics, but dashboard 'Unique visitors' uses first-time visitors.
    await redis("sadd", "analytics:visitors:" + day, safe.visitor_id);
  }

  await redis("hincrby", "analytics:counter:" + day, safe.event, 1);
  if (safe.event === "payment_attempt" && safe.data?.order_id)
    await redis("hincrby", "analytics:counter:" + day, "payment_attempt_unique", 1);
  if (safe.event === "payment_failed" && safe.data?.order_id)
    await redis("hincrby", "analytics:counter:" + day, "payment_failed_unique", 1);

  if (safe.event === "page_view") {
    const page = safe.page || "/";
    await redis("hincrby", "analytics:pages:" + day, page, 1);
    await redis("hincrby", "analytics:sources:" + day, sourceFromPayload(safe), 1);
    await redis("hincrby", "analytics:devices:" + day, safe.device || "unknown", 1);
  }
  if (safe.event === "buy_click") {
    const cta = ctaFromData(safe.data);
    if (cta) await redis("hincrby", "analytics:buy_ctas:" + day, cta, 1);
  }
  if (safe.event === "scroll_depth" && safe.data?.percent_scrolled != null)
    await redis("hincrby", "analytics:scroll:" + day, String(safe.data.percent_scrolled), 1);

  if (safe.event === "purchase" && safe.data?.amount != null) {
    const amount = Number(safe.data.amount);
    if (Number.isFinite(amount)) await redis("hincrbyfloat", "analytics:revenue:" + day, "value", amount);
  }
  return safe;
}

async function recordVerifiedPurchase({order_id, payment_id, amount, coupon}) {
  return recordEvent("purchase", {
    page: "/success.html", page_title: "Payment Success",
    data: { order_id:String(order_id||"").slice(0,120), payment_id:String(payment_id||"").slice(0,120), amount:Number(amount||0), currency:"INR", coupon:coupon?String(coupon).slice(0,40):null, verified:true }
  });
}
module.exports = { recordEvent, recordVerifiedPurchase };

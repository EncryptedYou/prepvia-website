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


function referralCodeFromPayload(payload) {
  const direct = String(payload.referral_code || payload.data?.referral_code || "").trim().toUpperCase();
  return /^[A-Z0-9_-]{3,40}$/.test(direct) ? direct : "";
}
function referralKeyPart(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0,40);
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
    referral_code: referralCodeFromPayload(payload),
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

  // Page views are only valid for the homepage. The general website view is
  // deduplicated by session, while referral views have their own session+code
  // dedupe so a visitor can still be attributed when they later enter through
  // a referral link in the same browser session.
  let firstIndexView = true;
  if (safe.event === "page_view") {
    const page = safe.page || "/";
    if (page !== "/" && page !== "/index.html") return safe;
    if (!safe.session_id) return safe;
    const viewKey = "analytics:index_view:session:" + safe.session_id.slice(0,100);
    const first = await redis("set", viewKey, "1", "nx", "ex", 2592000);
    firstIndexView = !first || first.result === "OK";
  }


  // Referral attribution is first-party and persists with the visitor/session.
  // Aggregate referral dimensions separately so referral analytics are not limited
  // by the retained raw-event list.
  if (safe.referral_code) {
    const rc = referralKeyPart(safe.referral_code);
    const base = "referral:" + rc + ":" + day;
    if (safe.event === "page_view") {
      const referralViewKey = "analytics:referral_view:session:" + (safe.session_id || "none").slice(0,100) + ":" + rc;
      const firstReferralView = await redis("set", referralViewKey, "1", "nx", "ex", 2592000);
      if (!firstReferralView || firstReferralView.result === "OK") {
        await redis("hincrby", base + ":counter", "views", 1);
        if (safe.visitor_id) await redis("sadd", base + ":visitors", safe.visitor_id);
        if (safe.session_id) await redis("sadd", base + ":sessions", safe.session_id);
        await redis("hincrby", base + ":sources", sourceFromPayload(safe), 1);
        await redis("hincrby", base + ":devices", safe.device || "unknown", 1);
        const hour = String(new Date(now).getUTCHours()).padStart(2,"0");
        await redis("hincrby", base + ":hours", hour, 1);
      }
    }
    if (safe.event === "buy_click") await redis("hincrby", base + ":counter", "buy_clicks", 1);
    if (safe.event === "checkout_view") await redis("hincrby", base + ":counter", "checkout_views", 1);
    if (safe.event === "payment_attempt") await redis("hincrby", base + ":counter", "payment_attempts", 1);
    if (safe.event === "payment_failed") await redis("hincrby", base + ":counter", "payment_failures", 1);
    if (safe.event === "purchase") {
      await redis("hincrby", base + ":counter", "purchases", 1);
      const amount = Number(safe.data?.amount);
      if (Number.isFinite(amount)) await redis("hincrbyfloat", base + ":counter", "revenue", amount);
    }
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

async function recordVerifiedPurchase({order_id, payment_id, amount, coupon, referral_code, session_id, visitor_id, referrer, utm_source, utm_medium, utm_campaign, device}) {
  const paymentKey = String(payment_id || order_id || "").slice(0,120);
  if (!paymentKey) throw new Error("Missing verified payment identifier.");
  const claimed = await redis("set", "analytics:purchase:recorded:" + paymentKey, "1", "nx", "ex", 31536000);
  if (claimed?.result !== "OK") return { duplicate: true };
  try {
    return await recordEvent("purchase", {
      page: "/success.html", page_title: "Payment Success",
      referral_code, session_id, visitor_id, referrer, utm_source, utm_medium, utm_campaign, device,
      data: { order_id:String(order_id||"").slice(0,120), payment_id:paymentKey, amount:Number(amount||0), currency:"INR", coupon:coupon?String(coupon).slice(0,40):null, verified:true }
    });
  } catch (error) {
    // Allow a retry if Redis analytics was temporarily unavailable.
    await redis("del", "analytics:purchase:recorded:" + paymentKey).catch(() => {});
    throw error;
  }
}
module.exports = { recordEvent, recordVerifiedPurchase };

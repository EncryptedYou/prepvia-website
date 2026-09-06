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

function dayKey(ts) {
  return new Date(ts || Date.now()).toISOString().slice(0,10);
}

async function recordEvent(event, payload = {}) {
  const now = Date.now();
  const day = dayKey(now);

  const safe = {
    event: String(event || "").slice(0,50),
    ts: now,
    visitor_id: String(payload.visitor_id || "").slice(0,100),
    session_id: String(payload.session_id || "").slice(0,100),
    page: String(payload.page || "").slice(0,200),
    page_title: String(payload.page_title || "").slice(0,160),
    referrer: String(payload.referrer || "").slice(0,300),
    utm_source: String(payload.utm_source || "").slice(0,100),
    utm_medium: String(payload.utm_medium || "").slice(0,100),
    utm_campaign: String(payload.utm_campaign || "").slice(0,150),
    device: String(payload.device || "").slice(0,20),
    data: payload.data && typeof payload.data === "object" ? payload.data : {}
  };

  const eventJson = JSON.stringify(safe);

  // Event stream, capped so Redis does not grow without bound.
  await redis("lpush", "analytics:events", eventJson);
  await redis("ltrim", "analytics:events", "0", "9999");

  if (safe.visitor_id) {
    await redis("sadd", "analytics:visitors", safe.visitor_id);
    await redis("sadd", "analytics:visitors:" + day, safe.visitor_id);
  }

  if (safe.session_id) {
    await redis("zadd", "analytics:active", now, safe.session_id);
  }

  await redis("hincrby", "analytics:counter:" + day, safe.event, 1);

  if (safe.data && safe.data.value != null) {
    const value = Number(safe.data.value);
    if (Number.isFinite(value)) {
      await redis("hincrbyfloat", "analytics:revenue:" + day, "value", value);
    }
  }

  return safe;
}

async function recordVerifiedPurchase({order_id, payment_id, amount, coupon}) {
  return recordEvent("purchase", {
    visitor_id: "",
    session_id: "",
    page: "/success.html",
    page_title: "Payment Success",
    data: {
      order_id: String(order_id || "").slice(0,120),
      payment_id: String(payment_id || "").slice(0,120),
      amount: Number(amount || 0),
      currency: "INR",
      coupon: coupon ? String(coupon).slice(0,40) : null,
      verified: true
    }
  });
}

module.exports = { recordEvent, recordVerifiedPurchase };

const crypto = require("crypto");
const { recordEvent } = require("../../lib/analytics-store");

async function rateLimited(req) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false; // Keep analytics non-blocking if Redis is unavailable.
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || String(req.headers['x-real-ip'] || 'unknown');
  const minute = Math.floor(Date.now() / 60000);
  const key = 'analytics:rate:' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32) + ':' + minute;
  const path = '/incr/' + encodeURIComponent(key);
  const r = await fetch(url.replace(/\/$/, '') + path, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return false;
  const data = await r.json();
  const count = Number(data.result || 0);
  if (count === 1) {
    await fetch(url.replace(/\/$/, '') + '/expire/' + encodeURIComponent(key) + '/120', {
      headers: { Authorization: 'Bearer ' + token }
    }).catch(() => {});
  }
  return count > 120;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({message:"Method not allowed"});
  }

  try {
    if (await rateLimited(req)) return res.status(429).json({message:"Too many analytics requests."});

    const body = req.body || {};
    if (JSON.stringify(body).length > 12000) return res.status(413).json({message:"Analytics payload too large."});
    const allowed = new Set([
      "page_view","heartbeat","buy_click","scroll_depth","checkout_view",
      "coupon_attempt","coupon_applied","payment_attempt","payment_failed",
      "session_end"
    ]);

    const event = String(body.event || "");
    if (!allowed.has(event)) {
      return res.status(400).json({message:"Unsupported analytics event."});
    }

    const safe = {
      visitor_id: body.visitor_id,
      session_id: body.session_id,
      page: body.page,
      page_title: body.page_title,
      referrer: body.referrer,
      utm_source: body.utm_source,
      utm_medium: body.utm_medium,
      utm_campaign: body.utm_campaign,
      referral_code: body.referral_code,
      device: body.device,
      host: req.headers.host || "",
      data: body.data
    };

    // Never accept name, email, phone, card data or payment secrets
    // from the public analytics endpoint.
    await recordEvent(event, safe);
    return res.status(204).end();
  } catch (error) {
    console.error("Analytics event error:", error);
    // Analytics must never break the storefront.
    return res.status(204).end();
  }
};

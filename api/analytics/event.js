const { recordEvent } = require("../../lib/analytics-store");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({message:"Method not allowed"});
  }

  try {
    const body = req.body || {};
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
      device: body.device,
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

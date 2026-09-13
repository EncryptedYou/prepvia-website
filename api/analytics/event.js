const { recordEvent } = require('../../lib/analytics-store');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed.' });
  try {
    const body = req.body || {};
    const event = String(body.event || '').trim().slice(0, 50);
    const allowed = new Set(['page_view','heartbeat','buy_click','checkout_view','payment_attempt','payment_failed','coupon_attempt','coupon_applied','purchase','scroll_depth','session_end']);
    if (!allowed.has(event)) return res.status(400).json({ message: 'Invalid analytics event.' });
    if (event === 'purchase') return res.status(403).json({ message: 'Purchase events are server-only.' });
    const safe = await recordEvent(event, body);
    return res.status(200).json({ ok: true, event: safe.event });
  } catch (error) {
    console.error('Analytics event error:', error);
    return res.status(204).end();
  }
};

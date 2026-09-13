const { BASE_AMOUNT, redisGet } = require('../lib/coupons');
const { recordVerifiedPurchase } = require('../lib/analytics-store');

const adminSecret = process.env.ADMIN_SECRET;
function authorized(req) {
  return !!adminSecret && String(req.headers.authorization || '') === 'Bearer ' + adminSecret;
}
function istDayBounds() {
  // Razorpay timestamps are Unix seconds; Prep.via operates on India time for "today".
  const now = new Date();
  const ist = new Date(now.getTime() + 330 * 60000);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
  const start = Date.UTC(y, m, d) - 330 * 60000;
  return { from: Math.floor(start / 1000), to: Math.floor((start + 86400000) / 1000) };
}
async function razorpay(path, key, secret) {
  const auth = Buffer.from(key + ':' + secret).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1/' + path, { headers: { Authorization: 'Basic ' + auth } });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.description || 'Unable to read Razorpay.');
  return data;
}
async function redis(command, ...args) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis analytics is not configured.');
  const path = [command, ...args.map(v => encodeURIComponent(String(v)))].join('/');
  const r = await fetch(url.replace(/\/$/, '') + '/' + path, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('Redis request failed.');
  return r.json();
}
module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ message: 'Unauthorized.' });
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed.' });
  try {
    const key = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key || !secret) return res.status(500).json({ message: 'Razorpay configuration missing.' });
    const { from, to } = istDayBounds();
    const payments = await razorpay('payments?from=' + from + '&to=' + to + '&count=100', key, secret);
    const raw = await redis('lrange', 'analytics:events', '0', '9999');
    const existing = new Set();
    for (const item of (raw.result || [])) {
      try { const e = typeof item === 'string' ? JSON.parse(item) : item; if (e?.event === 'purchase' && e?.data?.payment_id) existing.add(String(e.data.payment_id)); } catch (_) {}
    }
    let scanned = 0, recorded = 0, skipped = 0, errors = 0;
    const sales = [];
    for (const payment of (payments.items || [])) {
      if (String(payment.status || '').toLowerCase() !== 'captured') continue;
      scanned++;
      const paymentId = String(payment.id || '');
      if (!paymentId || existing.has(paymentId)) { skipped++; continue; }
      try {
        const orderId = String(payment.order_id || '');
        if (!orderId) { skipped++; continue; }
        const order = await razorpay('orders/' + encodeURIComponent(orderId), key, secret);
        const notes = order.notes || {};
        if (String(notes.product || '') !== 'JEE & NEET Success Package') { skipped++; continue; }
        const amountPaise = Number(payment.amount);
        if (!Number.isInteger(amountPaise) || amountPaise <= 0 || amountPaise > BASE_AMOUNT || String(payment.currency || '') !== 'INR') { skipped++; continue; }
        let referral = null;
        const referralRaw = await redisGet('referral:order:' + orderId);
        if (referralRaw) { try { referral = JSON.parse(referralRaw); } catch (_) {} }
        const coupon = notes.coupon && notes.coupon !== 'NONE' ? String(notes.coupon) : null;
        await recordVerifiedPurchase({
          order_id: orderId,
          payment_id: paymentId,
          amount: amountPaise / 100,
          coupon,
          referral_code: referral?.referral_code,
          session_id: referral?.session_id,
          visitor_id: referral?.visitor_id,
          referrer: referral?.referrer,
          utm_source: referral?.utm_source,
          utm_medium: referral?.utm_medium,
          utm_campaign: referral?.utm_campaign,
          device: referral?.device
        });
        existing.add(paymentId);
        recorded++;
        sales.push({ payment_id: paymentId, order_id: orderId, amount: amountPaise / 100, email: payment.email || notes.email || '' });
      } catch (e) {
        errors++;
        console.error('Today sale recovery error:', payment.id, e);
      }
    }
    return res.status(200).json({ success: true, scanned, recorded, skipped, errors, sales });
  } catch (e) {
    console.error('Today sale recovery failed:', e);
    return res.status(500).json({ message: e.message || 'Unable to recover today\'s sale.' });
  }
};

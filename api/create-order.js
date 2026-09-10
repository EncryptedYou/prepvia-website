const crypto = require('crypto');
const {
  BASE_AMOUNT, RESERVATION_TTL, cleanCode, getCoupon, validateCoupon,
  calculateDiscount, redisSet, redisSetNX, redisDel, reservationKey, randomId, redisGet
} = require('../lib/coupons');
const { recordEvent } = require('../lib/analytics-store');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  let reservation = null;
  let orderCouponKey = null;
  try {
    const { name, email, phone, coupon, analytics } = req.body || {};
    if (!name || !email || !/^\d{10}$/.test(String(phone || '')))
      return res.status(400).json({ message: 'Invalid customer details.' });

    const key = process.env.RAZORPAY_KEY_ID;
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key || !secret) return res.status(500).json({ message: 'Razorpay configuration missing.' });


    const code = cleanCode(coupon);
    let finalAmount = BASE_AMOUNT;
    let discount = 0;
    let couponRecord = null;

    if (code) {
      couponRecord = await getCoupon(code);
      const check = validateCoupon(couponRecord);
      if (!check.ok) return res.status(400).json({ message: check.message });

      const calc = calculateDiscount(couponRecord, BASE_AMOUNT);
      discount = calc.discount;
      finalAmount = calc.amount;

      reservation = reservationKey(code);
      if (!await redisSetNX(reservation, JSON.stringify({ checkoutId: randomId(), createdAt: Date.now() }), RESERVATION_TTL)) {
        return res.status(409).json({ message: 'This coupon is currently being used by another checkout. Please try again shortly.' });
      }
    }

    const auth = Buffer.from(key + ':' + secret).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: finalAmount,
        currency: 'INR',
        receipt: 'pv_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
        notes: {
          product: 'JEE & NEET Success Package', name: String(name), email: String(email), phone: String(phone),
          coupon: code || 'NONE', discount_paise: String(discount)
        }
      })
    });
    const data = await r.json();
    if (!r.ok) {
      if (reservation) await redisDel(reservation).catch(() => {});
      return res.status(r.status).json({ message: data.error?.description || 'Order creation failed.' });
    }


    if (analytics?.referral_code) {
      const rc = String(analytics.referral_code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0,40);
      if (rc) {
        await redisSet('referral:order:' + data.id, JSON.stringify({
          referral_code: rc,
          visitor_id: String(analytics?.visitor_id || '').slice(0,100),
          session_id: String(analytics?.session_id || '').slice(0,100),
          referrer: String(analytics?.referrer || '').slice(0,300),
          utm_source: String(analytics?.utm_source || '').slice(0,100),
          utm_medium: String(analytics?.utm_medium || '').slice(0,100),
          utm_campaign: String(analytics?.utm_campaign || '').slice(0,150),
          device: String(analytics?.device || '').slice(0,20)
        }), RESERVATION_TTL);
      }
    }

    if (couponRecord) {
      orderCouponKey = 'coupon:order:' + data.id;
      const snapshot = {
        coupon: couponRecord.code,
        type: couponRecord.type,
        discount: discount,
        amount: finalAmount,
        reservation,
        createdAt: Date.now()
      };
      await redisSet(orderCouponKey, JSON.stringify(snapshot), RESERVATION_TTL);
    }

    return res.status(200).json({ order_id: data.id, key_id: key, amount: finalAmount, discount, coupon: code || null });
  } catch (error) {
    console.error('Order creation error:', error);
    if (reservation) await redisDel(reservation).catch(() => {});
    if (orderCouponKey) await redisDel(orderCouponKey).catch(() => {});
    return res.status(500).json({ message: 'Unable to create payment order.' });
  }
};

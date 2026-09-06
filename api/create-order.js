const crypto = require('crypto');
const {
  BASE_AMOUNT, RESERVATION_TTL, cleanCode, getCoupon, validateCoupon,
  calculateDiscount, redisSet, redisSetNX, redisDel, reservationKey, randomId, redisGet
} = require('./coupons');
const { getUserById, ATTRIBUTION_TTL, getReferralSettings } = require('./referrals/_shared');

function getCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  const match = raw.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  let reservation = null;
  let orderCouponKey = null;
  let referralSnapshot = null;
  let referralOrderKey = null;
  try {
    const { name, email, phone, coupon, referral_attribution } = req.body || {};
    if (!name || !email || !/^\d{10}$/.test(String(phone || '')))
      return res.status(400).json({ message: 'Invalid customer details.' });

    const key = process.env.RAZORPAY_KEY_ID;
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key || !secret) return res.status(500).json({ message: 'Razorpay configuration missing.' });

    let referralAttributionId = String(referral_attribution || getCookie(req, 'prepvia_referral') || '').trim().slice(0, 100);
    if (referralAttributionId) {
      const referralSettings=await getReferralSettings();
      if(!referralSettings.enabled) { referralAttributionId=''; }
      if(referralAttributionId) {
      const rawReferral = await redisGet('referral:attr:' + referralAttributionId);
      if (rawReferral) {
        try {
          const attr = JSON.parse(rawReferral);
          const referrer = await getUserById(attr.userId);
          if (referrer && referrer.active!==false && Date.now() - Number(attr.attributedAt || 0) <= ATTRIBUTION_TTL * 1000) {
            referralSnapshot = { attributionId: referralAttributionId, userId: referrer.id, code: referrer.code, referrerEmail: referrer.email, attributedAt: Number(attr.attributedAt || Date.now()) };
          }
        } catch (_) {}
      }
      }
    }

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

    if (referralSnapshot) {
      referralOrderKey = 'referral:order:' + data.id;
      await redisSet(referralOrderKey, JSON.stringify(referralSnapshot), ATTRIBUTION_TTL);
      await fetch(process.env.KV_REST_API_URL + '/incrby/' + encodeURIComponent('referral:checkouts:' + referralSnapshot.userId) + '/1', { headers:{Authorization:'Bearer '+process.env.KV_REST_API_TOKEN} }).catch(()=>{});
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
    if (referralOrderKey) await redisDel(referralOrderKey).catch(() => {});
    return res.status(500).json({ message: 'Unable to create payment order.' });
  }
};

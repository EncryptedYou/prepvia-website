const { redisGet, getCoupon, validateCoupon, calculateDiscount, BASE_AMOUNT, cleanCode } = require('../lib/coupons');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed.' });
  try {
    const referral = cleanCode(req.query?.code);
    if (!/^[A-Z0-9_-]{3,40}$/.test(referral)) return res.status(200).json({ linked: false });

    const raw = await redisGet('referral:def:' + referral);
    if (!raw) return res.status(200).json({ linked: false });
    let definition;
    try { definition = JSON.parse(raw); } catch { return res.status(200).json({ linked: false }); }
    if (!definition.active) return res.status(200).json({ linked: false });

    // Prefer the explicitly configured linked coupon. If it is empty, also
    // support the convenient setup where referral code and coupon code are identical.
    let couponCode = cleanCode(definition.coupon);
    if (!couponCode) couponCode = referral;
    const coupon = await getCoupon(couponCode);
    const check = validateCoupon(coupon);
    if (!check.ok) return res.status(200).json({ linked: false, message: check.message });

    const calc = calculateDiscount(coupon, BASE_AMOUNT);
    return res.status(200).json({
      linked: true,
      referral_code: referral,
      coupon: coupon.code,
      type: coupon.type,
      discount: calc.discount,
      amount: calc.amount
    });
  } catch (error) {
    console.error('Referral coupon error:', error);
    return res.status(200).json({ linked: false });
  }
};

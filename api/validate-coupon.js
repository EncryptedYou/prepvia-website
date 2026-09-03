const { getCoupon, validateCoupon, calculateDiscount, BASE_AMOUNT } = require('./coupons');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ valid: false, message: 'Method not allowed' });
  try {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ valid: false, message: 'Enter a coupon code first.' });
    const coupon = await getCoupon(code);
    const check = validateCoupon(coupon);
    if (!check.ok) return res.status(400).json({ valid: false, message: check.message });
    const { discount, amount } = calculateDiscount(coupon, BASE_AMOUNT);
    return res.status(200).json({ valid: true, code: coupon.code, discount, amount });
  } catch (error) {
    console.error('Coupon validation error:', error);
    return res.status(500).json({ valid: false, message: 'Unable to check coupon right now.' });
  }
};

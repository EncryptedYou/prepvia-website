const crypto = require('crypto');
const sign = (v, s) => crypto.createHmac('sha256', s).update(v).digest('hex');
const {
  BASE_AMOUNT, getCoupon, redisGet, redisSet, redisSetNX, redisDel
} = require('./coupons');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  let processedKey = null;
  let couponUsedKey = null;

  try {
    const { name, email, phone, order_id, payment_id, signature } = req.body || {};
    const secret = process.env.RAZORPAY_KEY_SECRET;

    if (!secret || !order_id || !payment_id || !signature) {
      return res.status(400).json({ message: 'Incomplete payment data.' });
    }

    // 1. Verify Razorpay's payment signature.
    const expected = sign(order_id + '|' + payment_id, secret);
    if (
      expected.length !== signature.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    ) {
      return res.status(400).json({ message: 'Payment verification failed.' });
    }

    const key = process.env.RAZORPAY_KEY_ID;
    if (!key) return res.status(500).json({ message: 'Razorpay configuration missing.' });

    const auth = Buffer.from(key + ':' + secret).toString('base64');
    const razorpayHeaders = { Authorization: 'Basic ' + auth };

    // 2. Fetch the order directly from Razorpay.
    const orderResponse = await fetch(
      'https://api.razorpay.com/v1/orders/' + encodeURIComponent(order_id),
      { headers: razorpayHeaders }
    );

    const razorpayOrder = await orderResponse.json();
    if (!orderResponse.ok) {
      return res.status(400).json({ message: 'Unable to verify Razorpay order.' });
    }

    const orderAmount = Number(razorpayOrder.amount);
    if (!Number.isInteger(orderAmount) || orderAmount <= 0 || orderAmount > BASE_AMOUNT) {
      return res.status(400).json({ message: 'Invalid payment amount.' });
    }

    // 3. Fetch the actual payment from Razorpay and verify that it belongs
    //    to this order, has the expected amount, and is captured.
    const paymentResponse = await fetch(
      'https://api.razorpay.com/v1/payments/' + encodeURIComponent(payment_id),
      { headers: razorpayHeaders }
    );

    const razorpayPayment = await paymentResponse.json();
    if (!paymentResponse.ok) {
      return res.status(400).json({ message: 'Unable to verify Razorpay payment.' });
    }

    const paymentAmount = Number(razorpayPayment.amount);
    if (
      razorpayPayment.order_id !== order_id ||
      razorpayPayment.currency !== 'INR' ||
      paymentAmount !== orderAmount ||
      razorpayPayment.status !== 'captured'
    ) {
      return res.status(400).json({ message: 'Razorpay payment is not valid or captured.' });
    }

    const actualAmount = paymentAmount;

    // 4. Idempotency: do not process the same payment twice.
    processedKey = 'payment:processed:' + payment_id;
    if (!await redisSetNX(processedKey, '1', 31536000)) {
      return res.status(409).json({ message: 'This payment has already been processed.' });
    }

    // 5. Validate any coupon reservation created during checkout.
    const couponOrderKey = 'coupon:order:' + order_id;
    const raw = await redisGet(couponOrderKey);
    let couponSnapshot = null;

    if (raw) {
      try {
        couponSnapshot = JSON.parse(raw);
      } catch {
        throw new Error('Invalid coupon order metadata.');
      }

      const coupon = await getCoupon(couponSnapshot.coupon);
      if (!coupon) throw new Error('Coupon no longer exists.');
      if (actualAmount !== Number(couponSnapshot.amount)) {
        throw new Error('Coupon order amount mismatch.');
      }
      if (actualAmount >= BASE_AMOUNT) {
        throw new Error('Coupon order amount mismatch.');
      }

      couponUsedKey = 'coupon:used:' + couponSnapshot.coupon + ':' + payment_id;
      if (!await redisSetNX(
        couponUsedKey,
        JSON.stringify({ order_id, payment_id, amount: actualAmount, consumedAt: Date.now() }),
        31536000
      )) {
        throw new Error('This coupon payment has already been processed.');
      }

      const current = await getCoupon(couponSnapshot.coupon);
      if (!current) throw new Error('Coupon no longer exists.');
      if (Number(current.used || 0) >= Number(current.maxUses || 1)) {
        throw new Error('Coupon usage limit reached.');
      }
    } else if (actualAmount !== BASE_AMOUNT) {
      throw new Error('Unexpected payment amount.');
    }

    // 6. Keep PII on the server/webhook only. The browser token contains
    //    only non-sensitive payment metadata.
    const payload = {
      order_id,
      payment_id,
      amount: actualAmount / 100,
      currency: 'INR',
      coupon: couponSnapshot ? couponSnapshot.coupon : null,
      iat: Date.now(),
      exp: Date.now() + 600000
    };

    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = encoded + '.' + sign(encoded, secret);

    // 7. Send customer details to your server-side automation only.
    const webhook = process.env.ACTIVEPIECES_WEBHOOK_URL;
    if (webhook) {
      const wr = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'payment.verified',
          name: String(name || ''),
          email: String(email || ''),
          phone: String(phone || ''),
          product: 'JEE & NEET Success Package',
          amount: payload.amount,
          currency: 'INR',
          coupon: payload.coupon,
          order_id,
          payment_id
        })
      });

      if (!wr.ok) throw new Error('Activepieces webhook failed.');
    }

    // 8. Commit coupon usage only after all verification/webhook steps succeed.
    if (couponSnapshot) {
      const current = await getCoupon(couponSnapshot.coupon);
      if (!current) throw new Error('Coupon no longer exists.');
      if (Number(current.used || 0) >= Number(current.maxUses || 1)) {
        throw new Error('Coupon usage limit reached.');
      }

      current.used = Number(current.used || 0) + 1;
      await redisSet('coupon:def:' + couponSnapshot.coupon, JSON.stringify(current));

      if (couponSnapshot.reservation) await redisDel(couponSnapshot.reservation).catch(() => {});
      await redisDel('coupon:order:' + order_id).catch(() => {});
    }

    return res.status(200).json({ success: true, verified_token: token });
  } catch (error) {
    console.error('Payment verification error:', error);
    if (processedKey) await redisDel(processedKey).catch(() => {});
    if (couponUsedKey) await redisDel(couponUsedKey).catch(() => {});
    return res.status(500).json({ message: error.message || 'Payment verification failed.' });
  }
};

const crypto = require('crypto');

const sign = (value, secret) =>
  crypto.createHmac('sha256', secret).update(value).digest('hex');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ verified: false });
  }

  try {
    const { token } = req.body || {};
    const secret = process.env.RAZORPAY_KEY_SECRET;

    if (!token || !secret) {
      return res.status(400).json({ verified: false });
    }

    const parts = String(token).split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return res.status(400).json({ verified: false });
    }

    const expected = sign(parts[0], secret);
    const supplied = parts[1];

    if (
      expected.length !== supplied.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
    ) {
      return res.status(400).json({ verified: false });
    }

    let data;
    try {
      data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch {
      return res.status(400).json({ verified: false });
    }

    if (!data.exp || Date.now() > Number(data.exp)) {
      return res.status(400).json({ verified: false });
    }

    if (!data.payment_id || !data.order_id || data.currency !== 'INR') {
      return res.status(400).json({ verified: false });
    }

    return res.status(200).json({
      verified: true,
      amount: Number(data.amount),
      currency: data.currency,
      payment_id: data.payment_id
    });
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(400).json({ verified: false });
  }
};

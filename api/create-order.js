const Razorpay = require("razorpay");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    const order = await razorpay.orders.create({
      amount: 24900,
      currency: "INR",
      receipt: "prepvia_" + Date.now(),
      notes: { product: "JEE_NEET_SUCCESS_PACKAGE" }
    });

    return res.status(200).json({
      key_id: process.env.RAZORPAY_KEY_ID,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Unable to create payment order." });
  }
};

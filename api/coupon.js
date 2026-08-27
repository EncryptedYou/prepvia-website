export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  const { code } = req.body || {};

  if (!code || typeof code !== "string") {
    return res.status(400).json({
      success: false,
      message: "Please enter a coupon code."
    });
  }

  const coupons = [
    {
      code: process.env.COUPON_1_CODE,
      paymentUrl: process.env.COUPON_1_PAYMENT_URL,
      finalPrice: Number(process.env.COUPON_1_FINAL_PRICE),
      discountAmount: Number(process.env.COUPON_1_DISCOUNT_AMOUNT)
    },
    {
      code: process.env.COUPON_2_CODE,
      paymentUrl: process.env.COUPON_2_PAYMENT_URL,
      finalPrice: Number(process.env.COUPON_2_FINAL_PRICE),
      discountAmount: Number(process.env.COUPON_2_DISCOUNT_AMOUNT)
    }
  ];

  const enteredCode = code.trim().toUpperCase();

  const coupon = coupons.find(item =>
    item.code &&
    item.code.trim().toUpperCase() === enteredCode &&
    item.paymentUrl
  );

  if (!coupon) {
    return res.status(400).json({
      success: false,
      message: "Invalid or expired coupon code."
    });
  }

  return res.status(200).json({
    success: true,
    message: "Coupon applied successfully!",
    paymentUrl: coupon.paymentUrl,
    finalPrice: Number.isFinite(coupon.finalPrice)
      ? coupon.finalPrice
      : undefined,
    discountAmount: Number.isFinite(coupon.discountAmount)
      ? coupon.discountAmount
      : undefined
  });
}

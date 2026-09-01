const crypto = require("crypto");

const sign = (v, s) =>
  crypto.createHmac("sha256", s).update(v).digest("hex");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    const {
      name,
      email,
      phone,
      order_id,
      payment_id,
      signature
    } = req.body || {};

    const secret = process.env.RAZORPAY_KEY_SECRET;

    if (!secret || !order_id || !payment_id || !signature) {
      return res.status(400).json({
        message: "Incomplete payment data."
      });
    }

    // Verify Razorpay signature
    const expected = sign(order_id + "|" + payment_id, secret);

    if (
      expected.length !== signature.length ||
      !crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature)
      )
    ) {
      return res.status(400).json({
        message: "Payment verification failed."
      });
    }

    // ------------------------------------------------
    // DUPLICATE PAYMENT PROTECTION
    // One Razorpay payment_id = one processing
    // ------------------------------------------------

    const redisUrl = process.env.KV_REST_API_URL;
    const redisToken = process.env.KV_REST_API_TOKEN;

    if (!redisUrl || !redisToken) {
      return res.status(500).json({
        message: "Payment protection is not configured."
      });
    }

    const redisKey = "payment:processed:" + payment_id;

    const redisResponse = await fetch(
      redisUrl +
        "/set/" +
        encodeURIComponent(redisKey) +
        "/1/nx/ex/31536000",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + redisToken
        }
      }
    );

    if (!redisResponse.ok) {
      throw new Error("Redis request failed.");
    }

    const redisData = await redisResponse.json();

    // Payment was already processed
    if (redisData.result !== "OK") {
      return res.status(409).json({
        message: "This payment has already been processed."
      });
    }

    const payload = {
      order_id,
      payment_id,
      name: String(name || ""),
      email: String(email || ""),
      phone: String(phone || ""),
      amount: 249,
      currency: "INR",
      iat: Date.now(),
      exp: Date.now() + 600000
    };

    const encoded = Buffer.from(
      JSON.stringify(payload)
    ).toString("base64url");

    const token =
      encoded + "." + sign(encoded, secret);

    // Send verified payment to Activepieces
    const webhook = process.env.ACTIVEPIECES_WEBHOOK_URL;

    if (webhook) {
      const webhookResponse = await fetch(webhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          event: "payment.verified",
          name: payload.name,
          email: payload.email,
          phone: payload.phone,
          product: "JEE & NEET Success Package",
          amount: 249,
          currency: "INR",
          order_id,
          payment_id
        })
      });

      // If Activepieces fails, allow the payment
      // to be retried instead of permanently locking it.
      if (!webhookResponse.ok) {
        await fetch(
          redisUrl +
            "/del/" +
            encodeURIComponent(redisKey),
          {
            method: "GET",
            headers: {
              Authorization: "Bearer " + redisToken
            }
          }
        );

        throw new Error(
          "Activepieces webhook failed."
        );
      }
    }

    return res.status(200).json({
      success: true,
      verified_token: token
    });

  } catch (error) {

    console.error(
      "Payment verification error:",
      error
    );

    return res.status(500).json({
      message: "Payment verification failed."
    });
  }
};

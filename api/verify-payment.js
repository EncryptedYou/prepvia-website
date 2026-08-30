const crypto = require("crypto");
const Razorpay = require("razorpay");
const nodemailer = require("nodemailer");

function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function sendEmail(to, paymentId) {
  return transporter().sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: "🎉 Your Prep.via Success Package is Ready",
    text: `Hi,\n\nThank you for purchasing the Prep.via JEE & NEET Success Package.\n\nYour payment of ₹249 was successful.\n\nAccess your package:\n${process.env.PACKAGE_LINK}\n\nPayment ID: ${paymentId}\n\n— Team Prep.via`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px"><h2>🎉 Your Prep.via Success Package is Ready</h2><p>Thank you for purchasing the <b>JEE & NEET Success Package</b>.</p><p>Your payment of <b>₹249</b> was successful.</p><p><a href="${process.env.PACKAGE_LINK}" style="display:inline-block;background:#a8ff2a;color:#071006;text-decoration:none;font-weight:800;padding:13px 18px;border-radius:10px">Access Your Package →</a></p><p style="color:#666;font-size:13px">Payment ID: ${paymentId}</p><p>— Team Prep.via</p></div>`
  });
}

async function metaPurchase(email, paymentId, orderId) {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return;
  const em = crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  const url = `https://graph.facebook.com/v23.0/${encodeURIComponent(process.env.META_PIXEL_ID)}/events?access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const r = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({data:[{event_name:"Purchase",event_time:Math.floor(Date.now()/1000),action_source:"website",event_id:`purchase_${paymentId}`,user_data:{em:[em]},custom_data:{currency:"INR",value:249,order_id:orderId}}]}) });
  if (!r.ok) console.error("Meta CAPI:", await r.text());
}

async function fulfil(payment) {
  if (!payment || payment.status !== "captured" || payment.amount !== 24900 || !payment.email) throw new Error("Payment not eligible for fulfilment");
  await sendEmail(payment.email, payment.id);
  await metaPurchase(payment.email, payment.id, payment.order_id);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({error:"Missing payment verification fields."});
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature))) return res.status(400).json({error:"Invalid payment signature."});
  try {
    const razorpay = new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET});
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (payment.order_id !== razorpay_order_id) return res.status(400).json({error:"Payment/order mismatch."});
    await fulfil(payment);
    return res.status(200).json({success:true});
  } catch (error) {
    console.error(error);
    return res.status(500).json({error:"Payment verified, but fulfilment failed."});
  }
};

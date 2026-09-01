const crypto = require("crypto");
const sign = (v,s) => crypto.createHmac("sha256",s).update(v).digest("hex");

module.exports = async (req,res) => {
  if (req.method !== "POST") return res.status(405).json({message:"Method not allowed"});
  try {
    const {name,email,phone,order_id,payment_id,signature} = req.body || {};
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret || !order_id || !payment_id || !signature)
      return res.status(400).json({message:"Incomplete payment data."});

    const expected = sign(order_id + "|" + payment_id, secret);
    if (expected.length !== signature.length ||
        !crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(signature)))
      return res.status(400).json({message:"Payment verification failed."});

    const payload = {
      order_id,payment_id,name:String(name||""),email:String(email),phone:String(phone),
      amount:249,currency:"INR",iat:Date.now(),exp:Date.now()+600000
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const token = encoded + "." + sign(encoded,secret);

    const webhook = process.env.ACTIVEPIECES_WEBHOOK_URL;
    if (webhook) {
      await fetch(webhook,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          event:"payment.verified", name:payload.name, email:payload.email, phone:payload.phone,
          product:"JEE & NEET Success Package", amount:249, currency:"INR", order_id, payment_id
        })
      });
    }
    res.status(200).json({success:true,verified_token:token});
  } catch { res.status(500).json({message:"Payment verification failed."}); }
};

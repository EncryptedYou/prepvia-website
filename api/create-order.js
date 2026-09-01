const crypto = require("crypto");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({message:"Method not allowed"});
  try {
    const {name,email,phone} = req.body || {};
    if (!name || !email || !/^\d{10}$/.test(String(phone || "")))
      return res.status(400).json({message:"Invalid customer details."});

    const key = process.env.RAZORPAY_KEY_ID;
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key || !secret) return res.status(500).json({message:"Razorpay configuration missing."});

    const auth = Buffer.from(key + ":" + secret).toString("base64");
    const r = await fetch("https://api.razorpay.com/v1/orders", {
      method:"POST",
      headers:{Authorization:"Basic " + auth, "Content-Type":"application/json"},
      body:JSON.stringify({
        amount:100, currency:"INR",
        receipt:"pv_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex"),
        notes:{product:"JEE & NEET Success Package", name:String(name), email:String(email), phone:String(phone)}
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({message:data.error?.description || "Order creation failed."});
    res.status(200).json({order_id:data.id, key_id:key});
  } catch { res.status(500).json({message:"Unable to create payment order."}); }
};

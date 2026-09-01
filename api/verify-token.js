const crypto = require("crypto");
const sign = (v,s) => crypto.createHmac("sha256",s).update(v).digest("hex");

module.exports = async (req,res) => {
  if (req.method !== "POST") return res.status(405).json({verified:false});
  try {
    const {token} = req.body || {};
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!token || !secret) return res.status(400).json({verified:false});
    const p = String(token).split(".");
    if (p.length !== 2) return res.status(400).json({verified:false});
    const expected = sign(p[0],secret);
    if (expected.length !== p[1].length ||
        !crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(p[1])))
      return res.status(400).json({verified:false});
    const data = JSON.parse(Buffer.from(p[0],"base64url").toString("utf8"));
    if (!data.exp || Date.now() > data.exp) return res.status(400).json({verified:false});
    res.status(200).json({verified:true,amount:data.amount,currency:data.currency,payment_id:data.payment_id});
  } catch { res.status(400).json({verified:false}); }
};

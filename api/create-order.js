const crypto = require("crypto");

const BASE_AMOUNT = 24900; // ₹249
const COUPON_CODE = "PREPVIA50";
const COUPON_DISCOUNT = 5000; // ₹50
const COUPON_RESERVATION_TTL = 15 * 60;

async function redisGet(url, token, key) {
  const r = await fetch(url + "/get/" + encodeURIComponent(key), {headers:{Authorization:"Bearer " + token}});
  if (!r.ok) throw new Error("Redis GET failed.");
  const data = await r.json();
  return data.result ?? null;
}
async function redisSetNX(url, token, key, value, ttl) {
  const r = await fetch(url + "/set/" + encodeURIComponent(key) + "/" + encodeURIComponent(value) + "/nx/ex/" + ttl, {headers:{Authorization:"Bearer " + token}});
  if (!r.ok) throw new Error("Redis SET failed.");
  const data = await r.json();
  return data.result === "OK";
}
async function redisDel(url, token, key) {
  const r = await fetch(url + "/del/" + encodeURIComponent(key), {headers:{Authorization:"Bearer " + token}});
  if (!r.ok) throw new Error("Redis DEL failed.");
  return r.json();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({message:"Method not allowed"});
  let reservationKey = null;
  try {
    const {name,email,phone,coupon} = req.body || {};
    if (!name || !email || !/^\d{10}$/.test(String(phone || "")))
      return res.status(400).json({message:"Invalid customer details."});

    const key = process.env.RAZORPAY_KEY_ID;
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const redisUrl = process.env.KV_REST_API_URL;
    const redisToken = process.env.KV_REST_API_TOKEN;
    if (!key || !secret) return res.status(500).json({message:"Razorpay configuration missing."});
    if (!redisUrl || !redisToken) return res.status(500).json({message:"Payment protection is not configured."});

    const code = String(coupon || "").trim().toUpperCase();
    if (code && code !== COUPON_CODE) return res.status(400).json({message:"Invalid or expired coupon code."});

    let finalAmount = BASE_AMOUNT, discount = 0;
    if (code === COUPON_CODE) {
      const usedKey = "coupon:used:" + COUPON_CODE;
      reservationKey = "coupon:reservation:" + COUPON_CODE;
      if (await redisGet(redisUrl, redisToken, usedKey))
        return res.status(409).json({message:"This coupon has already been used."});
      if (!await redisSetNX(redisUrl, redisToken, reservationKey, "1", COUPON_RESERVATION_TTL)) {
        return res.status(409).json({message:"This coupon is currently reserved by another checkout. Please try again shortly."});
      }
      discount = COUPON_DISCOUNT;
      finalAmount = BASE_AMOUNT - discount;
    }

    const auth = Buffer.from(key + ":" + secret).toString("base64");
    const r = await fetch("https://api.razorpay.com/v1/orders", {
      method:"POST",
      headers:{Authorization:"Basic " + auth,"Content-Type":"application/json"},
      body:JSON.stringify({amount:finalAmount,currency:"INR",receipt:"pv_"+Date.now()+"_"+crypto.randomBytes(4).toString("hex"),notes:{product:"JEE & NEET Success Package",name:String(name),email:String(email),phone:String(phone),coupon:code||"NONE",discount_paise:String(discount)}})
    });
    const data = await r.json();
    if (!r.ok) {
      if (reservationKey) await redisDel(redisUrl, redisToken, reservationKey).catch(()=>{});
      return res.status(r.status).json({message:data.error?.description||"Order creation failed."});
    }

    if (code === COUPON_CODE) {
      await redisSetNX(redisUrl, redisToken, "coupon:order:" + data.id, JSON.stringify({coupon:COUPON_CODE,reservation:reservationKey,amount:finalAmount,discount,createdAt:Date.now()}), COUPON_RESERVATION_TTL);
    }
    return res.status(200).json({order_id:data.id,key_id:key,amount:finalAmount,discount,coupon:code||null});
  } catch (error) {
    console.error("Order creation error:",error);
    if (reservationKey) {
      const u=process.env.KV_REST_API_URL,t=process.env.KV_REST_API_TOKEN;
      if(u&&t) await redisDel(u,t,reservationKey).catch(()=>{});
    }
    return res.status(500).json({message:"Unable to create payment order."});
  }
};

const crypto = require("crypto");
const sign = (v,s) => crypto.createHmac("sha256",s).update(v).digest("hex");
const BASE_AMOUNT=24900, COUPON_CODE="PREPVIA50", COUPON_DISCOUNT=5000, COUPON_AMOUNT=19900;
async function redisGet(url,token,key){const r=await fetch(url+"/get/"+encodeURIComponent(key),{headers:{Authorization:"Bearer "+token}});if(!r.ok)throw new Error("Redis GET failed.");const d=await r.json();return d.result??null;}
async function redisSetNX(url,token,key,value,ttl){const r=await fetch(url+"/set/"+encodeURIComponent(key)+"/"+encodeURIComponent(value)+"/nx/ex/"+ttl,{headers:{Authorization:"Bearer "+token}});if(!r.ok)throw new Error("Redis SET failed.");const d=await r.json();return d.result==="OK";}
async function redisDel(url,token,key){const r=await fetch(url+"/del/"+encodeURIComponent(key),{headers:{Authorization:"Bearer "+token}});if(!r.ok)throw new Error("Redis DEL failed.");return r.json();}
module.exports=async(req,res)=>{
 if(req.method!=="POST")return res.status(405).json({message:"Method not allowed"});
 let processedKey=null;
 try{
  const {name,email,phone,order_id,payment_id,signature}=req.body||{}; const secret=process.env.RAZORPAY_KEY_SECRET;
  if(!secret||!order_id||!payment_id||!signature)return res.status(400).json({message:"Incomplete payment data."});
  const expected=sign(order_id+"|"+payment_id,secret);
  if(expected.length!==signature.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(signature)))return res.status(400).json({message:"Payment verification failed."});
  const redisUrl=process.env.KV_REST_API_URL,redisToken=process.env.KV_REST_API_TOKEN,key=process.env.RAZORPAY_KEY_ID;
  if(!redisUrl||!redisToken)return res.status(500).json({message:"Payment protection is not configured."});
  if(!key)return res.status(500).json({message:"Razorpay configuration missing."});
  const auth=Buffer.from(key+":"+secret).toString("base64");
  const orderResponse=await fetch("https://api.razorpay.com/v1/orders/"+encodeURIComponent(order_id),{headers:{Authorization:"Basic "+auth}});
  const razorpayOrder=await orderResponse.json();
  if(!orderResponse.ok)return res.status(400).json({message:"Unable to verify Razorpay order."});
  const actualAmount=Number(razorpayOrder.amount);
  if(!Number.isInteger(actualAmount)||actualAmount<=0||actualAmount>BASE_AMOUNT)return res.status(400).json({message:"Invalid payment amount."});

  processedKey="payment:processed:"+payment_id;
  if(!await redisSetNX(redisUrl,redisToken,processedKey,"1",31536000))return res.status(409).json({message:"This payment has already been processed."});

  const couponOrderKey="coupon:order:"+order_id; const raw=await redisGet(redisUrl,redisToken,couponOrderKey); let coupon=null;
  if(raw){try{coupon=JSON.parse(raw);}catch{throw new Error("Invalid coupon order metadata.");}}
  if(coupon&&coupon.coupon===COUPON_CODE){
    if(actualAmount!==COUPON_AMOUNT||Number(coupon.amount)!==COUPON_AMOUNT)throw new Error("Coupon order amount mismatch.");
    if(!await redisSetNX(redisUrl,redisToken,"coupon:used:"+COUPON_CODE,JSON.stringify({order_id,payment_id,amount:actualAmount,consumedAt:Date.now()}),31536000))throw new Error("Coupon has already been used.");
    if(coupon.reservation)await redisDel(redisUrl,redisToken,coupon.reservation).catch(()=>{});
    await redisDel(redisUrl,redisToken,couponOrderKey).catch(()=>{});
  }else if(actualAmount!==BASE_AMOUNT){throw new Error("Unexpected payment amount.");}

  const payload={order_id,payment_id,name:String(name||""),email:String(email||""),phone:String(phone||""),amount:actualAmount/100,currency:"INR",coupon:coupon?COUPON_CODE:null,iat:Date.now(),exp:Date.now()+600000};
  const encoded=Buffer.from(JSON.stringify(payload)).toString("base64url"),token=encoded+"."+sign(encoded,secret);
  const webhook=process.env.ACTIVEPIECES_WEBHOOK_URL;
  if(webhook){
   const wr=await fetch(webhook,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event:"payment.verified",name:payload.name,email:payload.email,phone:payload.phone,product:"JEE & NEET Success Package",amount:payload.amount,currency:"INR",coupon:payload.coupon,order_id,payment_id})});
   if(!wr.ok){await redisDel(redisUrl,redisToken,processedKey).catch(()=>{});if(coupon)await redisDel(redisUrl,redisToken,"coupon:used:"+COUPON_CODE).catch(()=>{});throw new Error("Activepieces webhook failed.");}
  }
  return res.status(200).json({success:true,verified_token:token});
 }catch(error){console.error("Payment verification error:",error);if(processedKey){const u=process.env.KV_REST_API_URL,t=process.env.KV_REST_API_TOKEN;if(u&&t)await redisDel(u,t,processedKey).catch(()=>{});}return res.status(500).json({message:error.message||"Payment verification failed."});}
};

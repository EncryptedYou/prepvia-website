const { BASE_AMOUNT, redisGet, redisSet, redisSetNX, redisDel, getCoupon } = require('../lib/coupons');
const { recordVerifiedPurchase } = require('../lib/analytics-store');
const adminSecret=process.env.ADMIN_SECRET;
function authorized(req){return !!adminSecret&&String(req.headers.authorization||'')==='Bearer '+adminSecret}
function cleanCode(v){return String(v||'').trim().toUpperCase().replace(/\s+/g,'')}
module.exports=async(req,res)=>{
 if(!authorized(req))return res.status(401).json({message:'Unauthorized.'});
 if(req.method!=='POST')return res.status(405).json({message:'Method not allowed.'});
 try{
  const key=process.env.RAZORPAY_KEY_ID,secret=process.env.RAZORPAY_KEY_SECRET;
  if(!key||!secret)return res.status(500).json({message:'Razorpay configuration missing.'});
  const body=req.body||{},days=Math.min(90,Math.max(1,Number(body.days)||30));
  const to=Math.floor(Date.now()/1000),from=to-days*86400;
  const auth=Buffer.from(key+':'+secret).toString('base64');
  const response=await fetch('https://api.razorpay.com/v1/payments?from='+from+'&to='+to+'&count=100',{headers:{Authorization:'Basic '+auth}});
  const data=await response.json();
  if(!response.ok)return res.status(502).json({message:data.error?.description||'Unable to read Razorpay payments.'});
  let scanned=0,recorded=0,skipped=0,errors=0;const sales=[];
  for(const payment of (data.items||[])){
   if(String(payment.status||'').toLowerCase()!=='captured')continue;
   scanned++;
   const orderId=String(payment.order_id||'');
   if(!orderId){skipped++;continue}
   try{
    const orderResponse=await fetch('https://api.razorpay.com/v1/orders/'+encodeURIComponent(orderId),{headers:{Authorization:'Basic '+auth}});
    const order=await orderResponse.json();
    if(!orderResponse.ok){errors++;continue}
    const notes=order.notes||{};
    if(String(notes.product||'')!=='JEE & NEET Success Package'){skipped++;continue}
    const amount=Number(payment.amount);
    if(!Number.isInteger(amount)||amount<=0||amount>BASE_AMOUNT||String(payment.currency||'')!=='INR'){skipped++;continue}
    let referral=null;
    const referralRaw=await redisGet('referral:order:'+orderId);
    if(referralRaw){try{referral=JSON.parse(referralRaw)}catch(_){}}
    const couponCode=cleanCode(notes.coupon||'');
    const coupon=couponCode&&couponCode!=='NONE'?await getCoupon(couponCode):null;
    await recordVerifiedPurchase({order_id:orderId,payment_id:String(payment.id),amount:amount/100,coupon:coupon?.code||null,referral_code:referral?.referral_code,session_id:referral?.session_id,visitor_id:referral?.visitor_id,referrer:referral?.referrer,utm_source:referral?.utm_source,utm_medium:referral?.utm_medium,utm_campaign:referral?.utm_campaign,device:referral?.device});
    const marker=await redisGet('analytics:purchase:recorded:'+String(payment.id));
    if(marker)recorded++;
    // If the sale used a coupon and the old verification flow failed before
    // consuming it, repair the usage count once.
    if(coupon){
      const usedKey='coupon:used:'+coupon.code+':'+payment.id;
      const first=await redisSetNX(usedKey,JSON.stringify({order_id:orderId,payment_id:payment.id,amount,consumedAt:Date.now(),reconciled:true}),31536000);
      if(first){
        const current=await getCoupon(coupon.code);
        if(current&&Number(current.used||0)<Number(current.maxUses||1)){current.used=Number(current.used||0)+1;await redisSet('coupon:def:'+coupon.code,JSON.stringify(current));}
      }
    }
    await redisDel('referral:order:'+orderId).catch(()=>{});
    sales.push({payment_id:payment.id,order_id:orderId,amount:amount/100,email:payment.email||notes.email||'',recorded:true});
   }catch(e){errors++;console.error('Reconcile sale error:',payment.id,e)}
  }
  return res.status(200).json({success:true,days,scanned,recorded,skipped,errors,sales});
 }catch(e){console.error('Sales reconciliation error:',e);return res.status(500).json({message:e.message||'Unable to reconcile sales.'})}
};

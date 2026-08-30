const crypto = require("crypto");
const nodemailer = require("nodemailer");

function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return Buffer.from(JSON.stringify(req.body || {}));
}

async function sendMeta(email, paymentId, orderId) {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return;
  const em = crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  const url = `https://graph.facebook.com/v23.0/${encodeURIComponent(process.env.META_PIXEL_ID)}/events?access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const r = await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({data:[{event_name:"Purchase",event_time:Math.floor(Date.now()/1000),action_source:"website",event_id:`purchase_${paymentId}`,user_data:{em:[em]},custom_data:{currency:"INR",value:249,order_id:orderId}}]})});
  if(!r.ok) console.error("Meta CAPI:",await r.text());
}

async function sendEmail(email, paymentId) {
  const mailer=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE).toLowerCase()==="true",auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
  await mailer.sendMail({from:process.env.MAIL_FROM,to:email,subject:"🎉 Your Prep.via Success Package is Ready",text:`Hi,\n\nThank you for purchasing the Prep.via JEE & NEET Success Package.\n\nYour payment of ₹249 was successful.\n\nAccess your package:\n${process.env.PACKAGE_LINK}\n\nPayment ID: ${paymentId}\n\n— Team Prep.via`,html:`<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px"><h2>🎉 Your Prep.via Success Package is Ready</h2><p>Thank you for purchasing the <b>JEE & NEET Success Package</b>.</p><p>Your payment of <b>₹249</b> was successful.</p><p><a href="${process.env.PACKAGE_LINK}" style="display:inline-block;background:#a8ff2a;color:#071006;text-decoration:none;font-weight:800;padding:13px 18px;border-radius:10px">Access Your Package →</a></p><p style="color:#666;font-size:13px">Payment ID: ${paymentId}</p><p>— Team Prep.via</p></div>`});
}

module.exports = async function handler(req,res){
  if(req.method!=="POST") return res.status(405).end();
  const raw=getRawBody(req);
  const sig=req.headers["x-razorpay-signature"];
  if(!sig || !process.env.RAZORPAY_WEBHOOK_SECRET) return res.status(400).end();
  const expected=crypto.createHmac("sha256",process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
  if(!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(sig))) return res.status(400).end();
  try{
    const event=JSON.parse(raw.toString("utf8"));
    if(event.event==="payment.captured"){
      const p=event.payload?.payment?.entity;
      if(p?.amount===24900 && p?.email){
        await sendEmail(p.email,p.id);
        await sendMeta(p.email,p.id,p.order_id);
      }
    }
    return res.status(200).json({received:true});
  }catch(e){console.error(e);return res.status(500).end();}
};

module.exports.config = { api: { bodyParser: false } };

const redisUrl = process.env.KV_REST_API_URL;
const redisToken = process.env.KV_REST_API_TOKEN;
const adminSecret = process.env.ADMIN_SECRET;
async function redis(command,...args){if(!redisUrl||!redisToken)throw new Error("Redis analytics is not configured.");const path=[command,...args.map(v=>encodeURIComponent(String(v)))].join("/");const r=await fetch(redisUrl.replace(/\/$/,"")+"/"+path,{headers:{Authorization:"Bearer "+redisToken}});if(!r.ok)throw new Error("Redis request failed.");return r.json()}
function authorized(req){return !!adminSecret&&String(req.headers.authorization||"")==="Bearer "+adminSecret}
function dayKey(ts){return new Date(ts).toISOString().slice(0,10)}
function sourceFromEvent(e){const explicit=String(e?.utm_source||"").trim().toLowerCase();if(explicit)return explicit.slice(0,100);try{const ref=e?.referrer?new URL(e.referrer):null;const host=ref?String(ref.hostname||"").toLowerCase().replace(/^www\./,""):"";const cur=String(e?.host||"").toLowerCase().replace(/^www\./,"");if(host&&host!==cur&&host!=="localhost")return host.slice(0,100)}catch(_){}return "direct"}
function ctaFromEvent(e){if(e?.event!=="buy_click")return "";const cta=String(e?.data?.cta||"").trim();if(["hero","purchase_card","package_preview"].includes(cta))return cta;const id=String(e?.data?.id||"").trim();return id==="heroGetSuccess"?"hero":id==="package-buy-button"?"purchase_card":id==="package-preview-buy"?"package_preview":""}
module.exports=async(req,res)=>{
 if(!authorized(req))return res.status(401).json({message:"Unauthorized"});
 if(req.method!=="POST")return res.status(405).json({message:"Method not allowed"});
 try{
  const confirm=String(req.body?.confirm||"");if(confirm!=="REBUILD_ANALYTICS_DIMENSIONS")return res.status(400).json({message:"Confirmation required. Send confirm=REBUILD_ANALYTICS_DIMENSIONS to run the one-time rebuild."});
  const raw=await redis("lrange","analytics:events","0","9999");const rows=Array.isArray(raw.result)?raw.result:[];
  const days=new Set(),pages={},sources={},devices={},ctas={},counters={};const attempts={},failures={};let parsed=0,oldest=Infinity,newest=0;
  for(const item of rows){let e;try{e=typeof item==="string"?JSON.parse(item):item}catch(_){continue}const ts=Number(e?.ts);if(!e||!Number.isFinite(ts))continue;parsed++;oldest=Math.min(oldest,ts);newest=Math.max(newest,ts);const day=dayKey(ts);days.add(day);counters[day] ||= {};
   if(e.event==="page_view"){const page=String(e.page||"/");pages[day] ||= {};pages[day][page]=(pages[day][page]||0)+1;const src=sourceFromEvent(e);sources[day] ||= {};sources[day][src]=(sources[day][src]||0)+1;const dev=String(e.device||"unknown");devices[day] ||= {};devices[day][dev]=(devices[day][dev]||0)+1;counters[day].page_view=(counters[day].page_view||0)+1}
   const cta=ctaFromEvent(e);if(cta){ctas[day] ||= {};ctas[day][cta]=(ctas[day][cta]||0)+1;counters[day].buy_click=(counters[day].buy_click||0)+1}
   const orderId=String(e?.data?.order_id||"").trim();if(orderId&&e.event==="payment_attempt")attempts[day]=(attempts[day]||0)+1;if(orderId&&e.event==="payment_failed")failures[day]=(failures[day]||0)+1;
  }
  const affected=[...days].sort();
  for(const day of affected){
   await Promise.all([redis("del","analytics:pages:"+day),redis("del","analytics:sources:"+day),redis("del","analytics:devices:"+day),redis("del","analytics:buy_ctas:"+day)]);
   const ck="analytics:counter:"+day;
   await Promise.all([redis("hdel",ck,"page_view"),redis("hdel",ck,"buy_click"),redis("hdel",ck,"payment_attempt_unique"),redis("hdel",ck,"payment_failed_unique")]);
   for(const [k,v] of Object.entries(pages[day]||{}))await redis("hincrby","analytics:pages:"+day,k,v);
   for(const [k,v] of Object.entries(sources[day]||{}))await redis("hincrby","analytics:sources:"+day,k,v);
   for(const [k,v] of Object.entries(devices[day]||{}))await redis("hincrby","analytics:devices:"+day,k,v);
   for(const [k,v] of Object.entries(ctas[day]||{}))await redis("hincrby","analytics:buy_ctas:"+day,k,v);
   if(counters[day]?.page_view)await redis("hincrby",ck,"page_view",counters[day].page_view);
   if(counters[day]?.buy_click)await redis("hincrby",ck,"buy_click",counters[day].buy_click);
   if(attempts[day])await redis("hincrby",ck,"payment_attempt_unique",attempts[day]);
   if(failures[day])await redis("hincrby",ck,"payment_failed_unique",failures[day]);
  }
  return res.status(200).json({success:true,message:"Analytics migration completed successfully.",parsed_events:parsed,affected_days:affected.length,oldest_event:Number.isFinite(oldest)?new Date(oldest).toISOString():null,newest_event:newest?new Date(newest).toISOString():null,note:"Page views, top pages, traffic sources, devices, Buy CTA totals, and unique payment attempts/failures were rebuilt from the retained raw event stream. Verified purchases and revenue were not changed."});
 }catch(error){console.error("Analytics migration error:",error);return res.status(500).json({message:error.message||"Analytics migration failed."})}
};

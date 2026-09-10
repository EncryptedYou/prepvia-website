const redisUrl=process.env.KV_REST_API_URL, redisToken=process.env.KV_REST_API_TOKEN, adminSecret=process.env.ADMIN_SECRET;
async function redis(command,...args){if(!redisUrl||!redisToken)throw new Error("Redis analytics is not configured.");const path=[command,...args.map(v=>encodeURIComponent(String(v)))].join("/");const r=await fetch(redisUrl.replace(/\/$/,"")+"/"+path,{headers:{Authorization:"Bearer "+redisToken}});if(!r.ok)throw new Error("Redis request failed.");return r.json()}
function authorized(req){return !!adminSecret&&String(req.headers.authorization||"")==="Bearer "+adminSecret}
function dayStart(ts){const d=new Date(ts);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())}
function range(req){const q=req.query||{},now=Date.now(),r=String(q.range||"30d");if(r==="custom"){const s=Date.parse(q.start||""),e=Date.parse(q.end||"");if(!Number.isFinite(s)||!Number.isFinite(e)||e<=s)throw Error("Invalid custom date range.");return{s,e}}
 const t=dayStart(now); if(r==="today")return{s:t,e:t+86400000}; if(r==="7d")return{s:t-6*86400000,e:t+86400000}; return{s:t-29*86400000,e:t+86400000}}
function code(v){return String(v||"").toUpperCase().replace(/[^A-Z0-9_-]/g,"").slice(0,40)}
function addHash(target,raw){const x=raw?.result;if(Array.isArray(x)){for(let i=0;i+1<x.length;i+=2)target[x[i]]= (target[x[i]]||0)+Number(x[i+1]||0)}else if(x&&typeof x==="object")for(const[k,v]of Object.entries(x))target[k]=(target[k]||0)+Number(v||0)}
module.exports=async(req,res)=>{
 if(!authorized(req))return res.status(401).json({message:"Unauthorized"}); if(req.method!=="GET")return res.status(405).json({message:"Method not allowed"});
 try{
  const rc=code(req.query?.code); if(!rc)return res.status(400).json({message:"Referral code is required."});
  const {s,e}=range(req), sources={},devices={},hours={}, daily=[]; let views=0,buy=0,checkout=0,attempts=0,failures=0,purchases=0,revenue=0; const visitors=new Set(),sessions=new Set();
  for(let t=dayStart(s);t<e;t+=86400000){
   const day=new Date(t).toISOString().slice(0,10),base="referral:"+rc+":"+day;
   const [counter,vs,ss,src,dev,hrs]=await Promise.all([redis("hgetall",base+":counter"),redis("smembers",base+":visitors"),redis("smembers",base+":sessions"),redis("hgetall",base+":sources"),redis("hgetall",base+":devices"),redis("hgetall",base+":hours")]);
   const c=counter.result||{}; const get=k=>Number(Array.isArray(c)?(c.indexOf(k)>=0?c[c.indexOf(k)+1]:0):c[k]||0);
   views+=get("views");buy+=get("buy_clicks");checkout+=get("checkout_views");attempts+=get("payment_attempts");failures+=get("payment_failures");purchases+=get("purchases");revenue+=get("revenue");
   (vs.result||[]).forEach(x=>visitors.add(String(x)));(ss.result||[]).forEach(x=>sessions.add(String(x)));addHash(sources,src);addHash(devices,dev);addHash(hours,hrs);
   daily.push({day,views:get("views"),buy_clicks:get("buy_clicks"),purchases:get("purchases"),revenue:get("revenue")});
  }
  return res.status(200).json({code:rc,start:s,end:e,funnel:{views,unique_users:visitors.size,sessions:sessions.size,buy_clicks:buy,checkout_views:checkout,payment_attempts:attempts,payment_failures:failures,purchases,revenue:Number(revenue.toFixed(2))},traffic_sources:Object.entries(sources).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([source,count])=>({source,count})),devices:Object.entries(devices).sort((a,b)=>b[1]-a[1]).map(([device,count])=>({device,count})),views_by_hour:Object.entries(hours).sort((a,b)=>Number(a[0])-Number(b[0])).map(([hour,count])=>({hour,count})),daily});
 }catch(e){console.error("Referral stats error:",e);return res.status(400).json({message:e.message||"Unable to load referral stats."})}
};

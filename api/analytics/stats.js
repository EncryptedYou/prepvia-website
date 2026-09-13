const redisUrl=process.env.KV_REST_API_URL, redisToken=process.env.KV_REST_API_TOKEN, adminSecret=process.env.ADMIN_SECRET;
async function redis(command,...args){if(!redisUrl||!redisToken)throw new Error('Redis analytics is not configured.');const path=[command,...args.map(v=>encodeURIComponent(String(v)))].join('/');const r=await fetch(redisUrl.replace(/\/$/, '')+'/'+path,{headers:{Authorization:'Bearer '+redisToken}});if(!r.ok)throw new Error('Redis request failed.');return r.json()}
function authorized(req){return !!adminSecret&&String(req.headers.authorization||'')==='Bearer '+adminSecret}
function dayStart(ts){const d=new Date(ts);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())}
function range(req){const q=req.query||{},now=Date.now(),r=String(q.range||'30d');if(r==='custom'){const s=Date.parse(q.start||''),e=Date.parse(q.end||'');if(!Number.isFinite(s)||!Number.isFinite(e)||e<=s)throw Error('Invalid custom date range.');return{s,e}}const t=dayStart(now);if(r==='today')return{s:t,e:t+86400000};if(r==='7d')return{s:t-6*86400000,e:t+86400000};return{s:t-29*86400000,e:t+86400000}}
function hashObject(result){const out={};if(Array.isArray(result)){for(let i=0;i+1<result.length;i+=2)out[result[i]]=Number(result[i+1]||0)}else if(result&&typeof result==='object')for(const[k,v]of Object.entries(result))out[k]=Number(v||0);return out}
function addMap(target,result){const x=hashObject(result);for(const[k,v]of Object.entries(x))target[k]=(target[k]||0)+v}
module.exports=async(req,res)=>{
 if(!authorized(req))return res.status(401).json({message:'Unauthorized.'});
 if(req.method!=='GET')return res.status(405).json({message:'Method not allowed.'});
 try{
  const {s,e}=range(req);let pageViews=0,buyClicks=0,checkoutViews=0,attempts=0,failures=0,purchases=0,revenue=0,activeUsers=0;
  const visitors=new Set(),pages={},sources={},devices={},scroll={};
  for(let t=dayStart(s);t<e;t+=86400000){
   const day=new Date(t).toISOString().slice(0,10);
   const [counter,rev,newVisitors,dayVisitors,active]=await Promise.all([redis('hgetall','analytics:counter:'+day),redis('hget','analytics:revenue:'+day,'value'),redis('smembers','analytics:new_visitors:'+day),redis('smembers','analytics:visitors:'+day),redis('zcount','analytics:active',t,Math.min(e,Date.now()))]);
   const c=hashObject(counter.result);
   pageViews+=c.page_view||0;buyClicks+=c.buy_click||0;checkoutViews+=c.checkout_view||0;
   attempts+=(c.payment_attempt_unique||0) || 0; failures+=(c.payment_failed_unique||0)||0; purchases+=c.purchase||0;
   revenue+=Number(rev.result||0); activeUsers+=Number(active.result||0);
   (newVisitors.result||[]).forEach(x=>visitors.add(String(x)));
   (dayVisitors.result||[]).forEach(x=>visitors.add(String(x)));
   const [ph,sh,dh,sc]=await Promise.all([redis('hgetall','analytics:pages:'+day),redis('hgetall','analytics:sources:'+day),redis('hgetall','analytics:devices:'+day),redis('hgetall','analytics:scroll:'+day)]);
   addMap(pages,ph.result);addMap(sources,sh.result);addMap(devices,dh.result);addMap(scroll,sc.result);
  }
  // Older deployments did not emit payment_attempt. Keep a compatibility fallback.
  if(!attempts)attempts=purchases+failures;
  return res.status(200).json({generated_at:Date.now(),start:s,end:e,active_users:activeUsers,funnel:{visitors:visitors.size,page_views:pageViews,buy_clicks:buyClicks,checkout_views:checkoutViews,payment_attempts:attempts,payment_failures:failures,purchases,revenue:Number(revenue.toFixed(2))},payment_success_rate:attempts?Number((purchases/attempts*100).toFixed(2)):0,conversion_rate:buyClicks?Number((purchases/buyClicks*100).toFixed(2)):0,top_pages:Object.entries(pages).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([page,count])=>({page,count})),traffic_sources:Object.entries(sources).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([source,count])=>({source,count})),devices:Object.entries(devices).sort((a,b)=>b[1]-a[1]).map(([device,count])=>({device,count})),scroll_depth:scroll});
 }catch(e){console.error('Analytics stats error:',e);return res.status(500).json({message:e.message||'Unable to load analytics.'})}
};

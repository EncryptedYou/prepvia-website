const { redisGet, redisSet, redisDel, getUserById, increment, setCardinality, REWARD_PAISE, ATTRIBUTION_DAYS } = require('../../lib/referrals-shared');
function auth(req){return !!process.env.ADMIN_SECRET && String(req.headers.authorization||'')==='Bearer '+process.env.ADMIN_SECRET;}
const SETTINGS_KEY='referral:settings';
async function settings(){
  let s={enabled:true,reward_paise:REWARD_PAISE,attribution_days:ATTRIBUTION_DAYS};
  const raw=await redisGet(SETTINGS_KEY); if(raw){try{s={...s,...JSON.parse(raw)}}catch{}}
  s.enabled=s.enabled!==false; s.reward_paise=Math.max(0,Number(s.reward_paise)); s.attribution_days=Math.max(1,Math.min(365,Number(s.attribution_days)||ATTRIBUTION_DAYS));
  return s;
}
module.exports=async(req,res)=>{
  if(!auth(req)) return res.status(401).json({message:'Unauthorized.'});
  try{
    if(req.method==='GET'){
      const s=await settings();
      let ids=[];
      const raw=await redisGet('referral:index');
      if(raw){try{ids=Array.isArray(JSON.parse(raw))?JSON.parse(raw):[]}catch{ids=[]}}

      // Self-heal the admin index if an older/partial registration ever failed
      // after creating the user record. Upstash Redis REST supports SCAN.
      if(!ids.length){
        try{
          const url=process.env.KV_REST_API_URL, token=process.env.KV_REST_API_TOKEN;
          if(url&&token){
            let cursor='0', guard=0, recovered=[];
            do{
              const scan=await fetch(url+'/scan/'+encodeURIComponent(cursor)+'/match/'+encodeURIComponent('referral:user:*')+'/count/1000',{headers:{Authorization:'Bearer '+token}});
              if(!scan.ok)break;
              const data=await scan.json();
              const result=data.result||['0',[]];
              cursor=String(result[0]||'0');
              for(const key of (result[1]||[])){
                const id=String(key).slice('referral:user:'.length);
                if(id&&!recovered.includes(id))recovered.push(id);
              }
              guard++;
            }while(cursor!=='0'&&guard<20);
            if(recovered.length){ids=recovered;await redisSet('referral:index',JSON.stringify(ids));}
          }
        }catch(e){console.warn('Referral index recovery skipped:',e.message)}
      }

      const out=[];
      for(const id of ids){
        const u=await getUserById(id);if(!u)continue;
        const num=async k=>Number(await redisGet(k)||0);
        out.push({
          id:u.id,name:u.name,email:u.email,code:u.code,createdAt:u.createdAt,active:u.active!==false,
          referral_url:'/?ref='+encodeURIComponent(u.code),
          clicks:await num('referral:clicks:'+id),uniqueVisitors:await setCardinality('referral:visitors:'+id),
          checkouts:await num('referral:checkouts:'+id),purchases:await num('referral:purchases:'+id),
          revenue:await num('referral:revenue:'+id),rewards:await num('referral:rewards:'+id),pendingRewards:await num('referral:pending:'+id)
        });
      }
      out.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
      return res.status(200).json({settings:{enabled:s.enabled,reward_rupees:s.reward_paise/100,attribution_days:s.attribution_days},referrers:out});
    }
    if(req.method==='PUT'){
      const b=req.body||{}; const current=await settings();
      if('enabled' in b) current.enabled=!!b.enabled;
      if('reward_rupees' in b){const n=Number(b.reward_rupees);if(!Number.isFinite(n)||n<0||n>100000)return res.status(400).json({message:'Invalid reward amount.'});current.reward_paise=Math.round(n*100);}
      if('attribution_days' in b){const n=Number(b.attribution_days);if(!Number.isInteger(n)||n<1||n>365)return res.status(400).json({message:'Attribution days must be 1–365.'});current.attribution_days=n;}
      await redisSet(SETTINGS_KEY,JSON.stringify(current));
      return res.status(200).json({success:true,settings:{enabled:current.enabled,reward_rupees:current.reward_paise/100,attribution_days:current.attribution_days}});
    }
    if(req.method==='PATCH'){
      const id=String(req.body?.id||''); const action=String(req.body?.action||''); if(!id)return res.status(400).json({message:'Referrer id required.'});
      const u=await getUserById(id); if(!u)return res.status(404).json({message:'Referrer not found.'});
      if(action==='set_active'){u.active=!!req.body.active;await redisSet('referral:user:'+id,JSON.stringify(u));return res.status(200).json({success:true,active:u.active});}
      if(action==='mark_paid'){const pending=Number(await redisGet('referral:pending:'+id)||0);if(pending>0){await redisSet('referral:payout:'+id+':'+Date.now(),JSON.stringify({amount:pending,paidAt:Date.now()}));await redisSet('referral:pending:'+id,'0');}return res.status(200).json({success:true,paid:pending});}
      if(action==='reset_stats'){for(const k of ['clicks','checkouts','purchases','revenue','rewards','pending'])await redisSet('referral:'+k+':'+id,'0');await redisDel('referral:visitors:'+id);return res.status(200).json({success:true});}
      return res.status(400).json({message:'Unknown referral action.'});
    }
    if(req.method==='DELETE'){
      const id=String(req.body?.id||''); if(!id)return res.status(400).json({message:'Referrer id required.'});
      const u=await getUserById(id);if(!u)return res.status(404).json({message:'Referrer not found.'});
      await redisDel('referral:user:'+id);await redisDel('referral:email:'+u.email);await redisDel('referral:code:'+u.code);
      const raw=await redisGet('referral:index');const ids=raw?JSON.parse(raw):[];await redisSet('referral:index',JSON.stringify(ids.filter(x=>x!==id)));
      return res.status(200).json({success:true});
    }
    return res.status(405).json({message:'Method not allowed'});
  }catch(e){console.error('Referral admin error:',e);return res.status(500).json({message:'Unable to process referral admin request.'});}
};

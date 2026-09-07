const {
  redisGet,redisSet,redisDel,getUserById,increment,setCardinality,getReferralSettings,
  DEFAULT_SETTINGS,REWARD_PAISE,ATTRIBUTION_DAYS, listRange, createNotification,
  redisSetNX, randomId
} = require('../../lib/referrals-shared');
function auth(req){return !!process.env.ADMIN_SECRET&&String(req.headers.authorization||'')==='Bearer '+process.env.ADMIN_SECRET;}
function num(v){return Number(v||0);}
function moneyPaise(v){return Math.round(num(v));}
async function settings(){return getReferralSettings();}
async function getRecord(id){const raw=await redisGet('referral:earning:'+id);if(!raw)return null;try{return JSON.parse(raw)}catch{return null}}
async function processEarning(id,action){
  const lock='referral:earning:lock:'+id;if(!await redisSetNX(lock,'1',15))return {ok:false,message:'Earning is already being processed.'};
  try{
    const rec=await getRecord(id);if(!rec)return {ok:false,message:'Earning not found.'};if(rec.status!=='pending')return {ok:true,already:true,status:rec.status};
    const amount=moneyPaise(rec.amount_paise);if(amount<=0)return {ok:false,message:'Invalid earning amount.'};
    const user=await getUserById(rec.userId);if(!user)return {ok:false,message:'Referrer not found.'};
    if(action==='approve_earning'){
      rec.status='approved';rec.approvedAt=Date.now();await redisSet('referral:earning:'+id,JSON.stringify(rec));await increment('referral:pending_paise:'+user.id,-amount);await increment('referral:available_paise:'+user.id,amount);await createNotification(user.id,'Earning approved',`₹${(amount/100).toFixed(2)} from your ${rec.source==='view'?'qualified view':'verified sale'} was approved and added to your available balance.`,'earning');
    }else if(action==='reject_earning'){
      rec.status='rejected';rec.rejectedAt=Date.now();await redisSet('referral:earning:'+id,JSON.stringify(rec));await increment('referral:pending_paise:'+user.id,-amount);await increment('referral:rewards_paise:'+user.id,-amount);await increment('referral:rejected_paise:'+user.id,amount);await increment('referral:'+rec.source+'_rewards_paise:'+user.id,-amount);await createNotification(user.id,'Earning rejected',`₹${(amount/100).toFixed(2)} from your ${rec.source==='view'?'qualified view':'verified sale'} was rejected by Prep Via.`,'earning');
    }else return {ok:false,message:'Unknown earning action.'};
    return {ok:true,status:rec.status};
  }finally{await redisDel(lock).catch(()=>{});}
}
module.exports=async(req,res)=>{
  if(!auth(req))return res.status(401).json({message:'Unauthorized.'});
  try{
    if(req.method==='GET'){
      const s=await settings();let ids=[];const raw=await redisGet('referral:index');if(raw){try{ids=Array.isArray(JSON.parse(raw))?JSON.parse(raw):[]}catch{ids=[]}}
      if(!ids.length){
        try{const url=process.env.KV_REST_API_URL,token=process.env.KV_REST_API_TOKEN;if(url&&token){let cursor='0',guard=0,recovered=[];do{const scan=await fetch(url+'/scan/'+encodeURIComponent(cursor)+'/match/'+encodeURIComponent('referral:user:*')+'/count/1000',{headers:{Authorization:'Bearer '+token}});if(!scan.ok)break;const data=await scan.json(),result=data.result||['0',[]];cursor=String(result[0]||'0');for(const key of(result[1]||[])){const id=String(key).slice('referral:user:'.length);if(id&&!recovered.includes(id))recovered.push(id)}guard++}while(cursor!=='0'&&guard<20);if(recovered.length){ids=recovered;await redisSet('referral:index',JSON.stringify(ids));}}}catch(e){console.warn('Referral index recovery skipped:',e.message)}}
      const out=[];
      for(const id of ids){const u=await getUserById(id);if(!u)continue;const n=async k=>num(await redisGet(k));const pending=await n('referral:pending_paise:'+id)+await n('referral:pending:'+id)*100;const rewards=await n('referral:rewards_paise:'+id)+await n('referral:rewards:'+id)*100;const available=await n('referral:available_paise:'+id);const paid=await n('referral:paid_paise:'+id);const viewRewards=await n('referral:view_rewards_paise:'+id);const saleRewards=await n('referral:purchase_rewards_paise:'+id);const qviews=await n('referral:qualified_views:'+id);out.push({id:u.id,name:u.name,email:u.email,code:u.code,createdAt:u.createdAt,active:u.active!==false,upi_id:u.upi_id||'',referral_url:'/?ref='+encodeURIComponent(u.code),clicks:await n('referral:clicks:'+id),uniqueVisitors:await setCardinality('referral:visitors:'+id),qualifiedViews:qviews,checkouts:await n('referral:checkouts:'+id),purchases:await n('referral:purchases:'+id),revenue:await n('referral:revenue:'+id),rewards:rewards/100,pendingRewards:pending/100,available:available/100,paid:paid/100,viewRewards:viewRewards/100,saleRewards:saleRewards/100});}
      out.sort((a,b)=>num(b.createdAt)-num(a.createdAt));
      const allIds=await listRange('referral:withdrawals:all',0,200);const withdrawals=[];for(const id of(allIds||[])){const wr=await redisGet('referral:withdrawal:'+id);if(wr){try{const x=JSON.parse(wr);if(x.status==='pending'||x.status==='approved')withdrawals.push(x)}catch{}}}
      const pendingEarnings=[];for(const u of out){const ids2=await listRange('referral:pending_earnings:'+u.id,0,100);for(const eid of(ids2||[])){const e=await getRecord(eid);if(e&&e.status==='pending'){pendingEarnings.push({...e,name:u.name,email:u.email,code:u.code})}}}
      return res.status(200).json({settings:{enabled:s.enabled,purchase_enabled:s.purchase_enabled,purchase_reward_rupees:s.purchase_reward_paise/100,view_enabled:s.view_enabled,view_start_threshold:s.view_start_threshold,view_min_seconds:s.view_min_seconds,view_min_scroll:s.view_min_scroll,view_default_reward_rupees:s.view_default_reward_paise/100,view_slabs:s.view_slabs.map(x=>({min:x.min,max:x.max,reward_rupees:x.reward_paise/100})),min_withdrawal_rupees:s.min_withdrawal_paise/100,anti_abuse_enabled:s.anti_abuse_enabled,max_ip_views_per_day:s.max_ip_views_per_day,attribution_days:s.attribution_days},referrers:out,withdrawals,pending_earnings:pendingEarnings.slice(0,200)});
    }
    if(req.method==='PUT'){
      const b=req.body||{},s=await settings();
      if('enabled' in b)s.enabled=!!b.enabled;if('purchase_enabled' in b)s.purchase_enabled=!!b.purchase_enabled;if('view_enabled' in b)s.view_enabled=!!b.view_enabled;
      if('purchase_reward_rupees' in b){const n=Number(b.purchase_reward_rupees);if(!Number.isFinite(n)||n<0||n>100000)return res.status(400).json({message:'Invalid sale reward.'});s.purchase_reward_paise=Math.round(n*100)}
      if('view_start_threshold' in b){const n=Number(b.view_start_threshold);if(!Number.isInteger(n)||n<0||n>100000000)return res.status(400).json({message:'Invalid view threshold.'});s.view_start_threshold=n}
      if('view_min_seconds' in b){const n=Number(b.view_min_seconds);if(!Number.isFinite(n)||n<0||n>86400)return res.status(400).json({message:'Invalid minimum view time.'});s.view_min_seconds=n}
      if('view_min_scroll' in b){const n=Number(b.view_min_scroll);if(!Number.isFinite(n)||n<0||n>100)return res.status(400).json({message:'Scroll must be 0–100%.'});s.view_min_scroll=n}
      if('view_default_reward_rupees' in b){const n=Number(b.view_default_reward_rupees);if(!Number.isFinite(n)||n<0||n>100000)return res.status(400).json({message:'Invalid view reward.'});s.view_default_reward_paise=Math.round(n*100)}
      if('view_slabs' in b){if(!Array.isArray(b.view_slabs)||!b.view_slabs.length)return res.status(400).json({message:'Add at least one view reward slab.'});const slabs=b.view_slabs.map(x=>({min:Math.floor(Number(x.min)),max:Math.floor(Number(x.max)),reward_paise:Math.round(Number(x.reward_rupees)*100)})).filter(x=>Number.isInteger(x.min)&&Number.isInteger(x.max)&&x.min>=0&&x.max>=x.min&&Number.isFinite(x.reward_paise)&&x.reward_paise>=0);if(!slabs.length)return res.status(400).json({message:'Invalid view reward slabs.'});s.view_slabs=slabs.sort((a,b)=>a.min-b.min)}
      if('min_withdrawal_rupees' in b){const n=Number(b.min_withdrawal_rupees);if(!Number.isFinite(n)||n<0||n>10000000)return res.status(400).json({message:'Invalid minimum withdrawal.'});s.min_withdrawal_paise=Math.round(n*100)}
      if('anti_abuse_enabled' in b)s.anti_abuse_enabled=!!b.anti_abuse_enabled;if('max_ip_views_per_day' in b){const n=Number(b.max_ip_views_per_day);if(!Number.isInteger(n)||n<1||n>1000)return res.status(400).json({message:'Invalid anti-abuse limit.'});s.max_ip_views_per_day=n}
      if('attribution_days' in b){const n=Number(b.attribution_days);if(!Number.isInteger(n)||n<1||n>365)return res.status(400).json({message:'Attribution days must be 1–365.'});s.attribution_days=n}
      await redisSet('referral:settings',JSON.stringify(s));return res.status(200).json({success:true});
    }
    if(req.method==='PATCH'){
      const b=req.body||{},id=String(b.id||''),action=String(b.action||'');
      if(action==='approve_earning'||action==='reject_earning')return res.status(200).json(await processEarning(id,action));
      if(action==='approve_all_earnings'||action==='reject_all_earnings'){
        const ids2=await listRange('referral:pending_earnings:'+id,0,1000);let done=0;for(const eid of(ids2||[])){const r=await processEarning(eid,action==='approve_all_earnings'?'approve_earning':'reject_earning');if(r.ok&&!r.already)done++}
        const legacyPending=moneyPaise(num(await redisGet('referral:pending:'+id))*100);
        if(legacyPending>0){
          if(action==='approve_all_earnings'){await redisSet('referral:pending:'+id,'0');await increment('referral:available_paise:'+id,legacyPending);await createNotification(id,'Legacy earnings approved',`₹${(legacyPending/100).toFixed(2)} of older pending earnings was approved and added to your available balance.`,'earning');}
          else {await redisSet('referral:pending:'+id,'0');await increment('referral:rewards:'+id,-legacyPending/100);await createNotification(id,'Legacy earnings rejected',`₹${(legacyPending/100).toFixed(2)} of older pending earnings was rejected by Prep Via.`,'earning');}
          done++;
        }
        return res.status(200).json({success:true,processed:done});
      }
      if(action==='approve_withdrawal'||action==='reject_withdrawal'||action==='mark_withdrawal_paid'){
        const wid=id;const raw=await redisGet('referral:withdrawal:'+wid);if(!raw)return res.status(404).json({message:'Withdrawal not found.'});let w;try{w=JSON.parse(raw)}catch{return res.status(400).json({message:'Invalid withdrawal record.'})};const u=await getUserById(w.userId);if(!u)return res.status(404).json({message:'Referrer not found.'});
        if(action==='approve_withdrawal'){if(w.status!=='pending')return res.status(400).json({message:'Withdrawal is not pending.'});w.status='approved';w.approvedAt=Date.now();await redisSet('referral:withdrawal:'+wid,JSON.stringify(w));await redisDel('referral:withdrawal:pending:'+u.id);await createNotification(u.id,'Withdrawal approved',`Your ₹${(w.amount_paise/100).toFixed(2)} withdrawal to ${w.upi_id} was approved. Prep Via will process the payment.`,'withdrawal');return res.status(200).json({success:true,status:w.status});}
        if(action==='reject_withdrawal'){if(w.status!=='pending')return res.status(400).json({message:'Withdrawal is not pending.'});w.status='rejected';w.rejectedAt=Date.now();w.rejection_reason=String(b.reason||'Withdrawal was rejected by admin.').slice(0,300);await increment('referral:available_paise:'+u.id,w.amount_paise);await redisSet('referral:withdrawal:'+wid,JSON.stringify(w));await redisDel('referral:withdrawal:pending:'+u.id);await createNotification(u.id,'Withdrawal rejected',`Your ₹${(w.amount_paise/100).toFixed(2)} withdrawal was rejected. ${w.rejection_reason}`,'withdrawal');return res.status(200).json({success:true,status:w.status});}
        if(action==='mark_withdrawal_paid'){if(w.status!=='approved')return res.status(400).json({message:'Only approved withdrawals can be marked paid.'});w.status='paid';w.paidAt=Date.now();await redisSet('referral:withdrawal:'+wid,JSON.stringify(w));await increment('referral:paid_paise:'+u.id,w.amount_paise);await createNotification(u.id,'Withdrawal paid',`₹${(w.amount_paise/100).toFixed(2)} has been marked paid to ${w.upi_id}.`,'withdrawal');return res.status(200).json({success:true,status:w.status});}
      }
      if(!id)return res.status(400).json({message:'Referrer id required.'});const u=await getUserById(id);if(!u)return res.status(404).json({message:'Referrer not found.'});
      if(action==='set_active'){u.active=!!b.active;await redisSet('referral:user:'+id,JSON.stringify(u));return res.status(200).json({success:true,active:u.active})}
      if(action==='reset_stats'){const pendingIds=await listRange('referral:pending_earnings:'+id,0,5000);for(const eid of(pendingIds||[])){const er=await getRecord(eid);if(er&&er.status==='pending'){er.status='reset';er.resetAt=Date.now();await redisSet('referral:earning:'+eid,JSON.stringify(er));}}await redisDel('referral:pending_earnings:'+id);for(const k of ['clicks','checkouts','purchases','revenue','rewards','pending','rewards_paise','pending_paise','available_paise','paid_paise','rejected_paise','qualified_views','view_rewards_paise','purchase_rewards_paise'])await redisSet('referral:'+k+':'+id,'0');await redisDel('referral:visitors:'+id);return res.status(200).json({success:true})}
      return res.status(400).json({message:'Unknown referral action.'});
    }
    if(req.method==='DELETE'){
      const id=String(req.body?.id||'');if(!id)return res.status(400).json({message:'Referrer id required.'});const u=await getUserById(id);if(!u)return res.status(404).json({message:'Referrer not found.'});await redisDel('referral:user:'+id);await redisDel('referral:email:'+u.email);await redisDel('referral:code:'+u.code);const raw=await redisGet('referral:index');const ids=raw?JSON.parse(raw):[];await redisSet('referral:index',JSON.stringify(ids.filter(x=>x!==id)));return res.status(200).json({success:true});
    }
    return res.status(405).json({message:'Method not allowed'});
  }catch(e){console.error('Referral admin error:',e);return res.status(500).json({message:e.message||'Unable to process referral admin request.'});}
};

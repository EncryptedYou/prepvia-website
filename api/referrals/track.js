const crypto = require('crypto');
const {
  cleanCode, getUserByCode, getUserById, increment, setAdd, setCardinality,
  redisGet, redisSet, redisSetNX, getReferralSettings, getViewRatePaise,
  ATTRIBUTION_DAYS, createNotification, createPendingEarning, hash, parseBody
} = require('../../lib/referrals-shared');
function cookieHeader(id,ttl){return 'prepvia_referral='+encodeURIComponent(id)+'; Max-Age='+ttl+'; Path=/; SameSite=Lax; Secure';}
function getCookie(req,name){const raw=String(req.headers.cookie||'');const m=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));return m?decodeURIComponent(m.slice(name.length+1)):'';}
function clientIp(req){return String(req.headers['x-forwarded-for']||req.headers['x-real-ip']||'').split(',')[0].trim().slice(0,100);}
function userAgent(req){return String(req.headers['user-agent']||'').slice(0,300);}
module.exports = async (req,res) => {
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  try{
    const body=parseBody(req);
    const program=await getReferralSettings();
    if(!program.enabled)return res.status(403).json({message:'Referral program is currently disabled.'});
    const code=cleanCode(body.code);
    const visitorId=String(body.visitor_id||'').slice(0,120);
    const sessionId=String(body.session_id||'').slice(0,120);
    const stage=String(body.stage||'start');
    if(!code)return res.status(400).json({message:'Referral code required.'});
    const user=await getUserByCode(code);
    if(!user)return res.status(404).json({message:'Referral code not found.'});
    if(user.active===false)return res.status(403).json({message:'This referral account is inactive.'});

    let attributionId=String(body.attribution_id||getCookie(req,'prepvia_referral')||'').trim().slice(0,100);
    if(stage==='qualify'){
      if(!attributionId)return res.status(400).json({message:'Referral attribution not found.'});
      const raw=await redisGet('referral:attr:'+attributionId);
      if(!raw)return res.status(400).json({message:'Referral attribution expired.'});
      let attr;try{attr=JSON.parse(raw)}catch{attr=null}
      if(!attr||attr.userId!==user.id)return res.status(400).json({message:'Referral attribution mismatch.'});
      const age=Date.now()-Number(attr.attributedAt||0);
      const minMs=Number(program.view_min_seconds||0)*1000;
      if(age<minMs)return res.status(200).json({success:false,qualified:false,reason:'minimum_view_time'});
      const scroll=Math.max(0,Math.min(100,Number(body.scroll||0)));
      if(scroll<Number(program.view_min_scroll||0))return res.status(200).json({success:false,qualified:false,reason:'minimum_scroll'});

      const ip=clientIp(req), ua=userAgent(req);
      const visitorKey=visitorId||hash(ip+'|'+ua);
      const rewardKey='referral:qualified:'+user.id+':'+hash(visitorKey);
      if(await redisGet(rewardKey))return res.status(200).json({success:true,qualified:true,duplicate:true});
      if(program.anti_abuse_enabled && ip){
        const day=new Date().toISOString().slice(0,10);
        const ipKey='referral:ipviews:'+user.id+':'+hash(ip)+'+'+day;
        const ipCount=await increment(ipKey,1);
        if(ipCount===1) await redisSet(ipKey,String(ipCount),172800);
        if(ipCount>Number(program.max_ip_views_per_day||20))return res.status(200).json({success:false,qualified:false,reason:'anti_abuse'});
      }
      const claimed=await redisSetNX(rewardKey,JSON.stringify({userId:user.id,visitorKey,attributionId,createdAt:Date.now()}),31536000);
      if(!claimed)return res.status(200).json({success:true,qualified:true,duplicate:true});
      await setAdd('referral:visitors:'+user.id,visitorKey);
      const unique=await setCardinality('referral:visitors:'+user.id);
      await increment('referral:qualified_views:'+user.id,1);
      let reward=0,earning=null;
      if(program.view_enabled){
        reward=user.view_reward_override_paise==null?getViewRatePaise(program,unique):Math.max(0,Math.round(Number(user.view_reward_override_paise)));
        if(unique < Number(program.view_start_threshold||0)) reward=0;
        if(reward>0){
          earning=await createPendingEarning(user.id,'view',reward,{qualified_view:unique,visitor_key:visitorKey,attribution_id:attributionId});
          await createNotification(user.id,'New view earning',`Qualified unique view #${unique} generated ₹${(reward/100).toFixed(2)} pending approval.`,'earning');
        }
      }
      return res.status(200).json({success:true,qualified:true,duplicate:false,unique_views:unique,reward_paise:reward,earning_status:earning?'pending':'not_eligible'});
    }

    attributionId=attributionId||crypto.randomBytes(12).toString('hex');
    const payload={userId:user.id,code:user.code,attributedAt:Date.now(),visitorId,sessionId};
    await redisSet('referral:attr:'+attributionId,JSON.stringify(payload),program.attribution_days*86400);
    await redisSet('referral:active:'+code,attributionId,program.attribution_days*86400);
    await increment('referral:clicks:'+user.id,1);
    res.setHeader('Set-Cookie',cookieHeader(attributionId,program.attribution_days*86400));
    return res.status(200).json({success:true,code:user.code,attribution_id:attributionId,unique_visitors:await setCardinality('referral:visitors:'+user.id),min_view_seconds:program.view_min_seconds,min_scroll:program.view_min_scroll});
  }catch(e){console.error('Referral track error:',e);return res.status(500).json({message:'Unable to track referral.'});}
};

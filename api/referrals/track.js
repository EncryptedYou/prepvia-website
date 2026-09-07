const { cleanCode, getUserByCode, increment, setAdd, setCardinality, ATTRIBUTION_TTL, redisSet, getReferralSettings } = require('../../lib/referrals-shared');
function cookieHeader(id){ return 'prepvia_referral='+encodeURIComponent(id)+'; Max-Age='+ATTRIBUTION_TTL+'; Path=/; SameSite=Lax; Secure'; }
module.exports = async (req,res) => {
  if(req.method!=='POST') return res.status(405).json({message:'Method not allowed'});
  try{
    const program=await getReferralSettings(); if(!program.enabled) return res.status(403).json({message:'Referral program is currently disabled.'});
    const code=cleanCode(req.body?.code), visitorId=String(req.body?.visitor_id||'').slice(0,100), sessionId=String(req.body?.session_id||'').slice(0,100);
    if(!code) return res.status(400).json({message:'Referral code required.'});
    const user=await getUserByCode(code);
    if(!user) return res.status(404).json({message:'Referral code not found.'});
    if(user.active===false) return res.status(403).json({message:'This referral account is inactive.'});
    const attributionId = require('crypto').randomBytes(12).toString('hex');
    const payload={userId:user.id,code:user.code,attributedAt:Date.now(),visitorId,sessionId};
    await redisSet('referral:attr:'+attributionId,JSON.stringify(payload),ATTRIBUTION_TTL);
    await redisSet('referral:active:'+code,attributionId,ATTRIBUTION_TTL);
    await increment('referral:clicks:'+user.id,1);
    if(visitorId){ await setAdd('referral:visitors:'+user.id,visitorId); }
    const unique=visitorId?await setCardinality('referral:visitors:'+user.id):0;
    await redisSet('referral:stats:'+user.id,JSON.stringify({clicksKey:'referral:clicks:'+user.id,uniqueVisitors:unique}),ATTRIBUTION_TTL);
    res.setHeader('Set-Cookie',cookieHeader(attributionId));
    return res.status(200).json({success:true,code:user.code,attribution_id:attributionId,unique_visitors:unique});
  }catch(e){console.error('Referral track error:',e);return res.status(500).json({message:'Unable to track referral.'});}
};

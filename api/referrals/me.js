const {
  getSession,getUserById,redisGet,redisSet,redisSetNX,increment,listRange,parseBody,
  getReferralSettings,getViewRatePaise,createNotification,randomId,normalizeEmail
} = require('../../lib/referrals-shared');
function validUpi(v){return /^[A-Za-z0-9._-]{2,100}@[A-Za-z0-9._-]{2,50}$/.test(String(v||'').trim());}
async function num(key){return Number(await redisGet(key)||0);}
async function loadUserData(user){
  const settings=await getReferralSettings();
  const legacyRewards=await num('referral:rewards:'+user.id)*100;
  const legacyPending=await num('referral:pending:'+user.id)*100;
  const rewardsPaise=await num('referral:rewards_paise:'+user.id)+legacyRewards;
  const pendingPaise=await num('referral:pending_paise:'+user.id)+legacyPending;
  const availablePaise=await num('referral:available_paise:'+user.id);
  const paidPaise=await num('referral:paid_paise:'+user.id);
  const rejectedPaise=await num('referral:rejected_paise:'+user.id);
  const qualified=await num('referral:qualified_views:'+user.id);
  const viewRewardsPaise=await num('referral:view_rewards_paise:'+user.id);
  const purchaseRewardsPaise=await num('referral:purchase_rewards_paise:'+user.id);
  const currentViewRewardPaise=user.view_reward_override_paise!=null?Math.max(0,Math.round(Number(user.view_reward_override_paise))):getViewRatePaise(settings,qualified);
  const purchaseRewardPaise=user.purchase_reward_override_paise!=null?Math.max(0,Math.round(Number(user.purchase_reward_override_paise))):settings.purchase_reward_paise;
  const clicks=await num('referral:clicks:'+user.id);
  const actualVisitors=await require('../../lib/referrals-shared').setCardinality('referral:visitors:'+user.id);
  const withdrawalsRaw=await listRange('referral:withdrawals:'+user.id,0,20);
  const withdrawals=[];
  for(const id of (withdrawalsRaw||[])){const raw=await redisGet('referral:withdrawal:'+id);if(raw){try{withdrawals.push(JSON.parse(raw))}catch{}}}
  const notesRaw=await listRange('referral:notifications:'+user.id,0,19);
  const notifications=(notesRaw||[]).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);
  return {settings,stats:{clicks,unique_visitors:actualVisitors,qualified_unique_views:qualified,checkouts:await num('referral:checkouts:'+user.id),purchases:await num('referral:purchases:'+user.id),revenue:await num('referral:revenue:'+user.id),rewards_paise:rewardsPaise,pending_paise:pendingPaise,available_paise:availablePaise,paid_paise:paidPaise,rejected_paise:rejectedPaise,view_rewards_paise:viewRewardsPaise,purchase_rewards_paise:purchaseRewardsPaise,current_view_reward_paise:currentViewRewardPaise,current_purchase_reward_paise:purchaseRewardPaise},withdrawals,notifications};
}
module.exports=async(req,res)=>{
  try{
    const session=await getSession(req);if(!session)return res.status(401).json({message:'Session expired. Please log in again.'});
    const user=await getUserById(session.userId);if(!user)return res.status(401).json({message:'Account not found.'});
    if(req.method==='GET'){
      const d=await loadUserData(user);const s=d.settings;
      return res.status(200).json({user:{id:user.id,name:user.name,email:user.email,code:user.code,upi_id:user.upi_id||'',purchase_reward_override_rupees:user.purchase_reward_override_paise==null?null:user.purchase_reward_override_paise/100,view_reward_override_rupees:user.view_reward_override_paise==null?null:user.view_reward_override_paise/100},stats:d.stats,settings:{enabled:s.enabled,purchase_enabled:s.purchase_enabled,view_enabled:s.view_enabled,purchase_reward_rupees:s.purchase_reward_paise/100,view_start_threshold:s.view_start_threshold,view_min_seconds:s.view_min_seconds,view_min_scroll:s.view_min_scroll,view_slabs:s.view_slabs,min_withdrawal_rupees:s.min_withdrawal_paise/100},withdrawals:d.withdrawals,notifications:d.notifications,referral_url:'/?ref='+encodeURIComponent(user.code)});
    }
    if(req.method==='PUT'){
      const body=parseBody(req); const upi=String(body.upi_id||'').trim();if(upi&&!validUpi(upi))return res.status(400).json({message:'Enter a valid UPI ID.'});
      user.upi_id=upi;user.upi_updated_at=Date.now();await redisSet('referral:user:'+user.id,JSON.stringify(user));
      await createNotification(user.id,'Payment profile updated',upi?'Your UPI ID was updated successfully.':'Your UPI ID was removed.','profile');
      return res.status(200).json({success:true,upi_id:user.upi_id||''});
    }
    if(req.method==='POST'){
      const body=parseBody(req); const action=String(body.action||'');if(action!=='withdraw')return res.status(400).json({message:'Unknown referral action.'});
      const amount=Math.round(Number(body.amount_rupees||0)*100);if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({message:'Enter a valid withdrawal amount.'});
      if(!user.upi_id||!validUpi(user.upi_id))return res.status(400).json({message:'Add a valid UPI ID before requesting withdrawal.'});
      const settings=await getReferralSettings();if(amount<settings.min_withdrawal_paise)return res.status(400).json({message:`Minimum withdrawal is ₹${settings.min_withdrawal_paise/100}.`});
      const lock='referral:withdrawal:lock:'+user.id;if(!await redisSetNX(lock,'1',15))return res.status(409).json({message:'Another withdrawal request is being processed. Please try again.'});
      try{
        const pendingId=await redisGet('referral:withdrawal:pending:'+user.id);if(pendingId)return res.status(409).json({message:'You already have a pending withdrawal request.'});
        const available=await num('referral:available_paise:'+user.id);if(amount>available)return res.status(400).json({message:'Withdrawal amount exceeds your available balance.'});
        const id=randomId();const record={id,userId:user.id,name:user.payout_name||user.name,email:user.email,upi_id:user.upi_id,amount_paise:amount,status:'pending',createdAt:Date.now()};
        await increment('referral:available_paise:'+user.id,-amount);await redisSet('referral:withdrawal:'+id,JSON.stringify(record));await require('../../lib/referrals-shared').pushList('referral:withdrawals:'+user.id,id);await require('../../lib/referrals-shared').pushList('referral:withdrawals:all',id);await redisSet('referral:withdrawal:pending:'+user.id,id,30*24*60*60);
        await createNotification(user.id,'Withdrawal request submitted',`Your ₹${(amount/100).toFixed(2)} withdrawal request is pending admin review.`,'withdrawal');
        return res.status(201).json({success:true,withdrawal:record});
      }finally{await require('../../lib/referrals-shared').redisDel(lock).catch(()=>{});}
    }
    return res.status(405).json({message:'Method not allowed'});
  }catch(e){console.error('Referral me error:',e);return res.status(500).json({message:e.message||'Unable to process referral account.'});}
};

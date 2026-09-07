const { getSession, getUserById, redisGet, setCardinality } = require('../../lib/referrals-shared');
module.exports = async (req,res)=>{
  if(req.method!=='GET') return res.status(405).json({message:'Method not allowed'});
  try{
    const session=await getSession(req); if(!session) return res.status(401).json({message:'Session expired. Please log in again.'});
    const user=await getUserById(session.userId); if(!user) return res.status(401).json({message:'Account not found.'});
    const getNum=async key=>Number(await redisGet(key)||0);
    const clicks=await getNum('referral:clicks:'+user.id);
    const visitors=await setCardinality('referral:visitors:'+user.id);
    const checkouts=await getNum('referral:checkouts:'+user.id);
    const purchases=await getNum('referral:purchases:'+user.id);
    const revenue=await getNum('referral:revenue:'+user.id);
    const rewards=await getNum('referral:rewards:'+user.id);
    const pending=await getNum('referral:pending:'+user.id);
    return res.status(200).json({user:{id:user.id,name:user.name,email:user.email,code:user.code},stats:{clicks,unique_visitors:visitors,checkouts,purchases,revenue,rewards,pending_rewards:pending},reward_per_purchase:Number(process.env.REFERRAL_REWARD_PAISE||5000)/100,attribution_days:Number(process.env.REFERRAL_ATTRIBUTION_DAYS||30),referral_url:'/?ref='+encodeURIComponent(user.code)});
  }catch(e){console.error('Referral me error:',e);return res.status(500).json({message:'Unable to load referral stats.'});}
};

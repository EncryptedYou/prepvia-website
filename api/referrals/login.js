const { safeUser, normalizeEmail, verifyPassword, getUserByEmail, createSession } = require('./_shared');
module.exports = async (req,res) => {
  if(req.method!=='POST') return res.status(405).json({message:'Method not allowed'});
  try{
    const email=normalizeEmail(req.body?.email), password=String(req.body?.password||'');
    const user=await getUserByEmail(email);
    if(!user || !verifyPassword(password,user)) return res.status(401).json({message:'Invalid email or password.'});
    const token=await createSession(user);
    return res.status(200).json({user:safeUser(user),token,referral_url:'/?ref='+encodeURIComponent(user.code)});
  }catch(e){console.error('Referral login error:',e);return res.status(500).json({message:'Unable to log in.'});}
};

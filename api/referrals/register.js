const crypto = require('crypto');
const { redisGet, redisSet, randomId } = require('../coupons');
const { normalizeEmail, hashPassword, makeCode, safeUser, createSession, getUserByEmail } = require('./_shared');

module.exports = async (req,res) => {
  if (req.method !== 'POST') return res.status(405).json({message:'Method not allowed'});
  try {
    const {name,email,password} = req.body || {};
    const cleanName = String(name||'').trim();
    const cleanEmail = normalizeEmail(email);
    if (cleanName.length < 2 || cleanName.length > 80) return res.status(400).json({message:'Enter a valid name.'});
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({message:'Enter a valid email.'});
    if (String(password||'').length < 8) return res.status(400).json({message:'Password must be at least 8 characters.'});
    if (await getUserByEmail(cleanEmail)) return res.status(409).json({message:'An account with this email already exists. Please log in.'});
    let code, existing;
    do { code=makeCode(); existing=await redisGet('referral:code:'+code); } while(existing);
    const id = randomId();
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {id,name:cleanName,email:cleanEmail,code, salt,passwordHash:hashPassword(password,salt),createdAt:Date.now(),active:true,clicks:0,uniqueVisitors:0,checkouts:0,purchases:0,revenue:0,rewards:0,pendingRewards:0};
    await redisSet('referral:user:'+id,JSON.stringify(user));
    await redisSet('referral:email:'+cleanEmail,id);
    await redisSet('referral:code:'+code,id);
    const raw = await redisGet('referral:index'); const index = raw ? JSON.parse(raw) : []; index.push(id); await redisSet('referral:index',JSON.stringify(index));
    const session = await createSession(user);
    return res.status(201).json({user:safeUser(user),token:session,referral_url:'/\?ref='+encodeURIComponent(code)});
  } catch(e) { console.error('Referral register error:',e); return res.status(500).json({message:'Unable to create referral account.'}); }
};

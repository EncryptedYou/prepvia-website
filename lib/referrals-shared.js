const crypto = require('crypto');
const { redisGet, redisSet, redisSetNX, redisDel, randomId, cleanCode } = require('./coupons');

const REWARD_PAISE = Math.max(0, Number(process.env.REFERRAL_REWARD_PAISE || 5000));
const ATTRIBUTION_DAYS = Math.max(1, Number(process.env.REFERRAL_ATTRIBUTION_DAYS || 30));
const SESSION_TTL = 30 * 24 * 60 * 60;
const SETTINGS_KEY = 'referral:settings';

const DEFAULT_SETTINGS = {
  enabled:true,
  purchase_enabled:true,
  purchase_reward_paise:REWARD_PAISE,
  view_enabled:false,
  view_start_threshold:50,
  view_min_seconds:5,
  view_min_scroll:20,
  view_default_reward_paise:100,
  view_slabs:[
    {min:50,max:99,reward_paise:100},
    {min:100,max:249,reward_paise:125},
    {min:250,max:499,reward_paise:150},
    {min:500,max:999999999,reward_paise:200}
  ],
  min_withdrawal_paise:50000,
  anti_abuse_enabled:true,
  max_ip_views_per_day:20,
  attribution_days:ATTRIBUTION_DAYS
};

function sanitizeSlabs(input, fallback=DEFAULT_SETTINGS.view_slabs){
  if(!Array.isArray(input)) return fallback;
  const out=input.map(x=>({min:Math.max(0,Math.floor(Number(x.min))),max:Math.max(0,Math.floor(Number(x.max))),reward_paise:Math.max(0,Math.round(Number(x.reward_paise)))}))
    .filter(x=>Number.isFinite(x.min)&&Number.isFinite(x.max)&&x.max>=x.min&&Number.isFinite(x.reward_paise))
    .sort((a,b)=>a.min-b.min);
  return out.length?out:fallback;
}
async function getReferralSettings(){
  let s={...DEFAULT_SETTINGS};
  const raw=await redisGet(SETTINGS_KEY); if(raw){try{s={...s,...JSON.parse(raw)}}catch{}}
  s.enabled=s.enabled!==false;
  s.purchase_enabled=s.purchase_enabled!==false;
  s.purchase_reward_paise=Math.max(0,Number(s.purchase_reward_paise ?? s.reward_paise ?? REWARD_PAISE));
  s.view_enabled=s.view_enabled===true;
  s.view_start_threshold=Math.max(0,Math.floor(Number(s.view_start_threshold ?? 50)));
  s.view_min_seconds=Math.max(0,Math.min(86400,Number(s.view_min_seconds ?? 5)));
  s.view_min_scroll=Math.max(0,Math.min(100,Number(s.view_min_scroll ?? 20)));
  s.view_default_reward_paise=Math.max(0,Math.round(Number(s.view_default_reward_paise ?? 100)));
  s.view_slabs=sanitizeSlabs(s.view_slabs,DEFAULT_SETTINGS.view_slabs);
  s.min_withdrawal_paise=Math.max(0,Math.round(Number(s.min_withdrawal_paise ?? 50000)));
  s.anti_abuse_enabled=s.anti_abuse_enabled!==false;
  s.max_ip_views_per_day=Math.max(1,Math.min(1000,Math.floor(Number(s.max_ip_views_per_day ?? 20))));
  s.attribution_days=Math.max(1,Math.min(365,Math.floor(Number(s.attribution_days)||ATTRIBUTION_DAYS)));
  return s;
}
function getViewRatePaise(settings, qualifiedCount){
  const count=Number(qualifiedCount||0);
  if(count < Number(settings.view_start_threshold||0)) return 0;
  const slabs=sanitizeSlabs(settings.view_slabs,[]);
  let rate=Number(settings.view_default_reward_paise||0);
  for(const s of slabs){if(count>=s.min && count<=s.max) rate=s.reward_paise;}
  return Math.max(0,Math.round(rate));
}
function normalizeEmail(v) { return String(v || '').trim().toLowerCase(); }
function hash(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function hashPassword(password, salt) { return crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32).toString('hex'); }
function verifyPassword(password, record) { try { const got=Buffer.from(hashPassword(password,record.salt),'hex'), expected=Buffer.from(record.passwordHash,'hex'); return got.length===expected.length&&crypto.timingSafeEqual(got,expected); } catch (_) { return false; } }
function makeCode() { return 'PV' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function safeUser(user) { return {id:user.id,name:user.name,email:user.email,code:user.code,createdAt:user.createdAt,upi_id:user.upi_id||''}; }
function bearer(req) { const raw=String(req.headers.authorization||''); return raw.startsWith('Bearer ')?raw.slice(7).trim():''; }
async function getSession(req) { const token=bearer(req); if(!token)return null; const raw=await redisGet('referral:session:'+hash(token)); if(!raw)return null; try{return JSON.parse(raw)}catch(_){return null} }
async function getUserById(id) { const raw=await redisGet('referral:user:'+id); if(!raw)return null; try{return JSON.parse(raw)}catch(_){return null} }
async function getUserByCode(code) { const normalized=cleanCode(code); if(!normalized)return null; const id=await redisGet('referral:code:'+normalized); return id?getUserById(id):null; }
async function getUserByEmail(email) { const id=await redisGet('referral:email:'+normalizeEmail(email)); return id?getUserById(id):null; }
async function increment(key,amount=1){const url=process.env.KV_REST_API_URL,token=process.env.KV_REST_API_TOKEN;if(!url||!token)throw new Error('Referral tracking is not configured.');const r=await fetch(url+'/incrby/'+encodeURIComponent(key)+'/'+encodeURIComponent(amount),{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw new Error('Redis request failed.');return(await r.json()).result;}
async function setAdd(key,member){const url=process.env.KV_REST_API_URL,token=process.env.KV_REST_API_TOKEN;if(!url||!token)throw new Error('Referral tracking is not configured.');const r=await fetch(url+'/sadd/'+encodeURIComponent(key)+'/'+encodeURIComponent(member),{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw new Error('Redis request failed.');return(await r.json()).result;}
async function setCardinality(key){const url=process.env.KV_REST_API_URL,token=process.env.KV_REST_API_TOKEN;if(!url||!token)throw new Error('Referral tracking is not configured.');const r=await fetch(url+'/scard/'+encodeURIComponent(key),{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw new Error('Redis request failed.');return Number((await r.json()).result||0);}
async function redisCommand(path,options={}){const url=process.env.KV_REST_API_URL,token=process.env.KV_REST_API_TOKEN;if(!url||!token)throw new Error('Redis is not configured.');const r=await fetch(url+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(options.headers||{})}});if(!r.ok)throw new Error('Redis request failed.');return(await r.json()).result;}
async function pushList(key,value){return redisCommand('/lpush/'+encodeURIComponent(key)+'/'+encodeURIComponent(value));}
async function listRange(key,start=0,end=100){return redisCommand('/lrange/'+encodeURIComponent(key)+'/'+start+'/'+end);}
async function createNotification(userId,title,message,type='info'){const n={id:randomId(),title:String(title),message:String(message),type,createdAt:Date.now(),read:false};await pushList('referral:notifications:'+userId,JSON.stringify(n));await redisCommand('/ltrim/'+encodeURIComponent('referral:notifications:'+userId)+'/0/49').catch(()=>{});return n;}
async function createPendingEarning(userId,source,amount,meta){if(Number(amount)<=0)return null;const id=randomId();const record={id,userId,source,amount_paise:Math.round(Number(amount)),status:'pending',createdAt:Date.now(),meta:meta||{}};await redisSet('referral:earning:'+id,JSON.stringify(record));await pushList('referral:pending_earnings:'+userId,id);await increment('referral:rewards_paise:'+userId,record.amount_paise);await increment('referral:pending_paise:'+userId,record.amount_paise);await increment('referral:'+source+'_rewards_paise:'+userId,record.amount_paise);return record;}
async function createSession(user){const token=randomId()+randomId()+randomId();const ok=await redisSet('referral:session:'+hash(token),JSON.stringify({userId:user.id,createdAt:Date.now()}),SESSION_TTL);if(!ok)throw new Error('Unable to create a secure referral session.');return token;}
function parseBody(req){if(req&&req.body&&typeof req.body==='object')return req.body;if(req&&typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}return {}}
module.exports={REWARD_PAISE,DEFAULT_SETTINGS,getReferralSettings,getViewRatePaise,ATTRIBUTION_DAYS,SESSION_TTL,normalizeEmail,hash,hashPassword,verifyPassword,makeCode,safeUser,bearer,getSession,getUserById,getUserByCode,getUserByEmail,increment,setAdd,setCardinality,redisCommand,pushList,listRange,createNotification,createPendingEarning,createSession,parseBody,redisGet,redisSet,redisSetNX,redisDel,randomId,cleanCode};

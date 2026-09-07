const crypto = require('crypto');
const { redisGet, redisSet, redisSetNX, redisDel, randomId, cleanCode } = require('./coupons');

const REWARD_PAISE = Math.max(0, Number(process.env.REFERRAL_REWARD_PAISE || 5000));
const ATTRIBUTION_DAYS = Math.max(1, Number(process.env.REFERRAL_ATTRIBUTION_DAYS || 30));
const SESSION_TTL = 30 * 24 * 60 * 60;
const ATTRIBUTION_TTL = ATTRIBUTION_DAYS * 24 * 60 * 60;
const SETTINGS_KEY = 'referral:settings';
async function getReferralSettings(){ let s={enabled:true,reward_paise:REWARD_PAISE,attribution_days:ATTRIBUTION_DAYS}; const raw=await redisGet(SETTINGS_KEY); if(raw){try{s={...s,...JSON.parse(raw)}}catch{}} return {enabled:s.enabled!==false,reward_paise:Math.max(0,Number(s.reward_paise)),attribution_days:Math.max(1,Number(s.attribution_days)||ATTRIBUTION_DAYS)}; }

function normalizeEmail(v) { return String(v || '').trim().toLowerCase(); }
function hash(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32).toString('hex');
}
function verifyPassword(password, record) {
  try {
    const got = Buffer.from(hashPassword(password, record.salt), 'hex');
    const expected = Buffer.from(record.passwordHash, 'hex');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch (_) { return false; }
}
function makeCode() { return 'PV' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function safeUser(user) {
  return { id:user.id, name:user.name, email:user.email, code:user.code, createdAt:user.createdAt };
}
function bearer(req) {
  const raw = String(req.headers.authorization || '');
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
}
async function getSession(req) {
  const token = bearer(req);
  if (!token) return null;
  const raw = await redisGet('referral:session:' + hash(token));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
async function getUserById(id) {
  const raw = await redisGet('referral:user:' + id);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
async function getUserByCode(code) {
  const normalized = cleanCode(code);
  if (!normalized) return null;
  const id = await redisGet('referral:code:' + normalized);
  return id ? getUserById(id) : null;
}
async function getUserByEmail(email) {
  const id = await redisGet('referral:email:' + normalizeEmail(email));
  return id ? getUserById(id) : null;
}
async function increment(key, amount = 1) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Referral tracking is not configured.');
  const r = await fetch(url + '/incrby/' + encodeURIComponent(key) + '/' + encodeURIComponent(amount), { headers:{Authorization:'Bearer '+token} });
  if (!r.ok) throw new Error('Redis request failed.');
  return (await r.json()).result;
}
async function setAdd(key, member) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Referral tracking is not configured.');
  const r = await fetch(url + '/sadd/' + encodeURIComponent(key) + '/' + encodeURIComponent(member), { headers:{Authorization:'Bearer '+token} });
  if (!r.ok) throw new Error('Redis request failed.');
  return (await r.json()).result;
}
async function setCardinality(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Referral tracking is not configured.');
  const r = await fetch(url + '/scard/' + encodeURIComponent(key), { headers:{Authorization:'Bearer '+token} });
  if (!r.ok) throw new Error('Redis request failed.');
  return Number((await r.json()).result || 0);
}
async function createSession(user) {
  const token = randomId() + randomId();
  await redisSet('referral:session:' + hash(token), JSON.stringify({ userId:user.id, createdAt:Date.now() }), SESSION_TTL);
  return token;
}
module.exports = { REWARD_PAISE, getReferralSettings, ATTRIBUTION_DAYS, ATTRIBUTION_TTL, SESSION_TTL, normalizeEmail, hash, hashPassword, verifyPassword, makeCode, safeUser, bearer, getSession, getUserById, getUserByCode, getUserByEmail, increment, setAdd, setCardinality, createSession, redisGet, redisSet, redisSetNX, redisDel, randomId, cleanCode };

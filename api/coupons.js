const crypto = require('crypto');

const BASE_AMOUNT = 24900;
const DEFAULT_CODE = 'PREPVIA50';
const DEFAULT_DISCOUNT = 5000;
const RESERVATION_TTL = 30 * 60;

function cleanCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function redisBase() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Payment protection is not configured.');
  return { url, token };
}

async function redisRequest(path, options = {}) {
  const { url, token } = redisBase();
  const r = await fetch(url + path, { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('Redis request failed.');
  return r.json();
}

async function redisGet(key) {
  const data = await redisRequest('/get/' + encodeURIComponent(key));
  return data.result ?? null;
}

async function redisSet(key, value, ttl) {
  const path = '/set/' + encodeURIComponent(key) + '/' + encodeURIComponent(value) + (ttl ? '/ex/' + ttl : '');
  const data = await redisRequest(path);
  return data.result === 'OK';
}

async function redisSetNX(key, value, ttl) {
  const path = '/set/' + encodeURIComponent(key) + '/' + encodeURIComponent(value) + '/nx/ex/' + ttl;
  const data = await redisRequest(path);
  return data.result === 'OK';
}

async function redisDel(key) {
  return redisRequest('/del/' + encodeURIComponent(key));
}

async function getCoupon(code) {
  const normalized = cleanCode(code);
  if (!normalized) return null;
  const raw = await redisGet('coupon:def:' + normalized);
  if (raw) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  // Preserve the existing coupon after upgrading to the admin-managed system.
  if (normalized === DEFAULT_CODE) {
    return {
      code: DEFAULT_CODE,
      type: 'fixed',
      discount: DEFAULT_DISCOUNT,
      maxUses: 1,
      used: (await redisGet('coupon:legacy-used:' + DEFAULT_CODE)) ? 1 : 0,
      active: true,
      expiresAt: null,
      createdAt: 0
    };
  }
  return null;
}

function validateCoupon(coupon) {
  if (!coupon || !coupon.active) return { ok: false, message: 'Invalid or inactive coupon code.' };
  if (coupon.expiresAt && Date.now() > Number(coupon.expiresAt)) return { ok: false, message: 'This coupon has expired.' };
  if (Number(coupon.used || 0) >= Number(coupon.maxUses || 1)) return { ok: false, message: 'This coupon has already reached its usage limit.' };
  return { ok: true };
}

function calculateDiscount(coupon, baseAmount = BASE_AMOUNT) {
  let discount = Number(coupon.discount || 0);
  if (coupon.type === 'percent') discount = Math.floor(baseAmount * discount / 100);
  discount = Math.max(0, Math.min(baseAmount - 100, discount));
  return { discount, amount: baseAmount - discount };
}

function reservationKey(code) {
  return 'coupon:reservation:' + code;
}

function randomId() {
  return crypto.randomBytes(12).toString('hex');
}

module.exports = {
  BASE_AMOUNT, DEFAULT_CODE, DEFAULT_DISCOUNT, RESERVATION_TTL,
  cleanCode, redisGet, redisSet, redisSetNX, redisDel,
  getCoupon, validateCoupon, calculateDiscount, reservationKey, randomId
};

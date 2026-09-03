const { cleanCode, getCoupon, redisGet, redisSet, redisDel } = require('./coupons');

function authorized(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  return String(req.headers.authorization || '') === 'Bearer ' + secret;
}

async function listCoupons() {
  const indexRaw = await redisGet('coupon:index');
  const codes = indexRaw ? JSON.parse(indexRaw) : [];
  const out = [];
  for (const code of codes) {
    const coupon = await getCoupon(code);
    if (coupon) out.push(coupon);
  }
  return out;
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ message: 'Unauthorized.' });
  try {
    if (req.method === 'GET') return res.status(200).json({ coupons: await listCoupons() });

    if (req.method === 'POST') {
      const body = req.body || {};
      const code = cleanCode(body.code);
      const type = body.type === 'percent' ? 'percent' : 'fixed';
      const discount = Number(body.discount);
      const maxUses = Number(body.maxUses);
      const expiresAt = body.expiresAt ? new Date(body.expiresAt).getTime() : null;
      if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return res.status(400).json({ message: 'Coupon code must be 3–40 letters/numbers, _ or -.' });
      if (!Number.isFinite(discount) || discount <= 0 || (type === 'percent' && discount >= 100)) return res.status(400).json({ message: 'Invalid discount.' });
      if (!Number.isInteger(maxUses) || maxUses < 1) return res.status(400).json({ message: 'Usage limit must be at least 1.' });
      if (expiresAt && expiresAt <= Date.now()) return res.status(400).json({ message: 'Expiry must be in the future.' });
      if (await redisGet('coupon:def:' + code)) return res.status(409).json({ message: 'Coupon already exists.' });
      const coupon = { code, type, discount, maxUses, used: 0, active: true, expiresAt, createdAt: Date.now() };
      await redisSet('coupon:def:' + code, JSON.stringify(coupon));
      const index = await listCodes();
      if (!index.includes(code)) { index.push(code); await redisSet('coupon:index', JSON.stringify(index)); }
      return res.status(201).json({ coupon });
    }

    if (req.method === 'PATCH') {
      const code = cleanCode(req.body?.code);
      const coupon = await getCoupon(code);
      if (!coupon) return res.status(404).json({ message: 'Coupon not found.' });
      if (typeof req.body.active === 'boolean') coupon.active = req.body.active;
      if (req.body.expiresAt !== undefined) coupon.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt).getTime() : null;
      if (req.body.maxUses !== undefined) {
        const maxUses = Number(req.body.maxUses);
        if (!Number.isInteger(maxUses) || maxUses < Number(coupon.used || 0)) return res.status(400).json({ message: 'Invalid usage limit.' });
        coupon.maxUses = maxUses;
      }
      await redisSet('coupon:def:' + code, JSON.stringify(coupon));
      return res.status(200).json({ coupon });
    }

    if (req.method === 'DELETE') {
      const code = cleanCode(req.body?.code);
      if (!code) return res.status(400).json({ message: 'Coupon code is required.' });
      await redisDel('coupon:def:' + code);
      await redisDel('coupon:reservation:' + code).catch(() => {});
      await redisDel('coupon:legacy-used:' + code).catch(() => {});
      const index = await listCodes();
      await redisSet('coupon:index', JSON.stringify(index.filter(x => x !== code)));
      return res.status(200).json({ success: true });
    }
    return res.status(405).json({ message: 'Method not allowed' });
  } catch (error) {
    console.error('Admin coupon error:', error);
    return res.status(500).json({ message: 'Unable to manage coupons.' });
  }
};

async function listCodes() {
  const raw = await redisGet('coupon:index');
  return raw ? JSON.parse(raw) : [];
}

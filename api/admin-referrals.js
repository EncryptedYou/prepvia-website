const crypto = require("crypto");

const redisUrl = process.env.KV_REST_API_URL;
const redisToken = process.env.KV_REST_API_TOKEN;
const adminSecret = process.env.ADMIN_SECRET;

async function redis(command, ...args) {
  if (!redisUrl || !redisToken) throw new Error("Redis is not configured.");
  const path = [command, ...args.map(v => encodeURIComponent(String(v)))].join("/");
  const r = await fetch(redisUrl.replace(/\/$/, "") + "/" + path, {
    headers: { Authorization: "Bearer " + redisToken }
  });
  if (!r.ok) throw new Error("Redis request failed.");
  return r.json();
}
function authorized(req) {
  return !!adminSecret && String(req.headers.authorization || "") === "Bearer " + adminSecret;
}
function cleanCode(v) { return String(v || "").trim().toUpperCase().replace(/\s+/g, ""); }
function safeCode(v) { return /^[A-Z0-9_-]{3,40}$/.test(cleanCode(v)); }
function randomCode() {
  return "PV" + crypto.randomBytes(5).toString("base64").replace(/[^A-Z0-9]/gi,"").toUpperCase().slice(0,8);
}
async function get(code) {
  const r = await redis("get", "referral:def:" + cleanCode(code));
  if (!r.result) return null;
  try { return JSON.parse(r.result); } catch { return null; }
}
async function list() {
  const r = await redis("get", "referral:index");
  const codes = r.result ? JSON.parse(r.result) : [];
  const out = [];
  for (const c of codes) { const x = await get(c); if (x) out.push(x); }
  return out;
}
async function saveIndex(codes) {
  await redis("set", "referral:index", JSON.stringify(codes));
}
module.exports = async (req,res) => {
  if (!authorized(req)) return res.status(401).json({message:"Unauthorized"});
  try {
    if (req.method === "GET") {
      const settingsRaw = await redis("get", "prepvia:attribution:days");
      const n = Number(settingsRaw.result || 30);
      return res.status(200).json({referrals: await list(), attribution_days: Number.isFinite(n) ? Math.min(3650, Math.max(1, Math.floor(n))) : 30});
    }
    const body = req.body || {};
    if (req.method === "POST" && body.action === "attribution_settings") {
      const days = Number(body.days);
      if (!Number.isInteger(days) || days < 1 || days > 3650)
        return res.status(400).json({message:"Attribution window must be between 1 and 3650 days."});
      await redis("set", "prepvia:attribution:days", String(days));
      return res.status(200).json({success:true, attribution_days:days});
    }
    const code = cleanCode(body.code);
    if (req.method === "POST") {
      let finalCode = code;
      if (!finalCode) {
        for (let i=0;i<5;i++) {
          const candidate=randomCode();
          if (!(await get(candidate))) { finalCode=candidate; break; }
        }
      }
      if (!safeCode(finalCode)) return res.status(400).json({message:"Referral code must be 3–40 letters/numbers, _ or -."});
      if (await get(finalCode)) return res.status(409).json({message:"Referral code already exists."});
      const landing = String(body.landingPath || "/").trim();
      const landingPath = /^\/(?!\/)[^\s]*$/.test(landing) ? landing.slice(0,200) : "/";
      const item = {
        code: finalCode,
        promoter: String(body.promoter || "").trim().slice(0,100),
        contact: String(body.contact || "").trim().slice(0,160),
        platform: String(body.platform || "").trim().slice(0,60),
        campaign: String(body.campaign || "").trim().slice(0,120),
        coupon: cleanCode(body.coupon),
        landingPath,
        active: true,
        createdAt: Date.now()
      };
      await redis("set","referral:def:"+finalCode,JSON.stringify(item));
      const indexRaw=await redis("get","referral:index");
      const index=indexRaw.result?JSON.parse(indexRaw.result):[];
      index.push(finalCode); await saveIndex(index);
      return res.status(201).json({referral:item});
    }
    if (req.method === "PATCH") {
      if (!safeCode(code)) return res.status(400).json({message:"Valid referral code is required."});
      const item=await get(code); if(!item)return res.status(404).json({message:"Referral link not found."});
      if(typeof body.active==="boolean")item.active=body.active;
      if(body.promoter!==undefined)item.promoter=String(body.promoter).trim().slice(0,100);
      if(body.contact!==undefined)item.contact=String(body.contact).trim().slice(0,160);
      if(body.platform!==undefined)item.platform=String(body.platform).trim().slice(0,60);
      if(body.campaign!==undefined)item.campaign=String(body.campaign).trim().slice(0,120);
      if(body.coupon!==undefined)item.coupon=cleanCode(body.coupon);
      await redis("set","referral:def:"+code,JSON.stringify(item));
      return res.status(200).json({referral:item});
    }
    if (req.method === "DELETE") {
      if(!safeCode(code))return res.status(400).json({message:"Valid referral code is required."});
      await redis("del","referral:def:"+code);
      const r=await redis("get","referral:index"); const index=r.result?JSON.parse(r.result):[];
      await saveIndex(index.filter(x=>x!==code));
      return res.status(200).json({success:true});
    }
    return res.status(405).json({message:"Method not allowed"});
  } catch(e) {
    console.error("Admin referral error:",e);
    return res.status(500).json({message:e.message||"Unable to manage referrals."});
  }
};

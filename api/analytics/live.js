const redisUrl = process.env.KV_REST_API_URL;
const redisToken = process.env.KV_REST_API_TOKEN;
const adminSecret = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD;

async function redis(command, ...args) {
  if (!redisUrl || !redisToken) throw new Error("Redis analytics is not configured.");
  const path = [command, ...args.map(v => encodeURIComponent(String(v)))].join("/");
  const r = await fetch(redisUrl.replace(/\/$/,"") + "/" + path, {
    headers:{Authorization:"Bearer " + redisToken}
  });
  if (!r.ok) throw new Error("Redis request failed.");
  return r.json();
}

module.exports = async (req,res) => {
  if (req.method !== "GET") return res.status(405).json({message:"Method not allowed"});
  if ((req.headers.authorization || "") !== "Bearer " + adminSecret)
    return res.status(401).json({message:"Unauthorized"});

  try {
    const cutoff = Date.now() - 90 * 1000;
    await redis("zremrangebyscore","analytics:active","-inf",cutoff);
    const r = await redis("zcard","analytics:active");
    return res.status(200).json({active_users:Number(r.result || 0), generated_at:Date.now()});
  } catch (_) {
    return res.status(500).json({message:"Unable to load live analytics."});
  }
};

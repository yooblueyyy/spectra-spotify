// Admin API: read and replace the config. Requires the ADMIN_TOKEN environment variable.
import { readConfig, writeConfig, normalize, checkAdmin, hasStorage } from "./_store.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 16) {
    return res.status(503).json({ error: "ADMIN_TOKEN isn't set (or is shorter than 16 characters) in Vercel → Settings → Environment Variables." });
  }
  if (!checkAdmin(req)) {
    // Slow down guessing.
    await new Promise((r) => setTimeout(r, 600));
    return res.status(401).json({ error: "Wrong admin token" });
  }
  try {
    if (req.method === "GET") {
      return res.status(200).json({ config: normalize(await readConfig()), storage: hasStorage() });
    }
    if (req.method === "PUT") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const saved = await writeConfig(body && body.config);
      return res.status(200).json({ ok: true, config: saved });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || "Failed" });
  }
}

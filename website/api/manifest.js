// Public config read by every Spectra install and by the website.
import { readConfig, normalize } from "./_store.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ error: "Method not allowed" });
  try {
    const config = normalize(await readConfig());
    // Edge-cached for 30 s, so edits reach every install within about half a minute.
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=300");
    return res.status(200).json(config);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "Config unavailable" });
  }
}

// Tiny per-guild JSON store (data/<guildId>.json): channel/role ids from setup, warnings.
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DIR, { recursive: true });
const cache = new Map();

export function load(guildId) {
  if (cache.has(guildId)) return cache.get(guildId);
  let data = { channels: {}, roles: {}, warnings: {}, messages: {} };
  try { data = Object.assign(data, JSON.parse(fs.readFileSync(path.join(DIR, `${guildId}.json`), "utf8"))); } catch {}
  cache.set(guildId, data);
  return data;
}

export function save(guildId) {
  const data = load(guildId);
  const file = path.join(DIR, `${guildId}.json`);
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2));
  fs.renameSync(file + ".tmp", file);
}

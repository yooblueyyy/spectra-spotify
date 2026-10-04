#!/usr/bin/env node
/**
 * Builds discord-bot-hosting/: the Discord bot, ready to upload to bot-hosting.net
 * (or any Pterodactyl Node.js host), plus spectra-bot-hosting.zip of the same files.
 *
 *   node tools/package-bot.mjs
 *
 * The host runs `npm install` and then index.js. The bot token is never copied:
 * .env is written with the token left blank, to be filled in on the host.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "discord-bot");
const OUT = path.join(ROOT, "discord-bot-hosting");
const ZIP = path.join(ROOT, "spectra-bot-hosting.zip");

const copy = (from, to) => fs.cpSync(path.join(SRC, from), path.join(OUT, to || from), { recursive: true });

// Start clean every time, but keep the folder's git history (it's pushed to a private GitHub repo).
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f !== ".git") fs.rmSync(path.join(OUT, f), { recursive: true, force: true });

copy("src");
copy("assets");
copy("package-lock.json");
// Server setup from /setupserver and the site-feed state. Shipped as data-seed/ and copied into data/
// on first start, so data/ (which the bot keeps writing) never clashes with git updates.
if (fs.existsSync(path.join(SRC, "data"))) copy("data", "data-seed");
fs.writeFileSync(path.join(OUT, ".gitignore"), "node_modules/\n.env\ndata/\n");

// package.json: same dependencies, index.js as the entry point.
const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8"));
pkg.main = "index.js";
pkg.scripts = { start: "node index.js", deploy: "node src/deploy-commands.js" };
pkg.engines = { node: ">=20.12" };
fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

// One file to run: register the slash commands, then start the bot.
fs.writeFileSync(path.join(OUT, "index.js"), `// Spectra Discord bot, for bot-hosting.net (Pterodactyl) or any Node.js host.
// The host runs \`npm install\`, then this file. It registers the slash commands, then starts the bot.
import fs from "node:fs";

try { process.loadEnvFile(); } catch {}

// First start: bring in the server setup (channels, roles, posted changelogs) from data-seed/.
if (fs.existsSync("data-seed")) {
  fs.mkdirSync("data", { recursive: true });
  for (const f of fs.readdirSync("data-seed")) if (!fs.existsSync("data/" + f)) fs.copyFileSync("data-seed/" + f, "data/" + f);
}

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is empty. Open .env in the file manager and paste your bot token after DISCORD_TOKEN=");
  process.exit(1);
}

if (process.env.CLIENT_ID && process.env.GUILD_ID) {
  try {
    await import("./src/deploy-commands.js");
  } catch (e) {
    console.warn("Couldn't register slash commands (the bot still starts):", e.message);
  }
}

await import("./src/index.js");
`);

// .env with everything except the token. Ids come from the local .env when it exists.
const local = {};
try {
  for (const line of fs.readFileSync(path.join(SRC, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m) local[m[1]] = m[2].trim();
  }
} catch {}
const envText = [
  "# Paste your bot token after DISCORD_TOKEN= (Developer Portal → your app → Bot → Reset Token).",
  "# Keep this file private: anyone with the token controls the bot.",
  "DISCORD_TOKEN=",
  "",
  "# Application ID (Developer Portal → General Information)",
  `CLIENT_ID=${local.CLIENT_ID || ""}`,
  "",
  "# Your server's ID",
  `GUILD_ID=${local.GUILD_ID || ""}`,
  ...(local.MEMBER_ROLE_ID ? ["", "# Role given to everyone who joins", `MEMBER_ROLE_ID=${local.MEMBER_ROLE_ID}`] : []),
  "",
].join("\n");
fs.writeFileSync(path.join(OUT, ".env"), envText);          // for the zip; ignored by git
fs.writeFileSync(path.join(OUT, ".env.example"), envText);  // committed: copy it to .env on the host

fs.writeFileSync(path.join(OUT, "README.md"), `# Spectra bot for bot-hosting.net

1. On bot-hosting.net, create a **Node.js** server. In **Startup**, pick Node.js **20 or newer** (22 is best)
   and leave the main file as \`index.js\`.
2. Open **Files**, upload \`spectra-bot-hosting.zip\`, then right-click it → **Unarchive**.
   The files (index.js, package.json, src/, …) must end up at the top level, not inside a sub-folder.
3. Open \`.env\` in the file manager and paste your bot token after \`DISCORD_TOKEN=\`. Save.
4. Go to **Console** and press **Start**. The first start installs the packages (a minute or so), then shows
   \`Registered … commands\` and \`Logged in as …\`.
5. Stop the bot on your own PC (close the "Spectra bot" window). Two copies running with the same token
   would post everything twice.

\`data-seed/\` holds the server setup from /setupserver and which changelog/announcement posts were already
made. On first start it's copied into \`data/\`, which the bot then keeps up to date. Keep \`data/\` on the host
when you update the bot.

## From GitHub instead of the zip
This folder is also a private GitHub repo. If your host can pull from Git, point it at the repo (private repos
need a GitHub access token), then on the host copy \`.env.example\` to \`.env\` and paste the bot token.
\`.env\` and \`data/\` are never committed.

## Updating
Run \`node tools/package-bot.mjs\` on your PC, then either upload the new zip and unarchive it over the old
files (re-paste the token in \`.env\`), or commit and push the folder and pull on the host.
`);

// Zip for upload (Windows tar.exe or zip).
fs.rmSync(ZIP, { force: true });
const files = fs.readdirSync(OUT).filter((f) => f !== ".git");
try {
  if (process.platform === "win32") execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", ZIP, ...files], { cwd: OUT });
  else execFileSync("zip", ["-r", "-q", ZIP, ...files], { cwd: OUT });
  console.log(`bot ✓ discord-bot-hosting/ and ${path.basename(ZIP)}`);
} catch (e) {
  console.log(`bot ✓ discord-bot-hosting/ (couldn't make the zip: ${e.message})`);
}

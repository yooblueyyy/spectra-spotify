// Registers the slash commands with Discord. Run once, and again after changing commands.
import { REST, Routes } from "discord.js";
import { commands } from "./commands/index.js";

try { process.loadEnvFile(); } catch {}
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Fill in DISCORD_TOKEN, CLIENT_ID and GUILD_ID in .env first (copy .env.example).");
  process.exit(1);
}

const rest = new REST().setToken(DISCORD_TOKEN);
const body = commands.map((c) => c.data.toJSON());
// Guild commands show up instantly (global ones can take up to an hour).
await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
console.log(`Registered ${body.length} commands: ${body.map((c) => "/" + c.name).join(", ")}`);

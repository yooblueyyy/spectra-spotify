// Shared moderation helpers: hierarchy checks and the mod-log.
import { EmbedBuilder } from "discord.js";
import { load } from "./store.js";

const COLORS = { ban: 0xe5484d, kick: 0xf76b15, timeout: 0xffb224, warn: 0xffd23f, unban: 0x30a46c, untimeout: 0x30a46c, purge: 0x8b5cf6, lock: 0x6e56cf, unlock: 0x30a46c, slowmode: 0x0091ff, clearwarnings: 0x30a46c };

/** Can `actor` (and the bot) act on `target`? Returns an error string or null. */
export function checkHierarchy(interaction, target) {
  const { guild, member: actor } = interaction;
  if (!target) return "That user isn't in this server.";
  if (target.id === actor.id) return "You can't do that to yourself.";
  if (target.id === guild.ownerId) return "You can't moderate the server owner.";
  if (target.id === interaction.client.user.id) return "Nice try.";
  if (actor.id !== guild.ownerId && target.roles.highest.position >= actor.roles.highest.position) return "They have the same or a higher role than you.";
  const me = guild.members.me;
  if (target.roles.highest.position >= me.roles.highest.position) return "Their role is above mine. Move my role higher in Server Settings → Roles.";
  return null;
}

/** Post to the mod-log channel set up by /setupserver (silently skipped if missing). */
export async function modLog(guild, { action, moderator, target, reason, extra }) {
  const id = load(guild.id).channels.modLog;
  const channel = id && (guild.channels.cache.get(id) || (await guild.channels.fetch(id).catch(() => null)));
  if (!channel) return;
  const e = new EmbedBuilder()
    .setColor(COLORS[action] ?? 0x99aab5)
    .setAuthor({ name: action.toUpperCase() })
    .addFields(
      ...(target ? [{ name: "User", value: `${target} (${target.id ?? target})`, inline: true }] : []),
      { name: "By", value: `${moderator}`, inline: true },
      ...(extra ? Object.entries(extra).map(([name, value]) => ({ name, value: String(value), inline: true })) : []),
      { name: "Reason", value: reason || "No reason given" },
    )
    .setTimestamp();
  await channel.send({ embeds: [e] }).catch(() => {});
}

export const reasonOf = (interaction) => (interaction.options.getString("reason") || "No reason given").slice(0, 500);

export function parseDuration(s) {
  const m = String(s || "").trim().match(/^(\d+)\s*(s|m|h|d|w)?$/i);
  if (!m) return null;
  const n = +m[1];
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[(m[2] || "m").toLowerCase()];
  return n * mult;
}

export function humanDuration(ms) {
  const units = [["week", 6048e5], ["day", 864e5], ["hour", 36e5], ["minute", 6e4], ["second", 1e3]];
  for (const [name, size] of units) if (ms >= size && ms % size === 0) { const n = ms / size; return `${n} ${name}${n === 1 ? "" : "s"}`; }
  return `${Math.round(ms / 1000)} seconds`;
}

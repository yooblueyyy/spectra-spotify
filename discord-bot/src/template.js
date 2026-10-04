// The Spectra server layout used by /setupserver. Edit names, colours and text here.
import { ChannelType, PermissionFlagsBits as P } from "discord.js";

export const SITE = "https://usespectra.xyz";
// Spectra's icon: violet → teal.
export const ACCENT = 0x8b5cf6;
export const ACCENT_2 = 0x22d3a6;

// Where the website's announcements and changelog get posted (channel IDs).
export const FEED = {
  announcementsChannelId: "1556097461615984711",
  changelogChannelId: "1556097462601650276",
};

export const SERVER = {
  name: "Spectra",
  icon: "assets/icon.png",
  description: "Themes and extensions for Spotify.",
};

// Top to bottom. "Member" is given automatically when someone joins; "Bots" to every bot.
// legacy: older names, so re-running setup renames those roles instead of making new ones.
export const ROLES = [
  { key: "owner", name: "👑 Owner", color: 0xffd23f, hoist: true, permissions: [P.Administrator], assign: "owner" },
  { key: "admin", name: "🛡️ Admin", legacy: ["Admin"], color: 0x8b5cf6, hoist: true, permissions: [P.Administrator] },
  {
    key: "mod", name: "🔨 Moderator", legacy: ["Moderator"], color: 0x6d7cf6, hoist: true,
    permissions: [P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages, P.ManageThreads, P.ManageNicknames, P.ViewAuditLog, P.MuteMembers, P.MoveMembers, P.DeafenMembers],
  },
  { key: "support", name: "🛟 Support", legacy: ["Support"], color: 0x22d3a6, hoist: true, permissions: [P.ManageMessages, P.ManageThreads, P.ModerateMembers] },
  { key: "creator", name: "🎨 Theme Creator", legacy: ["Theme Creator"], color: 0xf472b6, hoist: true, permissions: [], mentionable: false },
  { key: "bots", name: "🤖 Bots", color: 0x5865f2, hoist: true, permissions: [], assign: "bots" },
  { key: "member", name: "🎧 Member", legacy: ["Member"], color: 0xb4a7f5, hoist: false, permissions: [], assign: "members" },
  { key: "pingAnnouncements", name: "📢 Announcements", color: 0, permissions: [], mentionable: true, selfAssign: true, description: "Big news and releases" },
  { key: "pingUpdates", name: "🔔 Updates", color: 0, permissions: [], mentionable: true, selfAssign: true, description: "New versions and fixes" },
  { key: "pingThemes", name: "🎨 New Themes", color: 0, permissions: [], mentionable: true, selfAssign: true, description: "Featured themes and showcases" },
];

// Permission presets for channels. `everyone` = @everyone; others are ROLES keys.
const VIEW = [P.ViewChannel, P.ReadMessageHistory];
const TALK = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AddReactions, P.AttachFiles, P.EmbedLinks, P.UseApplicationCommands, P.CreatePublicThreads, P.SendMessagesInThreads];
const STAFF = ["owner", "admin", "mod", "support"];

/** Read-only for everyone (staff can post). */
const readOnly = { everyone: { allow: VIEW, deny: [P.SendMessages, P.CreatePublicThreads, P.AddReactions] }, ...Object.fromEntries(["owner", "admin", "mod"].map((k) => [k, { allow: [P.SendMessages, P.AddReactions] }])) };
/** Members only (everyone gets Member automatically on join). */
const membersOnly = { everyone: { deny: [P.ViewChannel] }, member: { allow: TALK }, ...Object.fromEntries(STAFF.map((k) => [k, { allow: TALK }])) };
/** Staff only. */
const staffOnly = { everyone: { deny: [P.ViewChannel] }, ...Object.fromEntries(STAFF.map((k) => [k, { allow: TALK }])) };

export const CATEGORIES = [
  {
    name: "📌 START HERE",
    perms: readOnly,
    channels: [
      { key: "welcome", name: "👋・welcome", topic: "Say hi to new members!" },
      { key: "rules", name: "📜・rules", topic: "The server rules. Please read them." },
      { key: "announcements", name: "📢・announcements", topic: "Releases and important news." },
      { key: "changelog", name: "📝・changelog", topic: "What changed in each version." },
      { key: "downloads", name: "⬇️・downloads", topic: `Get Spectra: ${SITE}/download` },
      { key: "roles", name: "🏷️・roles", topic: "Pick which pings you want." },
      { key: "boosts", name: "🚀・boosts", topic: "Thank you to everyone who boosts the server! 💜" },
    ],
  },
  {
    name: "💬 COMMUNITY",
    perms: membersOnly,
    channels: [
      { key: "general", name: "💬・general", topic: "Talk about anything (keep it friendly)." },
      { key: "showcase", name: "🖼️・showcase", topic: "Show off your Spotify setup. Screenshots welcome.", slowmode: 30 },
      { key: "themes", name: "🎨・themes", topic: "Theme recommendations, tweaks and colour schemes." },
      { key: "extensions", name: "🧩・extensions", topic: "Extensions: what works, what you use, what you made." },
      { key: "music", name: "🎵・music", topic: "Share what you're listening to." },
      { key: "commands", name: "🤖・bot-commands", topic: "Use bot commands here." },
    ],
  },
  {
    name: "🛟 SUPPORT",
    perms: membersOnly,
    channels: [
      { key: "help", name: "❓・help", topic: "Stuck? Say which platform (Chrome, Firefox, Windows, Mac, Linux, Quest) and what you tried." },
      { key: "bugs", name: "🐛・bug-reports", topic: "Something broken? Steps to reproduce + screenshots, please." },
      { key: "suggestions", name: "💡・suggestions", topic: "Ideas for Spectra. One idea per message so people can react." },
    ],
  },
  {
    name: "🔊 VOICE",
    perms: membersOnly,
    channels: [
      { key: "lounge", name: "🔊 Lounge", type: ChannelType.GuildVoice },
      { key: "party", name: "🎧 Listening Party", type: ChannelType.GuildVoice },
      { key: "afk", name: "💤 AFK", type: ChannelType.GuildVoice },
    ],
  },
  {
    name: "🛡️ STAFF",
    perms: staffOnly,
    channels: [
      { key: "staffChat", name: "🛡️・staff-chat", topic: "Staff discussion." },
      { key: "modLog", name: "📋・mod-log", topic: "Every moderation action, logged by the bot.", perms: { ...staffOnly, ...Object.fromEntries(STAFF.map((k) => [k, { allow: VIEW, deny: [P.SendMessages] }])) } },
      { key: "reports", name: "🧾・reports", topic: "User reports and follow-ups." },
      { key: "adminOnly", name: "🔧・admin-only", topic: "Admins only.", perms: { everyone: { deny: [P.ViewChannel] }, owner: { allow: TALK }, admin: { allow: TALK } } },
    ],
  },
];

export const RULES = [
  ["Be decent", "No harassment, hate speech, slurs or personal attacks. Disagree with ideas, not people."],
  ["Keep it safe for work", "No NSFW, gore or shock content, including in avatars and names."],
  ["No spam or self-promo", "No ads, invite links or repeated messages. Sharing your own themes in #showcase is fine."],
  ["No piracy or cracked Spotify", "Spectra is for themes and extensions. Don't share ad-blocking mods, cracked APKs or account-sharing."],
  ["Use the right channel", "Help goes in #help, bugs in #bug-reports, ideas in #suggestions."],
  ["Don't DM staff for support", "Ask in #help so everyone benefits from the answer."],
  ["Follow Discord's rules", "Discord's Terms of Service and Community Guidelines apply here too."],
  ["Staff have the final say", "If a moderator asks you to stop, stop. Appeal calmly in DMs to an Admin."],
];

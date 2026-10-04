// Mirrors the website's announcement and changelog (from /api/manifest) into Discord.
// Checks every minute; posts new items, edits posts whose content changed on the site.
import crypto from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { ACCENT, FEED, SITE } from "../template.js";
import { load, save } from "./store.js";
import { downloadsMessage } from "./downloads.js";

const hash = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex");

async function getChannel(client, id) {
  return client.channels.cache.get(id) || (await client.channels.fetch(id).catch(() => null));
}

function announcementMessage(a, roleId) {
  const e = new EmbedBuilder()
    .setColor(a.level === "warning" ? 0xffb224 : ACCENT)
    .setTitle(a.level === "warning" ? "⚠️ Heads up" : "📢 Announcement")
    .setDescription(a.text)
    .setFooter({ text: "usespectra.xyz" })
    .setTimestamp();
  const buttons = [new ButtonBuilder().setLabel("Open Spectra").setStyle(ButtonStyle.Link).setURL(SITE)];
  if (a.link) buttons.unshift(new ButtonBuilder().setLabel("Details").setStyle(ButtonStyle.Link).setURL(a.link));
  return {
    content: roleId ? `<@&${roleId}>` : undefined,
    embeds: [e],
    components: [new ActionRowBuilder().addComponents(buttons)],
    allowedMentions: { roles: roleId ? [roleId] : [] },
  };
}

// "+ added", "- removed", "* changed" (as written on the website's admin page). Discord would
// turn a leading - or * into its own bullet, so the marker goes in a code span with a colour dot.
const MARKS = { "+": "🟢 `+`", "-": "🔴 `-`", "*": "🟣 `*`" };
function noteLine(n) {
  const m = String(n).match(/^\s*([+\-*])\s+(.*)$/);
  return m ? `${MARKS[m[1]]} ${m[2]}` : `• ${n}`;
}

function changelogMessage(entry, roleId) {
  const e = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`📝 What's new: ${entry.version}`)
    .setDescription((entry.notes || []).map(noteLine).join("\n") || "Small fixes and improvements.")
    .setFooter({ text: `${entry.date ? `Released ${entry.date} · ` : ""}+ new  - removed  * changed` });
  return {
    content: roleId ? `<@&${roleId}>` : undefined,
    embeds: [e],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Download").setStyle(ButtonStyle.Link).setURL(`${SITE}/download`))],
    allowedMentions: { roles: roleId ? [roleId] : [] },
  };
}

/** Post a new message, or edit the one we already posted if its content changed. */
async function sync(channel, record, key, digest, build) {
  if (record[key] && record[key].hash === digest) return false;
  const existing = record[key] && (await channel.messages.fetch(record[key].messageId).catch(() => null));
  if (existing) {
    const { content, ...rest } = build(); // don't re-ping on edits
    await existing.edit(rest);
  } else {
    const msg = await channel.send(build());
    record[key] = { messageId: msg.id };
  }
  record[key].hash = digest;
  return true;
}

async function check(client) {
  const guildId = process.env.GUILD_ID;
  if (!guildId) return;
  const store = load(guildId);
  const feed = (store.feed = store.feed || { announcements: {}, changelog: {}, seeded: false });

  // Same backend on every address; the old one is a fallback while new DNS settles.
  let m = null;
  for (const base of [SITE, "https://spectra.yooblueyyy.com"]) {
    m = await fetch(`${base}/api/manifest`, { signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (m) break;
  }
  if (!m) return;

  // First run: remember what's already on the site without posting it (no flood of old entries).
  if (!feed.seeded) {
    for (const e of m.changelog || []) feed.changelog[e.version] = { messageId: null, hash: hash(e) };
    feed.seeded = true;
    save(guildId);
    console.log(`Site feed: tracking ${Object.keys(feed.changelog).length} existing changelog entries; new ones will be posted.`);
  }

  const announceChannel = await getChannel(client, FEED.announcementsChannelId);
  if (announceChannel && m.announcement && m.announcement.text) {
    const a = m.announcement;
    if (await sync(announceChannel, feed.announcements, a.id, hash(a), () => announcementMessage(a, store.roles.pingAnnouncements))) {
      console.log(`Site feed: posted announcement ${a.id}`);
      save(guildId);
    }
  }

  // Keep the #downloads post's versions in step with the website.
  const dl = downloadsMessage(m);
  const dlHash = hash(dl.embeds[0].toJSON().fields);
  if (store.messages && store.messages.downloads && store.channels && store.channels.downloads && feed.downloadsHash !== dlHash) {
    const ch = await getChannel(client, store.channels.downloads);
    const msg = ch && (await ch.messages.fetch(store.messages.downloads).catch(() => null));
    if (msg) {
      await msg.edit(dl);
      feed.downloadsHash = dlHash;
      save(guildId);
      console.log("Site feed: updated the downloads post");
    }
  }

  const changelogChannel = await getChannel(client, FEED.changelogChannelId);
  if (changelogChannel) {
    // Oldest first, so several new entries land in the right order.
    for (const entry of [...(m.changelog || [])].reverse()) {
      if (!entry.version) continue;
      const known = feed.changelog[entry.version];
      // Entries that were already on the site when the feed started are never posted, even if edited later.
      if (known && !known.messageId) { known.hash = hash(entry); continue; }
      if (await sync(changelogChannel, feed.changelog, entry.version, hash(entry), () => changelogMessage(entry, store.roles.pingUpdates))) {
        console.log(`Site feed: posted changelog ${entry.version}`);
        save(guildId);
      }
    }
  }
}

export function startSiteFeed(client) {
  const run = () => check(client).catch((e) => console.warn("Site feed:", e.message));
  run();
  setInterval(run, 60_000);
}

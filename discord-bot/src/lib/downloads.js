// The "Get Spectra" post in #downloads. Versions come live from the website.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { ACCENT, SITE } from "../template.js";

const PLATFORMS = [
  // [download page key, button label, field title, which version]
  ["chrome", "Chrome / Edge", "🌐 Chrome / Edge", "extension"],
  ["firefox", "Firefox", "🦊 Firefox", "extension"],
  ["windows", "Windows", "🪟 Windows", "desktop"],
  ["mac", "macOS", "🍎 macOS 12+", "desktop"],
  ["linux", "Linux", "🐧 Linux", "desktop"],
  ["quest", "Meta Quest", "🥽 Meta Quest", "quest"],
];

/** @param {object|null} m  the website's /api/manifest */
export function downloadsMessage(m) {
  const latest = (m && m.latest) || {};
  const e = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle("⬇️ Get Spectra")
    .setURL(`${SITE}/download`)
    .setDescription("Themes, colour schemes and extensions for Spotify. Pick where you listen:")
    .addFields(PLATFORMS.map(([, , title, v]) => ({ name: title, value: `Version ${latest[v] || "?"}`, inline: true })))
    .setFooter({ text: "Mac: Apple silicon and Intel · Linux: AppImage and .deb · Install guides on the download page." });
  const button = ([p, label]) => new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(`${SITE}/download?p=${p}`).setLabel(label);
  // Discord allows 5 buttons per row: browsers + Quest on one, desktop apps on the other.
  const rows = [
    new ActionRowBuilder().addComponents(PLATFORMS.filter(([, , , v]) => v !== "desktop").map(button)),
    new ActionRowBuilder().addComponents(PLATFORMS.filter(([, , , v]) => v === "desktop").map(button)),
  ];
  return { embeds: [e], components: rows };
}

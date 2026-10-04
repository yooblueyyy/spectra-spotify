// Spectra bot: slash commands, auto-roles, welcome cards and boost thank-yous.
import fs from "node:fs";
import path from "node:path";
import { ActivityType, AttachmentBuilder, Client, EmbedBuilder, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { commands } from "./commands/index.js";
import { ROLES, SERVER } from "./template.js";
import { load } from "./lib/store.js";
import { welcomeCard } from "./lib/welcome-card.js";
import { startSiteFeed } from "./lib/site-feed.js";

try { process.loadEnvFile(); } catch {}
if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// GuildMembers is a privileged intent: turn on "Server Members Intent" in the
// Developer Portal → Bot. It's needed for auto-roles, welcome cards and boosts.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const byName = new Map(commands.map((c) => [c.data.name, c]));
const ICON = path.join(process.cwd(), SERVER.icon);

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s).`);
  c.user.setPresence({ activities: [{ name: "Spotify themes · usespectra.xyz", type: ActivityType.Watching }], status: "online" });

  // Give the bot and its application the Spectra logo. The application icon is what
  // Discord shows next to "Spectra" on people's profiles (Rich Presence).
  if (fs.existsSync(ICON)) {
    const png = fs.readFileSync(ICON);
    await c.application.fetch().catch(() => {});
    if (!c.application.icon) await c.application.edit({ icon: png }).then(() => console.log("Set the application icon.")).catch((e) => console.warn("Couldn't set the app icon:", e.message));
    if (!c.user.avatar) await c.user.setAvatar(png).then(() => console.log("Set the bot avatar.")).catch((e) => console.warn("Couldn't set the avatar:", e.message));
  }

  // Cache members so boost changes can be detected reliably.
  for (const g of c.guilds.cache.values()) await g.members.fetch().catch(() => {});

  // Website announcements → announcements channel, changelog → changelog channel.
  startSiteFeed(c);
});

// ---------------------------------------------------------------- commands & buttons
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = byName.get(interaction.commandName);
      if (cmd) await cmd.execute(interaction);
      return;
    }
    if (interaction.isButton()) await onButton(interaction);
  } catch (err) {
    console.error(err);
    const msg = { content: `Something went wrong: ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

async function onButton(i) {
  if (!i.inGuild()) return;
  const store = load(i.guildId);
  const member = await i.guild.members.fetch(i.user.id);

  // Self-assignable ping roles: toggle.
  if (i.customId.startsWith("spectra:role:")) {
    const key = i.customId.slice("spectra:role:".length);
    const def = ROLES.find((r) => r.key === key && r.selfAssign);
    const roleId = def && store.roles[key];
    if (!roleId) return i.reply({ content: "That role doesn't exist anymore.", flags: MessageFlags.Ephemeral });
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId, "Self-role");
      return i.reply({ content: `Removed **${def.name}**.`, flags: MessageFlags.Ephemeral });
    }
    await member.roles.add(roleId, "Self-role");
    return i.reply({ content: `Added **${def.name}**.`, flags: MessageFlags.Ephemeral });
  }

  // Old rules posts had an "I agree" button; Member is automatic now.
  if (i.customId === "spectra:agree") {
    return i.reply({ content: "You're all set. Everyone gets the Member role automatically now. 🎧", flags: MessageFlags.Ephemeral });
  }
}

// ---------------------------------------------------------------- joins: auto-role + welcome card
client.on(Events.GuildMemberAdd, async (member) => {
  const store = load(member.guild.id);
  const roleId = member.user.bot ? store.roles.bots : (process.env.MEMBER_ROLE_ID || store.roles.member);
  if (roleId) await member.roles.add(roleId, member.user.bot ? "Bot joined" : "Auto-role on join").catch((e) => console.warn("Auto-role failed:", e.message));
  if (member.user.bot) return;

  const channel = store.channels.welcome && member.guild.channels.cache.get(store.channels.welcome);
  if (!channel) return;
  try {
    const png = await welcomeCard({
      avatarUrl: member.displayAvatarURL({ extension: "png", size: 256, forceStatic: true }),
      displayName: member.displayName,
      serverName: member.guild.name,
      memberCount: member.guild.memberCount,
    });
    await channel.send({
      content: `👋 Welcome ${member} to **${member.guild.name}**! You're member **#${member.guild.memberCount}**. Glad to have you here!`,
      files: [new AttachmentBuilder(png, { name: "welcome.png" })],
      allowedMentions: { users: [member.id] },
    });
  } catch (e) {
    console.warn("Welcome message failed:", e.message);
  }
});

// ---------------------------------------------------------------- boosts
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (oldMember.partial || oldMember.premiumSinceTimestamp || !newMember.premiumSinceTimestamp) return;
  const { guild } = newMember;
  const store = load(guild.id);
  const channel = store.channels.boosts && guild.channels.cache.get(store.channels.boosts);
  if (!channel) return;
  const count = guild.premiumSubscriptionCount ?? 0;
  const e = new EmbedBuilder()
    .setColor(0xf47fff)
    .setAuthor({ name: newMember.displayName, iconURL: newMember.displayAvatarURL({ size: 128 }) })
    .setTitle("🚀 New boost!")
    .setDescription(`${newMember} just boosted the server. Thank you! 💜`)
    .addFields({ name: "Boosts", value: String(count), inline: true }, { name: "Server level", value: `Level ${guild.premiumTier}`, inline: true })
    .setThumbnail(newMember.displayAvatarURL({ size: 256 }))
    .setTimestamp();
  await channel.send({ content: `${newMember}`, embeds: [e], allowedMentions: { users: [newMember.id] } }).catch((err) => console.warn("Boost message failed:", err.message));
});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  if (/disallowed intents/i.test(e.message)) {
    console.error("\nDiscord refused the connection: turn on \"Server Members Intent\" at");
    console.error("https://discord.com/developers/applications → your app → Bot → Privileged Gateway Intents, then start the bot again.\n");
  } else console.error(e);
  process.exit(1);
});

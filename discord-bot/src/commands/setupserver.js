// /setupserver: builds the whole Spectra server layout.
//   mode:keep  (default) creates/updates Spectra's roles and channels, deletes nothing.
//   mode:clean also deletes channels and roles that aren't part of the layout (after a preview).
// Safe to run again: roles/channels are matched by saved id, then by name, and
// the bot edits its own embeds in place instead of posting new ones.
import fs from "node:fs";
import path from "node:path";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, GuildDefaultMessageNotifications,
  GuildExplicitContentFilter, GuildVerificationLevel, InteractionContextType, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder,
} from "discord.js";
import { ACCENT, CATEGORIES, RULES, ROLES, SERVER, SITE } from "../template.js";
import { load, save } from "../lib/store.js";
import { downloadsMessage } from "../lib/downloads.js";

export const data = new SlashCommandBuilder()
  .setName("setupserver")
  .setDescription("Create Spectra's roles, channels, permissions and info embeds")
  .addStringOption((o) => o.setName("mode").setDescription("Keep extra channels/roles, or delete everything that isn't part of the layout")
    .addChoices({ name: "Keep everything else (safe)", value: "keep" }, { name: "Clean: delete extra channels and roles", value: "clean" }))
  .setDefaultMemberPermissions(P.Administrator)
  .setContexts(InteractionContextType.Guild);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function execute(interaction) {
  const { guild } = interaction;
  const clean = interaction.options.getString("mode") === "clean";
  if (interaction.user.id !== guild.ownerId && !interaction.memberPermissions.has(P.Administrator)) {
    return interaction.reply({ content: "Only the server owner or an Admin can run this.", flags: MessageFlags.Ephemeral });
  }
  if (clean && interaction.user.id !== guild.ownerId) {
    return interaction.reply({ content: "Clean mode deletes channels and roles, so only the server owner can run it.", flags: MessageFlags.Ephemeral });
  }
  if (!guild.members.me.permissions.has(P.Administrator)) {
    return interaction.reply({ content: "I need the **Administrator** permission to build the server.", flags: MessageFlags.Ephemeral });
  }

  const store = load(guild.id);
  await guild.channels.fetch();
  await guild.roles.fetch();

  // ---------------------------------------------------------------- preview what clean mode would delete
  const preview = clean ? planCleanup(guild, store, interaction.channelId) : { channels: [], roles: [] };
  const list = (items, fmt) => (items.length ? items.slice(0, 25).map(fmt).join(", ") + (items.length > 25 ? ` and ${items.length - 25} more` : "") : "nothing");
  const confirm = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("setup:go").setLabel(clean ? "Set up and delete" : "Set up the server").setStyle(clean ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("setup:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
  const msg = await interaction.reply({
    content: [
      "**This will set up the Spectra server:**",
      "• server name **Spectra**, icon and safety settings",
      "• roles with emojis (👑 Owner, 🛡️ Admin, 🔨 Moderator, 🛟 Support, 🎨 Theme Creator, 🤖 Bots, 🎧 Member, ping roles)",
      "• channels and permissions, including 👋 welcome and 🚀 boosts",
      "• rules, role picker and downloads posts",
      "• 🎧 Member for everyone, 👑 Owner for you, 🤖 Bots for bots",
      "",
      clean
        ? `🗑️ **Clean mode will permanently delete:**\n**Channels (${preview.channels.length}):** ${list(preview.channels, (c) => `#${c.name}`)}\n**Roles (${preview.roles.length}):** ${list(preview.roles, (r) => `@${r.name}`)}\nThis can't be undone.`
        : "Nothing gets deleted. Use `mode: Clean` to remove channels and roles that aren't part of the layout.",
    ].join("\n").slice(0, 1990),
    components: [confirm],
    flags: MessageFlags.Ephemeral,
    withResponse: true,
  });
  let click;
  try {
    click = await msg.resource.message.awaitMessageComponent({ filter: (i) => i.user.id === interaction.user.id, time: 90_000 });
  } catch {
    return interaction.editReply({ content: "Timed out. Nothing changed.", components: [] });
  }
  if (click.customId !== "setup:go") return click.update({ content: "Cancelled. Nothing changed.", components: [] });
  await click.update({ content: "⏳ Setting up…", components: [] });

  const log = [];
  const step = async (label, fn) => {
    try {
      const note = await fn();
      log.push(`✅ ${label}${note ? ` (${note})` : ""}`);
    } catch (e) {
      log.push(`⚠️ ${label}: ${e.message}`);
    }
    await interaction.editReply({ content: `⏳ Setting up…\n${log.join("\n")}`.slice(0, 1990) }).catch(() => {});
  };
  const reason = `Spectra setup by ${interaction.user.tag}`;

  // ---------------------------------------------------------------- server profile
  await step("Server name, icon and safety settings", async () => {
    const iconPath = path.join(process.cwd(), SERVER.icon);
    await guild.edit({
      name: SERVER.name,
      icon: fs.existsSync(iconPath) ? fs.readFileSync(iconPath) : undefined,
      verificationLevel: GuildVerificationLevel.Medium,
      defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
      explicitContentFilter: GuildExplicitContentFilter.AllMembers,
      reason,
    });
  });

  // ---------------------------------------------------------------- roles (create, or update existing in place)
  const roleIds = {};
  await step("Roles", async () => {
    let made = 0, updated = 0;
    for (const r of ROLES) {
      let role = (store.roles[r.key] && guild.roles.cache.get(store.roles[r.key]))
        || guild.roles.cache.find((x) => x.name === r.name || (r.legacy || []).includes(x.name));
      const spec = { name: r.name, colors: { primaryColor: r.color }, hoist: !!r.hoist, mentionable: !!r.mentionable, permissions: r.permissions };
      if (!role) {
        role = await guild.roles.create({ ...spec, reason });
        made++;
      } else if (role.editable) {
        await role.edit({ ...spec, reason });
        updated++;
      }
      roleIds[r.key] = role.id;
    }
    // Order them (top to bottom as listed), just below the bot's own role.
    const top = guild.members.me.roles.highest.position;
    await guild.roles.setPositions(ROLES.map((r, i) => ({ role: roleIds[r.key], position: Math.max(1, top - 1 - i) }))).catch(() => {});
    store.roles = roleIds;
    save(guild.id);
    return `${made} created, ${updated} updated`;
  });

  // ---------------------------------------------------------------- channels
  const overwrites = (perms) => Object.entries(perms || {}).flatMap(([key, { allow = [], deny = [] }]) => {
    const id = key === "everyone" ? guild.id : roleIds[key];
    return id ? [{ id, allow, deny }] : [];
  });
  await step("Categories and channels", async () => {
    let made = 0;
    for (const cat of CATEGORIES) {
      let category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === cat.name);
      if (!category) {
        category = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory, permissionOverwrites: overwrites(cat.perms), reason });
        made++;
      } else {
        await category.permissionOverwrites.set(overwrites(cat.perms), reason);
      }
      store.channels["cat:" + cat.name] = category.id;
      for (const [index, ch] of cat.channels.entries()) {
        const type = ch.type ?? ChannelType.GuildText;
        let channel = (store.channels[ch.key] && guild.channels.cache.get(store.channels[ch.key]))
          || guild.channels.cache.find((c) => c.parentId === category.id && c.name === ch.name);
        const opts = { name: ch.name, parent: category.id, position: index, permissionOverwrites: overwrites(ch.perms || cat.perms), reason };
        if (type === ChannelType.GuildText) { opts.topic = ch.topic || null; opts.rateLimitPerUser = ch.slowmode || 0; }
        if (!channel) {
          channel = await guild.channels.create({ ...opts, type });
          made++;
        } else {
          await channel.edit(opts);
        }
        store.channels[ch.key] = channel.id;
      }
    }
    save(guild.id);
    return `${made} created`;
  });

  const channel = (key) => guild.channels.cache.get(store.channels[key]);

  // Post once; on later runs edit the same message instead of posting again.
  async function upsert(key, channelKey, payload) {
    const ch = channel(channelKey);
    if (!ch) throw new Error(`#${channelKey} is missing`);
    const old = store.messages[key] && (await ch.messages.fetch(store.messages[key]).catch(() => null));
    const m = old ? await old.edit(payload) : await ch.send(payload);
    store.messages[key] = m.id;
    save(guild.id);
  }

  // ---------------------------------------------------------------- rules
  await step("Rules", async () => {
    const rules = new EmbedBuilder()
      .setColor(ACCENT)
      .setTitle("📜 Server rules")
      .setDescription("Welcome to the Spectra community! Please read these. By being here, you agree to follow them.")
      .addFields(RULES.map(([title, text], i) => ({ name: `${i + 1}. ${title}`, value: text })))
      .setFooter({ text: "Breaking these can get you warned, timed out or banned." });
    const links = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Get Spectra").setStyle(ButtonStyle.Link).setURL(`${SITE}/download`));
    await upsert("rules", "rules", { embeds: [rules], components: [links] });
  });

  // ---------------------------------------------------------------- self roles
  await step("Role picker", async () => {
    const pickable = ROLES.filter((r) => r.selfAssign);
    const e = new EmbedBuilder()
      .setColor(ACCENT)
      .setTitle("🏷️ Pick your pings")
      .setDescription(pickable.map((r) => `**${r.name}**: ${r.description}`).join("\n") + "\n\nPress a button to turn it on, press again to turn it off.");
    const row = new ActionRowBuilder().addComponents(pickable.map((r) => new ButtonBuilder().setCustomId(`spectra:role:${r.key}`).setLabel(r.name).setStyle(ButtonStyle.Secondary)));
    await upsert("roles", "roles", { embeds: [e], components: [row] });
  });

  // ---------------------------------------------------------------- downloads (live from the website)
  await step("Downloads", async () => {
    const m = await fetch(`${SITE}/api/manifest`).then((r) => r.json()).catch(() => null);
    await upsert("downloads", "downloads", downloadsMessage(m));
  });

  // ---------------------------------------------------------------- welcome + boosts intros, staff notes, system channels
  await step("Welcome, boosts and staff notes", async () => {
    await upsert("boostsIntro", "boosts", { embeds: [new EmbedBuilder().setColor(0xf47fff).setTitle("🚀 Server boosts").setDescription("Every boost helps the server. Thank-yous show up here automatically. 💜")] });
    const e = new EmbedBuilder()
      .setColor(ACCENT)
      .setTitle("🛡️ Staff quick reference")
      .setDescription([
        "`/warn` → note + DM. `/warnings` shows history.",
        "`/timeout` for cooling off (e.g. `10m`, `1h`, `1d`). `/untimeout` to lift it.",
        "`/kick` / `/ban` for serious or repeated issues. `/unban` with a user ID.",
        "`/purge` clears recent messages. `/slowmode`, `/lock`, `/unlock` for busy channels.",
        "Everything is logged in #📋・mod-log.",
      ].join("\n"));
    await upsert("staff", "staffChat", { embeds: [e] });
    await guild.edit({ systemChannel: channel("welcome")?.id ?? null, afkChannel: channel("afk")?.id ?? null, afkTimeout: 300, reason });
  });

  // ---------------------------------------------------------------- give everyone the right roles
  await step("Owner, Bots and Member roles", async () => {
    const members = await guild.members.fetch();
    let given = 0;
    for (const m of members.values()) {
      const want = m.id === guild.ownerId ? [roleIds.owner] : m.user.bot ? [roleIds.bots] : [roleIds.member];
      if (m.id === guild.ownerId) want.push(roleIds.member);
      for (const id of want) {
        if (id && !m.roles.cache.has(id) && m.manageable !== false) {
          await m.roles.add(id, reason).catch(() => {});
          given++;
          if (given % 10 === 0) await sleep(1000); // be gentle with rate limits
        }
      }
    }
    return `${given} given to ${members.size} members`;
  });

  // ---------------------------------------------------------------- clean mode: delete leftovers
  if (clean) {
    await step("Deleted extra channels and roles", async () => {
      const plan = planCleanup(guild, store, interaction.channelId);
      let ch = 0, ro = 0;
      // Channels first (children before their categories), then roles.
      const order = [...plan.channels].sort((a, b) => (a.type === ChannelType.GuildCategory) - (b.type === ChannelType.GuildCategory));
      for (const c of order) { if (await c.delete(reason).then(() => true).catch(() => false)) ch++; }
      for (const r of plan.roles) { if (await r.delete(reason).then(() => true).catch(() => false)) ro++; }
      return `${ch} channels, ${ro} roles`;
    });
  }

  const issues = log.filter((l) => l.startsWith("⚠️")).length;
  await interaction.editReply({
    content: `${issues ? "⚠️ Finished with some issues" : "🎉 Server is set up!"}\n${log.join("\n")}\n\nTip: drag my role to the top of the role list so I can manage every role.`.slice(0, 1990),
  });
}

/** Channels and roles that aren't part of the Spectra layout (and that are safe to delete). */
function planCleanup(guild, store, currentChannelId) {
  const keepChannels = new Set(Object.values(store.channels || {}));
  const layoutNames = new Set(CATEGORIES.flatMap((c) => [c.name, ...c.channels.map((ch) => ch.name)]));
  const protectedIds = new Set([currentChannelId, guild.rulesChannelId, guild.publicUpdatesChannelId, guild.safetyAlertsChannelId].filter(Boolean));
  const channels = [...guild.channels.cache.values()].filter((c) =>
    !keepChannels.has(c.id) && !layoutNames.has(c.name) && !protectedIds.has(c.id) && c.deletable && !c.isThread());

  const keepRoles = new Set(Object.values(store.roles || {}));
  const layoutRoleNames = new Set(ROLES.flatMap((r) => [r.name, ...(r.legacy || [])]));
  const top = guild.members.me.roles.highest.position;
  const roles = [...guild.roles.cache.values()].filter((r) =>
    r.id !== guild.id && !r.managed && !keepRoles.has(r.id) && !layoutRoleNames.has(r.name) && r.position < top && r.editable);
  return { channels, roles };
}

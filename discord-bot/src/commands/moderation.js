// Moderation commands. Each checks role hierarchy and logs to #mod-log.
import { ChannelType, EmbedBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder } from "discord.js";
import { checkHierarchy, humanDuration, modLog, parseDuration, reasonOf } from "../lib/mod.js";
import { load, save } from "../lib/store.js";

const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });
const base = (name, description, perm) => new SlashCommandBuilder().setName(name).setDescription(description).setDefaultMemberPermissions(perm).setContexts(InteractionContextType.Guild);
const withReason = (b) => b.addStringOption((o) => o.setName("reason").setDescription("Why (shown in the log and to the user)").setMaxLength(500));

async function tellUser(user, guild, text) {
  await user.send(`**${guild.name}**: ${text}`).catch(() => {}); // DMs may be closed; that's fine.
}

export const commands = [
  // ---------------------------------------------------------------- ban
  {
    data: withReason(base("ban", "Ban a member", P.BanMembers)
      .addUserOption((o) => o.setName("user").setDescription("Who to ban").setRequired(true))
      .addIntegerOption((o) => o.setName("delete_messages").setDescription("Delete their recent messages").addChoices(
        { name: "Don't delete", value: 0 }, { name: "Last hour", value: 3600 }, { name: "Last 24 hours", value: 86400 }, { name: "Last 7 days", value: 604800 }))),
    async execute(i) {
      const user = i.options.getUser("user");
      const member = await i.guild.members.fetch(user.id).catch(() => null);
      if (member) { const err = checkHierarchy(i, member); if (err) return i.reply(eph(err)); }
      const reason = reasonOf(i);
      await tellUser(user, i.guild, `You were banned. Reason: ${reason}`);
      await i.guild.members.ban(user.id, { reason: `${i.user.tag}: ${reason}`, deleteMessageSeconds: i.options.getInteger("delete_messages") || 0 });
      await modLog(i.guild, { action: "ban", moderator: i.user, target: user, reason });
      return i.reply(eph(`🔨 Banned **${user.tag}**.`));
    },
  },
  // ---------------------------------------------------------------- unban
  {
    data: withReason(base("unban", "Unban a user by ID", P.BanMembers)
      .addStringOption((o) => o.setName("user_id").setDescription("Their user ID").setRequired(true))),
    async execute(i) {
      const id = i.options.getString("user_id").replace(/\D/g, "");
      const reason = reasonOf(i);
      try {
        const user = await i.guild.members.unban(id, `${i.user.tag}: ${reason}`);
        await modLog(i.guild, { action: "unban", moderator: i.user, target: user, reason });
        return i.reply(eph(`✅ Unbanned **${user.tag}**.`));
      } catch {
        return i.reply(eph("That user isn't banned (or the ID is wrong)."));
      }
    },
  },
  // ---------------------------------------------------------------- kick
  {
    data: withReason(base("kick", "Kick a member", P.KickMembers)
      .addUserOption((o) => o.setName("user").setDescription("Who to kick").setRequired(true))),
    async execute(i) {
      const member = i.options.getMember("user");
      const err = checkHierarchy(i, member); if (err) return i.reply(eph(err));
      const reason = reasonOf(i);
      await tellUser(member.user, i.guild, `You were kicked. Reason: ${reason}`);
      await member.kick(`${i.user.tag}: ${reason}`);
      await modLog(i.guild, { action: "kick", moderator: i.user, target: member.user, reason });
      return i.reply(eph(`👢 Kicked **${member.user.tag}**.`));
    },
  },
  // ---------------------------------------------------------------- timeout
  {
    data: withReason(base("timeout", "Time a member out (they can't talk)", P.ModerateMembers)
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
      .addStringOption((o) => o.setName("duration").setDescription("e.g. 10m, 1h, 1d (max 28d)").setRequired(true))),
    async execute(i) {
      const member = i.options.getMember("user");
      const err = checkHierarchy(i, member); if (err) return i.reply(eph(err));
      const ms = parseDuration(i.options.getString("duration"));
      if (!ms || ms < 5000 || ms > 28 * 864e5) return i.reply(eph("Use a duration like `10m`, `2h` or `3d` (up to 28 days)."));
      const reason = reasonOf(i);
      await member.timeout(ms, `${i.user.tag}: ${reason}`);
      await tellUser(member.user, i.guild, `You were timed out for ${humanDuration(ms)}. Reason: ${reason}`);
      await modLog(i.guild, { action: "timeout", moderator: i.user, target: member.user, reason, extra: { Duration: humanDuration(ms) } });
      return i.reply(eph(`⏳ Timed out **${member.user.tag}** for ${humanDuration(ms)}.`));
    },
  },
  // ---------------------------------------------------------------- untimeout
  {
    data: withReason(base("untimeout", "Remove a member's timeout", P.ModerateMembers)
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))),
    async execute(i) {
      const member = i.options.getMember("user");
      const err = checkHierarchy(i, member); if (err) return i.reply(eph(err));
      if (!member.isCommunicationDisabled()) return i.reply(eph("They aren't timed out."));
      const reason = reasonOf(i);
      await member.timeout(null, `${i.user.tag}: ${reason}`);
      await modLog(i.guild, { action: "untimeout", moderator: i.user, target: member.user, reason });
      return i.reply(eph(`✅ Lifted **${member.user.tag}**'s timeout.`));
    },
  },
  // ---------------------------------------------------------------- warn
  {
    data: base("warn", "Warn a member (saved, and DM'd to them)", P.ModerateMembers)
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("What they did").setRequired(true).setMaxLength(500)),
    async execute(i) {
      const member = i.options.getMember("user");
      const err = checkHierarchy(i, member); if (err) return i.reply(eph(err));
      const reason = reasonOf(i);
      const store = load(i.guild.id);
      const list = (store.warnings[member.id] = store.warnings[member.id] || []);
      list.push({ reason, by: i.user.id, at: Date.now() });
      save(i.guild.id);
      await tellUser(member.user, i.guild, `You received a warning (#${list.length}). Reason: ${reason}`);
      await modLog(i.guild, { action: "warn", moderator: i.user, target: member.user, reason, extra: { "Total warnings": list.length } });
      return i.reply(eph(`⚠️ Warned **${member.user.tag}**. They now have ${list.length} warning${list.length === 1 ? "" : "s"}.`));
    },
  },
  // ---------------------------------------------------------------- warnings
  {
    data: base("warnings", "Show a member's warnings", P.ModerateMembers)
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true)),
    async execute(i) {
      const user = i.options.getUser("user");
      const list = load(i.guild.id).warnings[user.id] || [];
      if (!list.length) return i.reply(eph(`**${user.tag}** has no warnings.`));
      const e = new EmbedBuilder()
        .setColor(0xffd23f)
        .setTitle(`Warnings for ${user.tag}`)
        .setDescription(list.slice(-15).map((w, n) => `**${list.length - Math.min(list.length, 15) + n + 1}.** ${w.reason}\n<t:${Math.floor(w.at / 1000)}:R> by <@${w.by}>`).join("\n\n"));
      return i.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
    },
  },
  // ---------------------------------------------------------------- clearwarnings
  {
    data: withReason(base("clearwarnings", "Clear all of a member's warnings", P.ModerateMembers)
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))),
    async execute(i) {
      const user = i.options.getUser("user");
      const store = load(i.guild.id);
      const n = (store.warnings[user.id] || []).length;
      delete store.warnings[user.id];
      save(i.guild.id);
      await modLog(i.guild, { action: "clearwarnings", moderator: i.user, target: user, reason: reasonOf(i), extra: { Cleared: n } });
      return i.reply(eph(`🧹 Cleared ${n} warning${n === 1 ? "" : "s"} for **${user.tag}**.`));
    },
  },
  // ---------------------------------------------------------------- purge
  {
    data: base("purge", "Delete recent messages in this channel", P.ManageMessages)
      .addIntegerOption((o) => o.setName("amount").setDescription("How many (1–100)").setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption((o) => o.setName("user").setDescription("Only messages from this user")),
    async execute(i) {
      const amount = i.options.getInteger("amount");
      const only = i.options.getUser("user");
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      let messages = await i.channel.messages.fetch({ limit: 100 });
      if (only) messages = messages.filter((m) => m.author.id === only.id);
      const toDelete = [...messages.values()].slice(0, amount);
      // Discord can only bulk-delete messages younger than 14 days.
      const deleted = await i.channel.bulkDelete(toDelete, true);
      await modLog(i.guild, { action: "purge", moderator: i.user, target: only || null, reason: `Deleted ${deleted.size} message(s) in ${i.channel}` });
      return i.editReply(`🧹 Deleted ${deleted.size} message${deleted.size === 1 ? "" : "s"}${deleted.size < toDelete.length ? " (older than 14 days can't be bulk-deleted)" : ""}.`);
    },
  },
  // ---------------------------------------------------------------- slowmode
  {
    data: base("slowmode", "Set slowmode for this channel", P.ManageChannels)
      .addIntegerOption((o) => o.setName("seconds").setDescription("0 to turn off (max 21600)").setRequired(true).setMinValue(0).setMaxValue(21600)),
    async execute(i) {
      const s = i.options.getInteger("seconds");
      await i.channel.setRateLimitPerUser(s, `${i.user.tag}`);
      await modLog(i.guild, { action: "slowmode", moderator: i.user, reason: `${i.channel}: ${s ? s + "s" : "off"}` });
      return i.reply(eph(s ? `🐢 Slowmode set to ${s}s.` : "Slowmode is off."));
    },
  },
  // ---------------------------------------------------------------- lock / unlock
  ...["lock", "unlock"].map((which) => ({
    data: withReason(base(which, which === "lock" ? "Stop members talking in a channel" : "Let members talk again", P.ManageChannels)
      .addChannelOption((o) => o.setName("channel").setDescription("Defaults to this channel").addChannelTypes(ChannelType.GuildText))),
    async execute(i) {
      const ch = i.options.getChannel("channel") || i.channel;
      const store = load(i.guild.id);
      const memberRole = store.roles.member;
      const deny = which === "lock" ? false : null; // null = back to the category default
      await ch.permissionOverwrites.edit(i.guild.id, { SendMessages: deny }, { reason: `${i.user.tag}` });
      if (memberRole) await ch.permissionOverwrites.edit(memberRole, { SendMessages: which === "lock" ? false : null }, { reason: `${i.user.tag}` }).catch(() => {});
      if (which === "lock") await ch.send("🔒 This channel is locked by staff for now.").catch(() => {});
      else await ch.send("🔓 Unlocked. Carry on!").catch(() => {});
      await modLog(i.guild, { action: which, moderator: i.user, reason: `${ch}: ${reasonOf(i)}` });
      return i.reply(eph(which === "lock" ? `🔒 Locked ${ch}.` : `🔓 Unlocked ${ch}.`));
    },
  })),
];

# Spectra Discord bot

`/setupserver` builds the Spectra community server, and moderation commands keep it tidy.

## What `/setupserver` does

* Renames the server to **Spectra**, sets the icon, and turns on safer defaults (verification level Medium, explicit-content filter, @mention-only notifications).
* **Roles:** Admin, Moderator, Support, Theme Creator, Member, plus self-assignable 📢 Announcements / 🔔 Updates / 🎨 New Themes ping roles.
* **Channels** with permissions:
  * 📌 START HERE (read-only): rules, announcements, changelog, downloads, roles
  * 💬 COMMUNITY, 🛟 SUPPORT, 🔊 VOICE: hidden until someone accepts the rules
  * 🛡️ STAFF: staff-chat, mod-log, reports, admin-only (staff only)
* Posts the **rules** with an **I agree** button (gives the Member role), a **ping-role picker**, a **downloads** panel with live versions from the website, and a staff quick-reference.
* It asks before doing anything, never deletes, reuses roles and channels that already exist, and edits its own posts instead of duplicating them. Running it again is safe.

Edit names, colours, channels and rules in `src/template.js`.

## Moderation

`/ban` `/unban` `/kick` `/timeout` `/untimeout` `/warn` `/warnings` `/clearwarnings` `/purge` `/slowmode` `/lock` `/unlock`

Each one checks role hierarchy (no acting on the owner or anyone at or above you or the bot), DMs the member where it makes sense, and logs to **📋・mod-log**. Warnings are saved in `data/`.

## Setup

1. Go to https://discord.com/developers/applications → **New Application** → name it *Spectra*.
2. **Bot** tab → **Reset Token** → copy it.
3. Copy `.env.example` to `.env` and fill in:
   * `DISCORD_TOKEN`: the token from step 2 (keep it secret)
   * `CLIENT_ID`: **General Information → Application ID**
   * `GUILD_ID`: your server's ID (Discord settings → Advanced → Developer Mode, then right-click the server → Copy Server ID)
4. Invite the bot. Replace `APP_ID` with your Application ID:
   `https://discord.com/oauth2/authorize?client_id=APP_ID&permissions=8&integration_type=0&scope=bot+applications.commands`
5. Double-click **Start Bot.cmd**. It installs dependencies, registers the commands and starts the bot.
6. In your server, run **/setupserver**.

No privileged intents are needed. Leave *Message Content* and *Server Members* off.

The bot is online only while `Start Bot.cmd` is running. For 24/7 uptime, run it on an always-on machine or a host such as a small VPS (`npm install`, then `npm run deploy` once, then `npm start`).

## Discord status in the Spectra app

Put the same **Application ID** in the project's `spectra.config.json` as `"discordClientId"` and rebuild the desktop app. Spectra then shows "Theming Spotify · <theme>" with a **Get Spectra** button on users' Discord profiles (they can switch it off on Spectra's Spotify page).

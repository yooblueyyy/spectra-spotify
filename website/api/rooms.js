// Listen Together rooms.
//
// Everyone
//   GET  ?list=public                                     → { rooms }   public room browser
//   POST { action: "create", name, roomName, visibility } → { code, hostKey, memberId, room }
//   POST { action: "join", code, name }                   → { memberId, me, room }
//   POST { action: "leave", code, memberId, hostKey? }    → { ok }      host leaving ends the room
// Guests
//   GET  ?code=…&member=…                                 → { room, me }  poll (also a heartbeat)
//   POST { action: "command", code, memberId, cmd }       → { ok }      DJs only; the host's Spotify runs it
// Host
//   POST { action: "update", code, hostKey, state }       → { ok, seq, members }
//   POST { action: "host-poll", code, hostKey }           → { room, commands }  picks up DJ commands
//   POST { action: "set-dj", code, hostKey, pid, dj }     → { ok }
//   POST { action: "kick", code, hostKey, pid }           → { ok }
//   POST { action: "settings", code, hostKey, roomName?, visibility? } → { ok }
//
// Secrets: the host key (host only) and each member's memberId (only that member).
// Everyone in a room can see the public id ("pid") of each member, which is all the
// host needs to pick DJs. Rooms disappear 6 hours after the host was last active.
import crypto from "node:crypto";
import { hasStorage, redis, redisPipeline } from "./_store.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
const ROOM_TTL = 6 * 60 * 60;        // seconds
const MEMBER_STALE = 20 * 1000;      // ms without a poll before someone counts as gone
const HOST_STALE = 90 * 1000;        // ms without host activity before the room shows as "host away"
const MAX_MEMBERS = 50;
const CREATES_PER_HOUR = 20;         // per IP
const COMMANDS_PER_MINUTE = 12;      // per member
const PUBLIC = "spectra:rooms:public"; // sorted set: code → last host activity

const roomKey = (c) => `spectra:room:${c}`;
const membersKey = (c) => `spectra:room:${c}:members`;
const commandsKey = (c) => `spectra:room:${c}:commands`;
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v, max) => (Number.isFinite(+v) ? Math.max(0, Math.min(+v, max)) : 0);
const token = (bytes) => crypto.randomBytes(bytes).toString("base64url");
const sha = (v) => crypto.createHash("sha256").update(String(v || "")).digest("base64url");
const safeEq = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const clean = (v, max, fallback) => str(String(v || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim(), max) || fallback;

const TRACK_RE = /^spotify:(track|episode):[A-Za-z0-9]{10,40}$/;
const CONTEXT_RE = /^spotify:(track|episode|album|playlist|artist|show):[A-Za-z0-9]{10,40}$/;

function newCode() {
  return [...crypto.randomBytes(6)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}
/** "k7q-m2x", "K7QM2X" → "K7QM2X" (or "" if it can't be a code). */
function cleanCode(v) {
  const c = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 6 && [...c].every((ch) => ALPHABET.includes(ch)) ? c : "";
}

/** Only what guests need from the host's player. */
function cleanState(s) {
  s = s && typeof s === "object" ? s : {};
  const uri = TRACK_RE.test(s.uri || "") ? s.uri : "";
  return {
    uri,
    title: str(s.title, 200),
    artist: str(s.artist, 200),
    art: /^https:\/\/[^\s"']+$/.test(s.art || "") ? str(s.art, 500) : "",
    duration: num(s.duration, 24 * 3600 * 1000),
    position: num(s.position, 24 * 3600 * 1000),
    playing: !!s.playing && !!uri,
  };
}

/** A DJ's request, or null if it isn't one we allow. */
function cleanCommand(c) {
  c = c && typeof c === "object" ? c : {};
  switch (c.type) {
    case "queue": return TRACK_RE.test(c.uri || "") ? { type: "queue", uri: c.uri, title: str(c.title, 200) } : null;
    case "play": return CONTEXT_RE.test(c.uri || "") ? { type: "play", uri: c.uri, title: str(c.title, 200) } : null;
    case "skip": case "back": case "pause": case "resume": return { type: c.type };
    default: return null;
  }
}

const isHost = (room, hostKey) => !!room && !!room.hostHash && safeEq(sha(hostKey), room.hostHash);

async function readRoom(code) {
  const raw = await redis(["GET", roomKey(code)]);
  const room = raw ? JSON.parse(raw) : null;
  if (room) { room.djs = room.djs || []; room.visibility = room.visibility || "private"; }
  return room;
}

async function saveRoom(code, room) {
  await redis(["SET", roomKey(code), JSON.stringify(room), "EX", ROOM_TTL]);
  await redis(["EXPIRE", membersKey(code), ROOM_TTL]);
  if (room.visibility === "public") await redis(["ZADD", PUBLIC, Date.now(), code]);
  else await redis(["ZREM", PUBLIC, code]);
}

/** Every member record: [{ id (secret), pid, name, host, seen }]. Drops people who stopped polling. */
async function allMembers(code) {
  const all = (await redis(["HGETALL", membersKey(code)])) || [];
  const now = Date.now(), out = [], gone = [];
  for (let i = 0; i < all.length; i += 2) {
    let m; try { m = JSON.parse(all[i + 1]); } catch { continue; }
    if (now - m.seen > MEMBER_STALE && !m.host) gone.push(all[i]);
    else out.push(Object.assign({ id: all[i] }, m));
  }
  if (gone.length) await redis(["HDEL", membersKey(code), ...gone]).catch(() => {});
  return out;
}

/** What the room's members may see about each other. */
const publicMembers = (room, members) => members
  .map((m) => ({ pid: m.pid, name: m.name, host: !!m.host, dj: !m.host && room.djs.includes(m.pid) }))
  .sort((a, b) => (b.host - a.host) || (b.dj - a.dj) || a.name.localeCompare(b.name));

async function touchMember(code, id, record) {
  const m = Object.assign({}, record, { seen: Date.now() });
  if (!m.pid) m.pid = token(6);
  delete m.id;
  await redis(["HSET", membersKey(code), id, JSON.stringify(m)]);
  await redis(["EXPIRE", membersKey(code), ROOM_TTL]);
  return m;
}

/**
 * The room as members see it. `withMembers: false` skips the member list (one Redis
 * read fewer); polling clients only ask for it every few polls.
 */
async function publicRoom(code, room, members, withMembers = true) {
  const out = {
    code,
    roomName: room.roomName || `${room.hostName}'s room`,
    visibility: room.visibility,
    hostName: room.hostName,
    hostAway: Date.now() - Math.max(room.hostSeen || 0, room.state.at || 0) > HOST_STALE,
    state: room.state,
    djCount: room.djs.length,
    now: Date.now(),
  };
  if (withMembers || members) out.members = publicMembers(room, members || (await allMembers(code)));
  return out;
}

// Heartbeats are written at most this often, to keep Redis usage (billed per command) low.
const TOUCH_EVERY = 8 * 1000;
const HOST_SEEN_EVERY = 30 * 1000;

function ipOf(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || "unknown";
}

async function limited(key, max, seconds) {
  const n = await redis(["INCR", key]);
  if (n === 1) await redis(["EXPIRE", key, seconds]);
  return n > max;
}

async function listPublic() {
  const now = Date.now();
  await redis(["ZREMRANGEBYSCORE", PUBLIC, "-inf", now - ROOM_TTL * 1000]).catch(() => {});
  const codes = (await redis(["ZREVRANGEBYSCORE", PUBLIC, "+inf", now - HOST_STALE, "LIMIT", 0, 60])) || [];
  if (!codes.length) return [];
  const results = await redisPipeline(codes.flatMap((c) => [["GET", roomKey(c)], ["HLEN", membersKey(c)]]));
  const rooms = [];
  codes.forEach((code, i) => {
    let room; try { room = JSON.parse(results[i * 2]); } catch { room = null; }
    if (!room || room.visibility !== "public") return;
    rooms.push({
      code,
      roomName: room.roomName || `${room.hostName}'s room`,
      hostName: room.hostName,
      listeners: Math.max(1, +results[i * 2 + 1] || 1),
      nowPlaying: room.state && room.state.uri ? { title: room.state.title, artist: room.state.artist, art: room.state.art, playing: room.state.playing } : null,
    });
  });
  return rooms;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!hasStorage()) return res.status(503).json({ error: "Listen Together isn't available right now." });

  try {
    if (req.method === "GET") {
      if (req.query.list === "public") return res.status(200).json({ rooms: await listPublic() });
      const code = cleanCode(req.query.code);
      const room = code && (await readRoom(code));
      if (!room || !room.hostHash) return res.status(404).json({ error: "That room has ended." });
      const member = str(req.query.member, 40);
      let me = null;
      if (member) {
        const raw = await redis(["HGET", membersKey(code), member]);
        if (!raw) return res.status(410).json({ error: "You're no longer in this room. Join again with the code." });
        let m = JSON.parse(raw);
        if (!m.pid || Date.now() - m.seen > TOUCH_EVERY) m = await touchMember(code, member, m);
        me = { pid: m.pid, dj: room.djs.includes(m.pid) };
      }
      return res.status(200).json({ room: await publicRoom(code, room, null, !member || req.query.full === "1"), me });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const code = cleanCode(body.code);

    switch (body.action) {
      case "create": {
        if (await limited(`spectra:rooms:ip:${sha(ipOf(req)).slice(0, 24)}`, CREATES_PER_HOUR, 3600)) {
          return res.status(429).json({ error: "Too many rooms created. Try again in a bit." });
        }
        let newRoomCode = "";
        for (let i = 0; i < 5 && !newRoomCode; i++) {
          const c = newCode();
          if (await redis(["SET", roomKey(c), "{}", "NX", "EX", ROOM_TTL])) newRoomCode = c; // never overwrite a room
        }
        if (!newRoomCode) return res.status(500).json({ error: "Couldn't make a room. Try again." });
        const hostKey = token(24), memberId = token(12), hostName = clean(body.name, 32, "Host");
        const host = await touchMember(newRoomCode, memberId, { name: hostName, host: true });
        const room = {
          hostName,
          roomName: clean(body.roomName, 40, `${hostName}'s room`),
          visibility: body.visibility === "public" ? "public" : "private",
          hostHash: sha(hostKey),
          hostMember: memberId,
          hostPid: host.pid,
          djs: [],
          state: { ...cleanState(null), at: Date.now(), seq: 0 },
          hostSeen: Date.now(),
          created: Date.now(),
        };
        await saveRoom(newRoomCode, room);
        return res.status(200).json({ code: newRoomCode, hostKey, memberId, room: await publicRoom(newRoomCode, room) });
      }

      case "join": {
        const room = code && (await readRoom(code));
        if (!room || !room.hostHash) return res.status(404).json({ error: "No room with that code. Check it and try again." });
        const members = await allMembers(code);
        if (members.length >= MAX_MEMBERS) return res.status(403).json({ error: "That room is full." });
        const memberId = token(12);
        const m = await touchMember(code, memberId, { name: clean(body.name, 32, "Listener"), host: false });
        return res.status(200).json({ memberId, me: { pid: m.pid, dj: false }, room: await publicRoom(code, room) });
      }

      case "leave": {
        const room = code && (await readRoom(code));
        if (!room) return res.status(200).json({ ok: true });
        if (body.hostKey && isHost(room, body.hostKey)) {
          await redis(["DEL", roomKey(code), membersKey(code), commandsKey(code)]);
          await redis(["ZREM", PUBLIC, code]);
          return res.status(200).json({ ok: true, ended: true });
        }
        if (body.memberId) await redis(["HDEL", membersKey(code), str(body.memberId, 40)]);
        return res.status(200).json({ ok: true });
      }

      case "command": {
        const room = code && (await readRoom(code));
        if (!room || !room.hostHash) return res.status(404).json({ error: "That room has ended." });
        const raw = await redis(["HGET", membersKey(code), str(body.memberId, 40)]);
        if (!raw) return res.status(410).json({ error: "You're no longer in this room." });
        const m = JSON.parse(raw);
        if (!room.djs.includes(m.pid)) return res.status(403).json({ error: "Only DJs picked by the host can do that." });
        const cmd = cleanCommand(body.cmd);
        if (!cmd) return res.status(400).json({ error: "That isn't a Spotify song, album, playlist or artist." });
        if (await limited(`spectra:room:${code}:rate:${m.pid}`, COMMANDS_PER_MINUTE, 60)) {
          return res.status(429).json({ error: "Slow down a little. Try again in a minute." });
        }
        await redis(["RPUSH", commandsKey(code), JSON.stringify(Object.assign(cmd, { from: m.name, at: Date.now() }))]);
        await redis(["LTRIM", commandsKey(code), -30, -1]);
        await redis(["EXPIRE", commandsKey(code), ROOM_TTL]);
        return res.status(200).json({ ok: true });
      }

      // ---- host only from here on
      case "update": case "host-poll": case "set-dj": case "kick": case "settings": {
        const room = code && (await readRoom(code));
        if (!room || !room.hostHash) return res.status(404).json({ error: "That room has ended." });
        if (!isHost(room, body.hostKey)) return res.status(403).json({ error: "Only the host can do that." });
        const stale = Date.now() - (room.hostSeen || 0) > HOST_SEEN_EVERY;
        room.hostSeen = Date.now();

        if (body.action === "update") {
          room.state = { ...cleanState(body.state), at: Date.now(), seq: (room.state.seq || 0) + 1 };
          await saveRoom(code, room);
          const members = body.full === false ? null : await allMembers(code);
          return res.status(200).json({ ok: true, seq: room.state.seq, members: members ? publicMembers(room, members) : undefined });
        }
        if (body.action === "host-poll") {
          const popped = (await redis(["LPOP", commandsKey(code), 20])) || [];
          const commands = [].concat(popped).map((c) => { try { return JSON.parse(c); } catch { return null; } }).filter(Boolean);
          if (stale) await saveRoom(code, room); // keeps the room alive and its spot in the browser
          return res.status(200).json({ room: await publicRoom(code, room, null, body.full !== false), commands });
        }
        const pid = str(body.pid, 20);
        if (body.action === "set-dj") {
          if (!pid || pid === room.hostPid) return res.status(400).json({ error: "Pick someone in the room." });
          room.djs = room.djs.filter((p) => p !== pid);
          if (body.dj) room.djs.push(pid);
          await saveRoom(code, room);
          return res.status(200).json({ ok: true, room: await publicRoom(code, room) });
        }
        if (body.action === "kick") {
          const members = await allMembers(code);
          const target = members.find((m) => m.pid === pid && !m.host);
          if (target) await redis(["HDEL", membersKey(code), target.id]);
          room.djs = room.djs.filter((p) => p !== pid);
          await saveRoom(code, room);
          return res.status(200).json({ ok: true, room: await publicRoom(code, room) });
        }
        // settings
        if (typeof body.roomName === "string") room.roomName = clean(body.roomName, 40, room.roomName);
        if (body.visibility === "public" || body.visibility === "private") room.visibility = body.visibility;
        await saveRoom(code, room);
        return res.status(200).json({ ok: true, room: await publicRoom(code, room) });
      }

      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    console.error("rooms:", e);
    return res.status(500).json({ error: "Something went wrong. Try again." });
  }
}

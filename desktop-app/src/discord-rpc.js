// Minimal Discord Rich Presence client over Discord's local IPC pipe. No dependencies.
// Shows "Using Spectra" on the user's Discord profile while the Discord app is running.
"use strict";
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

/** Every place Discord's IPC socket can be, in the order Discord's own SDK tries them. */
function pipePaths() {
  const out = [];
  if (process.platform === "win32") {
    for (let i = 0; i < 10; i++) out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    return out;
  }
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || os.tmpdir();
  // Linux: Flatpak and Snap builds of Discord keep the socket in their own sandbox folder.
  const dirs = [base, path.join(base, "app", "com.discordapp.Discord"), path.join(base, "app", "com.discordapp.DiscordCanary"), path.join(base, "snap.discord"), path.join(base, "snap.discord-canary")];
  if (!process.env.XDG_RUNTIME_DIR && process.platform === "linux") dirs.push("/tmp");
  for (const d of dirs) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`));
  return out;
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

class DiscordPresence {
  constructor(clientId) {
    this.clientId = clientId;
    this.socket = null;
    this.ready = false;
    this.activity = null;     // what we want shown (null = nothing)
    this.retryTimer = null;
    this.stopped = false;
    this.buf = Buffer.alloc(0);
  }

  start() {
    if (!this.clientId) return;
    this.stopped = false;
    this.connect(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.socket) { try { this.socket.destroy(); } catch {} }
    this.socket = null;
    this.ready = false;
  }

  /** Set (or clear with null) the activity. Sent now if connected, otherwise on connect. */
  set(activity) {
    this.activity = activity;
    this.flush();
  }

  connect(i) {
    if (this.stopped) return;
    const paths = pipePaths();
    if (i >= paths.length) return this.retryLater(); // Discord isn't running
    const sock = net.createConnection(paths[i]);
    let opened = false;
    sock.once("connect", () => {
      opened = true;
      this.socket = sock;
      this.buf = Buffer.alloc(0);
      sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
    });
    sock.on("data", (d) => this.onData(d));
    sock.once("error", () => { if (!opened) this.connect(i + 1); });
    sock.once("close", () => {
      if (!opened) return;
      this.socket = null;
      this.ready = false;
      this.retryLater();
    });
  }

  retryLater() {
    clearTimeout(this.retryTimer);
    if (!this.stopped) this.retryTimer = setTimeout(() => this.connect(0), 30000);
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      let msg = null;
      try { msg = JSON.parse(this.buf.subarray(8, 8 + len).toString("utf8")); } catch {}
      this.buf = this.buf.subarray(8 + len);
      if (op === OP.PING && this.socket) this.socket.write(encode(OP.PONG, msg));
      else if (op === OP.CLOSE) { try { this.socket.destroy(); } catch {} }
      else if (op === OP.FRAME && msg && msg.evt === "READY") { this.ready = true; this.flush(); }
    }
  }

  flush() {
    if (!this.ready || !this.socket) return;
    this.socket.write(encode(OP.FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity: this.activity || undefined },
      nonce: crypto.randomUUID(),
    }));
  }
}

module.exports = { DiscordPresence };

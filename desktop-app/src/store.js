// Tiny JSON key/value store with the same shape as chrome.storage.local.
"use strict";
const fs = require("fs");
const path = require("path");

class Store {
  constructor(file) {
    this.file = file;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
    this.timer = null;
  }

  get(keys) {
    const out = {};
    const list = keys == null ? Object.keys(this.data) : [].concat(keys);
    for (const k of list) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }

  /** Returns chrome-style changes: { key: { oldValue, newValue } } */
  set(obj) {
    const changes = {};
    for (const [k, v] of Object.entries(obj || {})) {
      changes[k] = { oldValue: this.data[k], newValue: v };
      this.data[k] = v;
    }
    this.scheduleSave();
    return changes;
  }

  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  // Write to a temp file and rename, so a crash can never leave half-written settings.
  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error("[Spectra] could not save settings", e);
    }
  }
}

module.exports = { Store };

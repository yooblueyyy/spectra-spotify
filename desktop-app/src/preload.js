// Exposes the small slice of the WebExtension API that the shared dashboard uses,
// backed by the app's main process. The dashboard code is identical in both products.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const storageListeners = new Set();
ipcRenderer.on("storage-changed", (e, changes) => {
  for (const fn of storageListeners) { try { fn(changes, "local"); } catch (err) { console.error(err); } }
});

// Electron already defines window.chrome, so the bridge gets its own name.
contextBridge.exposeInMainWorld("spectraHost", {
  storage: {
    local: {
      get: (keys) => ipcRenderer.invoke("storage:get", keys),
      set: (obj) => ipcRenderer.invoke("storage:set", obj),
    },
    onChanged: { addListener: (fn) => { storageListeners.add(fn); } },
  },
  runtime: {
    spectraApp: true,
    os: process.platform, // "win32" | "darwin" | "linux"
    sendMessage: (msg) => ipcRenderer.invoke("message", msg),
    getURL: (p) => p,
  },
  permissions: {
    contains: async () => true,
    request: async () => true,
  },
});

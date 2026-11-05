/**
 * db.js — the only persistence layer. Everything the user creates lives in
 * IndexedDB on this device; nothing is sent anywhere.
 *
 * Stores (all created up-front so later features need no migration):
 *   settings   {key, value}
 *   reads      {id, at}                     story ids marked read
 *   articles   {url, ...extracted, cachedAt, bytes, favorite}  read-mode text cache
 *   notes      {id, url, ...}               highlights + notes (index: url)
 */

const DB_NAME = "panel-news";
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("reads")) db.createObjectStore("reads", { keyPath: "id" });
      if (!db.objectStoreNames.contains("articles")) {
        const s = db.createObjectStore("articles", { keyPath: "url" });
        s.createIndex("cachedAt", "cachedAt");
      }
      if (!db.objectStoreNames.contains("notes")) {
        const s = db.createObjectStore("notes", { keyPath: "id" });
        s.createIndex("url", "url");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const p = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function store(name, mode = "readonly") {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const DB = {
  async get(name, key) {
    return p((await store(name)).get(key));
  },
  async all(name) {
    return p((await store(name)).getAll());
  },
  async put(name, value) {
    return p((await store(name, "readwrite")).put(value));
  },
  async del(name, key) {
    return p((await store(name, "readwrite")).delete(key));
  },
  async byIndex(name, index, value) {
    return p((await store(name)).index(index).getAll(value));
  },

  async getSettings() {
    const rows = await this.all("settings");
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  setSetting(key, value) {
    return this.put("settings", { key, value });
  },

  async readIds() {
    return new Set((await this.all("reads")).map((r) => r.id));
  },
  markRead(id) {
    return this.put("reads", { id, at: Date.now() });
  },
  markUnread(id) {
    return this.del("reads", id);
  },
  /** Drop read markers older than two weeks; story ids don't outlive the 48h window anyway. */
  async pruneReads(maxAgeMs = 14 * 864e5) {
    const cutoff = Date.now() - maxAgeMs;
    for (const r of await this.all("reads")) if (r.at < cutoff) await this.del("reads", r.id);
  },
};

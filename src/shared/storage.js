// The library's layout in chrome.storage.local. Version 2 keeps each script under its own key, so saving one script
// doesn't rewrite every other script's source:
//   schemaVersion: 2
//   scriptOrder: [id, ...]          run order
//   script:<id>: { id, name, source, enabled, history, ... }
//   values:<id>, deps:<id>, trash, settings, syncState
// Version 1 (no schemaVersion) kept every script in one `scripts` array.

/** @typedef {import("./types.js").LocalStore} LocalStore */
/** @typedef {import("./types.js").SessionStore} SessionStore */
/** @typedef {import("./types.js").Script} Script */

export const schemaVersion = 2;
export const scriptKey = id => `script:${id}`;
const scriptPrefix = "script:";

// Typed reads from chrome.storage. Every module reads through these so the type checker knows each key's shape.
/** @param {string | string[]} keys @returns {Promise<LocalStore>} */
export function getLocal(keys) {
  return /** @type {Promise<LocalStore>} */ (chrome.storage.local.get(/** @type {any} */ (keys)));
}

/** @param {string | string[]} keys @returns {Promise<SessionStore>} */
export function getSession(keys) {
  return /** @type {Promise<SessionStore>} */ (chrome.storage.session.get(/** @type {any} */ (keys)));
}

/** @param {string} id @returns {Promise<Record<string, unknown>>} */
export async function readValues(id) {
  const key = /** @type {`values:${string}`} */ (`values:${id}`);
  return (await getLocal(key))[key] ?? {};
}

// What this context last read or wrote for each script, so a write can skip the ones that didn't change.
const stored = new Map();

function remember(scripts) {
  stored.clear();
  for (const script of scripts) stored.set(script.id, JSON.stringify(script));
}

/** @returns {Promise<Script[]>} */
export async function readScripts() {
  const { schemaVersion: version, scriptOrder = [], scripts } = await getLocal(["schemaVersion", "scriptOrder", "scripts"]);
  // Pages can open before the service worker finishes migrating, so read the old layout as it is.
  if (!version) return scripts ?? [];
  const records = await getLocal(scriptOrder.map(scriptKey));
  const result = scriptOrder.map(id => records[scriptKey(id)]).filter(Boolean);
  remember(result);
  return result;
}

// Writes the library in one storage call (plus a removal for deleted scripts), together with any other keys in extra.
/** @param {Script[]} scripts @param {Partial<LocalStore>} [extra] */
export async function writeScripts(scripts, extra = {}) {
  const items = { ...extra, schemaVersion, scriptOrder: scripts.map(script => script.id) };
  for (const script of scripts) {
    if (stored.get(script.id) !== JSON.stringify(script)) items[scriptKey(script.id)] = script;
  }
  const removed = [...stored.keys()].filter(id => !scripts.some(script => script.id === id));
  await chrome.storage.local.set(items);
  if (removed.length) await chrome.storage.local.remove(removed.map(scriptKey));
  remember(scripts);
}

/** @returns {Promise<import("./types.js").Settings>} */
export async function readSettings() {
  const { settings = {} } = await getLocal("settings");
  return settings;
}

// Applies a storage.onChanged event to a library a page already holds. Returns null when no script changed.
export function applyScriptChanges(scripts, changes) {
  const keys = Object.keys(changes);
  // The old layout's single key; its removal at the end of the upgrade isn't a change to the library.
  if (changes.scripts?.newValue && !changes.scriptOrder) return changes.scripts.newValue;
  if (!keys.some(key => key === "scriptOrder" || key.startsWith(scriptPrefix))) return null;
  const order = changes.scriptOrder ? changes.scriptOrder.newValue ?? [] : scripts.map(script => script.id);
  const current = new Map(scripts.map(script => [script.id, script]));
  return order.map(id => {
    const change = changes[scriptKey(id)];
    return change ? change.newValue : current.get(id);
  }).filter(Boolean);
}

// Each step upgrades the stored data from the version before it. Steps must be safe to run again after an interruption.
export const migrations = {
  async 2() {
    const { scripts = [] } = await getLocal("scripts");
    await chrome.storage.local.set({
      ...Object.fromEntries(scripts.map(script => [scriptKey(script.id), script])),
      scriptOrder: scripts.map(script => script.id)
    });
    await chrome.storage.local.set({ schemaVersion: 2 });
    await chrome.storage.local.remove("scripts");
  }
};

export async function migrate() {
  const { schemaVersion: from = 1 } = await getLocal("schemaVersion");
  if (from > schemaVersion) throw new Error(`This library was saved by a newer Tailorscript (storage version ${from}).`);
  for (let version = from + 1; version <= schemaVersion; version++) await migrations[version]();
  return { from, to: schemaVersion };
}

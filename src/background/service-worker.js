import { readScripts, readSettings } from "../shared/storage.js";
import { backupToSync } from "../shared/sync-backup.js";
import { parseSource } from "../shared/userscript.js";
import { validate } from "../shared/validate.js";
import { syncScripts } from "./registration.js";

const extensionPages = [chrome.runtime.getURL("manager/index.html"), chrome.runtime.getURL("popup/popup.html")];
const managerTypes = ["sync", "save", "toggle", "delete", "restore", "purge", "import", "move", "label", "settings", "clear-values"];
const settingTypes = { paused: "boolean", reloadAfterSave: "boolean", syncBackup: "boolean", lastExportAt: "number" };
const trashDays = 30;
const historyLimit = 25;
const valueBytes = 1_000_000;
let pending = Promise.resolve();
let runsPending = Promise.resolve();

function enqueue(operation) {
  const result = pending.then(operation);
  pending = result.catch(error => console.warn(error.message));
  return result;
}

// Page loads report often, so runs get their own queue instead of waiting behind saves.
function enqueueRun(operation) {
  runsPending = runsPending.then(operation).catch(error => console.warn(error.message));
}

async function reconcile(scripts) {
  const state = await syncScripts(scripts, await readSettings());
  await chrome.storage.session.set({ registrationState: state });
  return state;
}

async function purgeExpired() {
  const { trash = [] } = await chrome.storage.local.get("trash");
  const cutoff = Date.now() - trashDays * 86_400_000;
  const expired = trash.filter(script => script.deletedAt < cutoff);
  if (!expired.length) return;
  await chrome.storage.local.set({ trash: trash.filter(script => script.deletedAt >= cutoff) });
  await chrome.storage.local.remove(expired.map(script => `values:${script.id}`));
}

async function backup(scripts) {
  const settings = await readSettings();
  if (!settings.syncBackup) return;
  try {
    await chrome.storage.local.set({ syncState: { at: await backupToSync(scripts) } });
  } catch (error) {
    await chrome.storage.local.set({ syncState: { at: Date.now(), error: error.message } });
  }
}

async function commit(scripts, extra = {}) {
  // Keep the editor's saved state durable even if Chrome rejects a registration.
  await chrome.storage.local.set({ scripts, ...extra });
  await backup(scripts);
  return reconcile(scripts);
}

function refresh() {
  enqueue(async () => {
    await purgeExpired();
    return reconcile(await readScripts());
  });
}

chrome.runtime.onInstalled.addListener(refresh);
chrome.runtime.onStartup.addListener(refresh);
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);

function withHistory(current, source) {
  const history = current?.history ?? [];
  return current && current.source !== source
    ? [{ source: current.source, savedAt: Date.now() }, ...history].slice(0, historyLimit)
    : history;
}

const handlers = {
  async sync(message, scripts) {
    await purgeExpired();
    return reconcile(scripts);
  },

  async import({ entries }, scripts) {
    const now = Date.now();
    for (const { source, history, replace } of entries) {
      const { name } = parseSource(source);
      const index = replace ? scripts.findIndex(script => script.id === replace) : -1;
      if (index === -1) {
        scripts.push({ id: crypto.randomUUID(), source, history, enabled: false, name, updatedAt: now });
      } else {
        // Replaced scripts are disabled so imported code is reviewed before it runs.
        const current = scripts[index];
        scripts[index] = { ...current, name, source, enabled: false, history: withHistory(current, source), updatedAt: now };
      }
    }
    return commit(scripts);
  },

  async save(message, scripts, index, current) {
    const { source, enabled } = message.script;
    const { name } = validate(source);
    const script = {
      id: message.id, name, source, enabled,
      history: withHistory(current, source),
      updatedAt: current?.source === source ? current.updatedAt : Date.now()
    };
    if (index === -1) scripts.push(script);
    else scripts[index] = script;
    return commit(scripts);
  },

  async toggle({ enabled }, scripts, index) {
    if (index === -1) throw new Error("This script no longer exists. Reload the manager.");
    scripts[index] = { ...scripts[index], enabled: Boolean(enabled) };
    return commit(scripts);
  },

  async delete(message, scripts, index) {
    if (index === -1) return reconcile(scripts);
    const { trash = [] } = await chrome.storage.local.get("trash");
    const [script] = scripts.splice(index, 1);
    return commit(scripts, { trash: [{ ...script, enabled: false, deletedAt: Date.now() }, ...trash] });
  },

  async restore({ id }, scripts) {
    const { trash = [] } = await chrome.storage.local.get("trash");
    const script = trash.find(item => item.id === id);
    if (!script) throw new Error("This script is no longer in the Trash.");
    const { deletedAt, ...restored } = script;
    return commit([...scripts, restored], { trash: trash.filter(item => item.id !== id) });
  },

  async purge({ id }, scripts) {
    const { trash = [] } = await chrome.storage.local.get("trash");
    const removed = trash.filter(item => !id || item.id === id);
    await chrome.storage.local.set({ trash: trash.filter(item => id && item.id !== id) });
    await chrome.storage.local.remove(removed.map(item => `values:${item.id}`));
    return reconcile(scripts);
  },

  async move({ offset }, scripts, index) {
    const target = index + Math.sign(offset);
    if (index === -1 || target < 0 || target >= scripts.length) return reconcile(scripts);
    [scripts[index], scripts[target]] = [scripts[target], scripts[index]];
    return commit(scripts);
  },

  async label({ savedAt, label }, scripts, index) {
    const version = scripts[index]?.history?.find(item => item.savedAt === savedAt);
    if (!version) throw new Error("This version is no longer in the history.");
    const text = String(label ?? "").trim().slice(0, 80);
    if (text) version.label = text;
    else delete version.label;
    await chrome.storage.local.set({ scripts });
    return reconcile(scripts);
  },

  async settings({ patch }, scripts) {
    const settings = await readSettings();
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (typeof value === settingTypes[key]) settings[key] = value;
    }
    await chrome.storage.local.set({ settings });
    if (patch?.syncBackup) await backup(scripts);
    return reconcile(scripts);
  },

  async "clear-values"({ id }, scripts) {
    await chrome.storage.local.remove(`values:${id}`);
    return reconcile(scripts);
  }
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!extensionPages.includes(sender.url) || !managerTypes.includes(message?.type)) return false;
  enqueue(async () => {
    const scripts = await readScripts();
    const index = scripts.findIndex(script => script.id === message.id);
    const current = scripts[index];
    if (["save", "delete"].includes(message.type)) {
      const expected = message.expected;
      if (Boolean(current) !== Boolean(expected) ||
          (current && (current.source !== expected.source || current.enabled !== expected.enabled))) {
        throw new Error("This script changed in another editor. Reload the manager before saving or deleting it.");
      }
    }
    return handlers[message.type](message, scripts, index, current);
  }).then(state => respond({ ok: true, state }), error => respond({ error: error.message }));
  return true;
});

function text(value, limit) {
  return String(value ?? "").slice(0, limit);
}

function recordRun(id, message, sender) {
  enqueueRun(async () => {
    const { runs = {}, tabRuns = {} } = await chrome.storage.session.get(["runs", "tabRuns"]);
    const at = Date.now();
    const url = text(sender.url, 2000);
    const entry = message.type === "run"
      ? { at, url }
      : { ...runs[id], error: { message: text(message.message, 500), line: Number(message.line) || 0, column: Number(message.column) || 0, at } };
    runs[id] = entry;
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      const tab = tabRuns[tabId] ?? { scripts: {} };
      if (message.type === "run" && sender.frameId === 0 && tab.documentId !== sender.documentId) {
        tab.documentId = sender.documentId;
        tab.scripts = {};
      }
      tab.scripts[id] = message.type === "run" ? { at, url, error: tab.scripts[id]?.error } : { ...tab.scripts[id], error: entry.error };
      tabRuns[tabId] = tab;
    }
    await chrome.storage.session.set({ runs, tabRuns });
  });
}

const valueOperations = { get: "GM.getValue", set: "GM.setValue", delete: "GM.deleteValue", list: "GM.listValues" };

async function handleValue(id, { op, key, value }) {
  const script = (await readScripts()).find(item => item.id === id);
  if (!script?.enabled || !parseSource(script.source).grants.includes(valueOperations[op])) {
    throw new Error(`Add @grant ${valueOperations[op] ?? "GM.getValue"} to use this API.`);
  }
  const storageKey = `values:${id}`;
  const { [storageKey]: values = {} } = await chrome.storage.local.get(storageKey);
  if (op === "list") return Object.keys(values);
  if (typeof key !== "string" || !key || key.length > 256) throw new Error("Value keys must be non-empty strings up to 256 characters.");
  if (op === "get") return values[key];
  if (op === "delete") delete values[key];
  else {
    if (value === undefined || JSON.stringify(value) === undefined) throw new Error("Values must be JSON-compatible.");
    values[key] = value;
    if (JSON.stringify(values).length > valueBytes) throw new Error("This script’s stored values would exceed 1 MB.");
  }
  await chrome.storage.local.set({ [storageKey]: values });
}

// Chrome only exposes this event while Allow User Scripts is on.
chrome.runtime.onUserScriptMessage?.addListener((message, sender, respond) => {
  const id = sender.userScriptWorldId ?? message?.id;
  if (typeof id !== "string") return false;
  if (message?.type === "run" || message?.type === "error") {
    recordRun(id, message, sender);
    return false;
  }
  if (message?.type !== "value") return false;
  enqueue(() => handleValue(id, message))
    .then(value => respond({ value }), error => respond({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => enqueueRun(async () => {
  const { tabRuns = {} } = await chrome.storage.session.get("tabRuns");
  if (!(tabId in tabRuns)) return;
  delete tabRuns[tabId];
  await chrome.storage.session.set({ tabRuns });
}));

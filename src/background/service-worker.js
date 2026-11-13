import { readScripts, readSettings } from "../shared/storage.js";
import { backupToSync } from "../shared/sync-backup.js";
import { addMetadata, allows, parseSource, syncValueGrants } from "../shared/userscript.js";
import { validate } from "../shared/validate.js";
import { resolveDeps, toBase64 } from "./dependencies.js";
import { injectionFor, syncScripts } from "./registration.js";
import { fetchUpdate, reviewReasons, sourceHash, updateUrls } from "./updates.js";

const extensionPages = ["manager/index.html", "popup/popup.html", "install/install.html"].map(path => chrome.runtime.getURL(path));
const settingTypes = { paused: "boolean", reloadAfterSave: "boolean", syncBackup: "boolean", lastExportAt: "number" };
const trashDays = 30;
const historyLimit = 25;
const valueBytes = 1_000_000;
const responseBytes = 32_000_000;
const updateMinutes = 720;
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

function ignore() {}

function showPaused(paused) {
  chrome.action?.setBadgeText({ text: paused ? "off" : "" }).catch(ignore);
  if (paused) chrome.action?.setBadgeBackgroundColor({ color: "#5a6b6e" }).catch(ignore);
}

async function reconcile(scripts) {
  const settings = await readSettings();
  const state = await syncScripts(scripts, settings);
  await chrome.storage.session.set({ registrationState: state });
  showPaused(settings.paused);
  return state;
}

async function purgeExpired() {
  const { trash = [] } = await chrome.storage.local.get("trash");
  const cutoff = Date.now() - trashDays * 86_400_000;
  const expired = trash.filter(script => script.deletedAt < cutoff);
  if (!expired.length) return;
  await chrome.storage.local.set({ trash: trash.filter(script => script.deletedAt >= cutoff) });
  await chrome.storage.local.remove(expired.flatMap(script => [`values:${script.id}`, `deps:${script.id}`]));
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

// .user.js links on sites Tailorscript can access open the install page instead of showing raw code.
async function setupInstallRedirect() {
  await chrome.declarativeNetRequest?.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: "redirect", redirect: { regexSubstitution: `${chrome.runtime.getURL("install/install.html")}#\\0` } },
      condition: { regexFilter: "^https?://[^?#]*\\.user\\.js$", resourceTypes: ["main_frame"] }
    }]
  });
}

async function scheduleUpdates() {
  if (!chrome.alarms || await chrome.alarms.get("updates")) return;
  await chrome.alarms.create("updates", { delayInMinutes: 5, periodInMinutes: updateMinutes });
}

function refresh() {
  enqueue(async () => {
    await purgeExpired();
    return reconcile(await readScripts());
  });
  scheduleUpdates().catch(error => console.warn(error.message));
}

chrome.runtime.onInstalled.addListener(() => {
  refresh();
  setupInstallRedirect().catch(error => console.warn(error.message));
});
chrome.runtime.onStartup.addListener(refresh);
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);

function withHistory(current, source) {
  const history = current?.history ?? [];
  return current && current.source !== source
    ? [{ source: current.source, savedAt: Date.now() }, ...history].slice(0, historyLimit)
    : history;
}

async function storedDeps(id) {
  if (!id) return undefined;
  const key = `deps:${id}`;
  return (await chrome.storage.local.get(key))[key];
}

// Downloads happen before a message joins the write queue, so a slow CDN never blocks other saves.
const preparers = {
  async save({ id, script }) {
    return { deps: await resolveDeps(parseSource(script.source), await storedDeps(id)) };
  },
  async install({ id, source }) {
    return { deps: await resolveDeps(validate(source), await storedDeps(id)) };
  },
  async import({ entries }) {
    return {
      deps: await Promise.all(entries.map(async ({ source, replace }) => {
        try {
          return await resolveDeps(parseSource(source), await storedDeps(replace));
        } catch (error) {
          return { error: `${error.message} Save the script to try again.` };
        }
      }))
    };
  },
  async "apply-update"({ id }) {
    const script = (await readScripts()).find(item => item.id === id);
    if (!script?.pendingUpdate) throw new Error("There’s no update waiting for this script.");
    return { source: script.pendingUpdate.source, deps: await resolveDeps(parseSource(script.pendingUpdate.source), await storedDeps(id)) };
  }
};

const handlers = {
  async sync(message, scripts) {
    await purgeExpired();
    return reconcile(scripts);
  },

  async import({ entries }, scripts, index, current, { deps }) {
    const now = Date.now();
    const extra = {};
    entries.forEach(({ source, history, replace }, position) => {
      const { name } = parseSource(source);
      const at = replace ? scripts.findIndex(script => script.id === replace) : -1;
      let id;
      if (at === -1) {
        id = crypto.randomUUID();
        scripts.push({ id, source, history, enabled: false, name, updatedAt: now });
      } else {
        // Replaced scripts are disabled so imported code is reviewed before it runs.
        const previous = scripts[at];
        id = previous.id;
        scripts[at] = { ...previous, name, source, enabled: false, history: withHistory(previous, source), updatedAt: now };
      }
      extra[`deps:${id}`] = deps[position];
    });
    return commit(scripts, extra);
  },

  async save(message, scripts, index, current, { deps }) {
    const { source, enabled } = message.script;
    const { name } = validate(source);
    const script = {
      ...current,
      id: message.id, name, source, enabled,
      history: withHistory(current, source),
      updatedAt: current?.source === source ? current.updatedAt : Date.now()
    };
    if (index === -1) scripts.push(script);
    else scripts[index] = script;
    return commit(scripts, { [`deps:${message.id}`]: deps });
  },

  async install({ source, url, enabled, autoUpdate }, scripts, index, current, { deps }) {
    if (!/^https?:\/\//.test(url ?? "")) throw new Error("Scripts can only be installed from http or https addresses.");
    const { name } = validate(source);
    const id = current?.id ?? crypto.randomUUID();
    const now = Date.now();
    const { pendingUpdate, ...previous } = current ?? {};
    const script = {
      ...previous,
      id, name, source,
      enabled: Boolean(enabled),
      history: withHistory(current, source),
      updatedAt: now,
      installUrl: url,
      installedHash: await sourceHash(source),
      autoUpdate: autoUpdate !== false,
      updateCheck: { at: now }
    };
    if (index === -1) scripts.push(script);
    else scripts[index] = script;
    return { ...await commit(scripts, { [`deps:${id}`]: deps }), installedId: id };
  },

  async "apply-update"({ id }, scripts, index, current, prepared) {
    if (current?.pendingUpdate?.source !== prepared.source) throw new Error("This update changed. Check for updates again.");
    const { pendingUpdate, ...script } = current;
    scripts[index] = {
      ...script,
      name: parseSource(pendingUpdate.source).name,
      source: pendingUpdate.source,
      history: withHistory(current, pendingUpdate.source),
      updatedAt: Date.now(),
      installedHash: await sourceHash(pendingUpdate.source),
      updateCheck: { at: Date.now() }
    };
    return commit(scripts, { [`deps:${id}`]: prepared.deps });
  },

  async "dismiss-update"(message, scripts, index, current) {
    if (!current?.pendingUpdate) return reconcile(scripts);
    const { pendingUpdate, ...script } = current;
    scripts[index] = { ...script, updateCheck: { ...script.updateCheck, skipped: pendingUpdate.version } };
    return commit(scripts);
  },

  async "auto-update"({ enabled }, scripts, index, current) {
    if (!current) throw new Error("This script no longer exists. Reload the manager.");
    scripts[index] = { ...current, autoUpdate: Boolean(enabled) };
    return commit(scripts);
  },

  async "exclude-site"({ host }, scripts, index, current) {
    if (!current) throw new Error("This script no longer exists.");
    if (!/^[a-z\d.-]+$/i.test(host ?? "")) throw new Error("That isn’t a site Tailorscript can exclude.");
    const source = addMetadata(current.source, "exclude-match", `*://${host.toLowerCase()}/*`);
    validate(source);
    scripts[index] = { ...current, source, history: withHistory(current, source), updatedAt: Date.now() };
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
    await chrome.storage.local.remove(removed.flatMap(item => [`values:${item.id}`, `deps:${item.id}`]));
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

// Network checks run outside the queue; the results are applied in one queued write.
async function checkUpdates(ids, { manual = false } = {}) {
  const scripts = (await readScripts()).filter(script => (!ids || ids.includes(script.id)) &&
    (manual || script.autoUpdate !== false) && (() => {
      try {
        return Boolean(updateUrls(script).check);
      } catch {
        return false;
      }
    })());
  const results = [];
  for (const script of scripts) {
    const result = { id: script.id, source: script.source };
    try {
      result.found = await fetchUpdate(script);
      if (result.found?.source) {
        const edited = Boolean(script.installedHash) && script.installedHash !== await sourceHash(script.source);
        result.reasons = reviewReasons(parseSource(script.source), result.found.metadata, { edited, autoUpdate: script.autoUpdate });
        if (!result.reasons.length) {
          try {
            result.deps = await resolveDeps(result.found.metadata, await storedDeps(script.id));
          } catch (error) {
            result.reasons.push(error.message);
          }
        }
      }
    } catch (error) {
      result.error = error.message;
    }
    results.push(result);
  }

  return enqueue(async () => {
    const latest = await readScripts();
    const extra = {};
    const summary = { checked: 0, updated: [], waiting: [], failed: [] };
    const now = Date.now();
    for (const result of results) {
      const index = latest.findIndex(script => script.id === result.id);
      if (index === -1 || latest[index].source !== result.source) continue;
      const { pendingUpdate, ...script } = latest[index];
      summary.checked++;
      script.updateCheck = { at: now, skipped: script.updateCheck?.skipped,
        ...(result.found?.version ? { latest: result.found.version } : {}), ...(result.error ? { error: result.error } : {}) };
      if (result.error) {
        summary.failed.push(script.name);
        if (pendingUpdate) script.pendingUpdate = pendingUpdate;
      } else if (result.deps) {
        Object.assign(script, {
          source: result.found.source, name: result.found.metadata.name, history: withHistory(latest[index], result.found.source),
          updatedAt: now, installedHash: await sourceHash(result.found.source)
        });
        extra[`deps:${script.id}`] = result.deps;
        summary.updated.push(script.name);
      } else if (result.found?.source) {
        script.pendingUpdate = { source: result.found.source, version: result.found.version, reasons: result.reasons, foundAt: now };
        summary.waiting.push(script.name);
      }
      latest[index] = script;
    }
    return { ...await commit(latest, extra), updateSummary: summary };
  });
}

chrome.alarms?.onAlarm.addListener(alarm => {
  if (alarm.name === "updates") checkUpdates(null).catch(error => console.warn(error.message));
});

// Runs a stored script once in a tab, whether or not it is enabled or matches the page.
async function runNow({ id, tabId }) {
  const script = (await readScripts()).find(item => item.id === id);
  if (!script) throw new Error("This script no longer exists.");
  const { metadata, js, world, worldId } = await injectionFor(script);
  await chrome.userScripts.execute({
    target: { tabId, allFrames: metadata.allFrames }, js, world, ...(worldId ? { worldId } : {}), injectImmediately: true
  });
  return chrome.storage.session.get("registrationState").then(({ registrationState }) => registrationState);
}

function callInPage({ tabId, documentId, frameId = 0 }, scriptId, kind, callbackId) {
  return chrome.userScripts.execute({
    target: { tabId, ...(documentId ? { documentIds: [documentId] } : { frameIds: [frameId] }) },
    world: "USER_SCRIPT",
    worldId: scriptId,
    js: [{ code: `globalThis[Symbol.for("tailorscript.callback")]?.(${JSON.stringify(kind)}, ${JSON.stringify(callbackId)});` }]
  });
}

async function runMenuCommand({ tabId, id, commandId }) {
  const { tabRuns = {} } = await chrome.storage.session.get("tabRuns");
  const command = tabRuns[tabId]?.menus?.[id]?.find(item => item.commandId === commandId);
  if (!command) throw new Error("This command is no longer available. Reload the page.");
  await callInPage({ tabId, documentId: command.documentId, frameId: command.frameId }, id, "menu", commandId);
}

// Messages that do network or tab work answer directly instead of waiting in the write queue.
const direct = {
  "check-updates": ({ id }) => checkUpdates(id ? [id] : null, { manual: true }),
  "run-now": runNow,
  "menu-run": runMenuCommand
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!extensionPages.includes(sender.url?.replace(/[?#].*$/, "")) || typeof message?.type !== "string") return false;
  let result;
  if (direct[message.type]) {
    result = direct[message.type](message);
  } else if (handlers[message.type]) {
    result = (preparers[message.type]?.(message) ?? Promise.resolve({})).then(prepared => enqueue(async () => {
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
      return handlers[message.type](message, scripts, index, current, prepared);
    }));
  } else {
    return false;
  }
  result.then(state => respond({ ok: true, state }), error => respond({ error: error.message }));
  return true;
});

function text(value, limit) {
  return String(value ?? "").slice(0, limit);
}

function updateBadge(tabId, tab) {
  const entries = Object.values(tab?.scripts ?? {});
  chrome.action?.setBadgeText({ tabId, text: entries.length ? String(entries.length) : "" }).catch(ignore);
  chrome.action?.setBadgeBackgroundColor({ tabId, color: entries.some(entry => entry.error) ? "#b42318" : "#0a7066" }).catch(ignore);
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
      const tab = tabRuns[tabId] ?? { scripts: {}, menus: {}, startedAt: at };
      if (message.type === "run" && sender.frameId === 0 && tab.documentId !== sender.documentId) {
        Object.assign(tab, { documentId: sender.documentId, scripts: {}, menus: {}, startedAt: at });
      }
      tab.scripts[id] = message.type === "run" ? { at, url, error: tab.scripts[id]?.error } : { ...tab.scripts[id], error: entry.error };
      tabRuns[tabId] = tab;
      updateBadge(tabId, tab);
    }
    await chrome.storage.session.set({ runs, tabRuns });
  });
}

function recordMenu(id, { op, commandId, caption }, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined || typeof commandId !== "string") return;
  enqueueRun(async () => {
    const { tabRuns = {} } = await chrome.storage.session.get("tabRuns");
    const tab = tabRuns[tabId] ?? { scripts: {}, menus: {}, startedAt: Date.now() };
    tab.menus ??= {};
    const others = (tab.menus[id] ?? []).filter(item => item.commandId !== commandId || item.documentId !== sender.documentId);
    tab.menus[id] = op === "add"
      ? [...others, { commandId, caption: text(caption, 120), frameId: sender.frameId ?? 0, documentId: sender.documentId }].slice(-50)
      : others;
    tabRuns[tabId] = tab;
    await chrome.storage.session.set({ tabRuns });
  });
}

async function grantedScript(id, family, api) {
  const script = (await readScripts()).find(item => item.id === id);
  const metadata = script && parseSource(script.source);
  if (!metadata || !allows(metadata.grants, family)) throw new Error(`Add @grant ${api} to use this API.`);
  return { script, metadata };
}

const valueOperations = { get: ["getValue", "GM.getValue"], set: ["setValue", "GM.setValue"], delete: ["deleteValue", "GM.deleteValue"], list: ["listValues", "GM.listValues"] };

async function handleValue(id, { op, key, value }) {
  if (!valueOperations[op]) throw new Error("Unknown value operation.");
  const { metadata } = await grantedScript(id, ...valueOperations[op]);
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
  // Synchronous getters read a snapshot baked into the registration, so refresh it for the next page load.
  if (metadata.grants.some(grant => syncValueGrants.includes(grant))) scheduleSnapshot();
}

let snapshotTimer;
function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => enqueue(async () => reconcile(await readScripts())), 1000);
}

function connectAllowed(connects, target, pageUrl) {
  let page = "";
  try {
    page = new URL(pageUrl).hostname;
  } catch {
    // Requests from frames without a URL can still use @connect.
  }
  if (target.hostname === page) return true;
  return connects.some(value => {
    const host = value.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[:/].*$/, "");
    return host === "*" || target.hostname === host || target.hostname.endsWith(`.${host}`);
  });
}

const requests = new Map();

async function handleXhr(id, { requestId, request }, sender) {
  const { metadata } = await grantedScript(id, "xhr", "GM_xmlhttpRequest");
  const url = new URL(request?.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("GM_xmlhttpRequest only supports http and https URLs.");
  if (!connectAllowed(metadata.connects, url, sender.url)) throw new Error(`Add // @connect ${url.hostname} to request this site.`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    try {
      headers.set(name, String(value));
    } catch {
      // Chrome rejects some header names; skip them like a browser would.
    }
  }
  const method = String(request.method || "GET").toUpperCase();
  let body;
  if (request.body && !["GET", "HEAD"].includes(method)) {
    body = request.body.text ?? Uint8Array.from(atob(request.body.base64), char => char.charCodeAt(0));
    if (request.body.contentType && !headers.has("content-type")) headers.set("content-type", request.body.contentType);
  }
  const controller = new AbortController();
  requests.set(requestId, controller);
  const timer = request.timeout > 0 ? setTimeout(() => controller.abort(new Error(`Timed out after ${request.timeout} ms.`)), request.timeout) : 0;
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal, credentials: request.anonymous ? "omit" : "include" });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > responseBytes) throw new Error("The response is larger than 32 MB.");
    return {
      status: response.status,
      statusText: response.statusText,
      finalUrl: response.url,
      responseHeaders: [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\r\n"),
      contentType: request.overrideMimeType || response.headers.get("content-type") || "",
      body: toBase64(bytes)
    };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Aborted.");
    throw new Error(`Request to ${url.host} failed: ${error.message}`, { cause: error });
  } finally {
    clearTimeout(timer);
    requests.delete(requestId);
  }
}

async function handleNotify(id, { callbackId, notification }, sender) {
  const { metadata } = await grantedScript(id, "notification", "GM_notification");
  const notificationId = `ts:${crypto.randomUUID()}`;
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: text(notification?.title || metadata.name, 100),
    message: text(notification?.text, 500) || metadata.name,
    silent: Boolean(notification?.silent)
  });
  const { notifications = {} } = await chrome.storage.session.get("notifications");
  notifications[notificationId] = {
    scriptId: id, callbackId: String(callbackId), tabId: sender.tab?.id, documentId: sender.documentId,
    frameId: sender.frameId, highlight: Boolean(notification?.highlight)
  };
  await chrome.storage.session.set({ notifications });
  if (notification?.timeout > 0) setTimeout(() => chrome.notifications.clear(notificationId), Math.min(notification.timeout, 600_000));
}

async function takeNotification(notificationId) {
  const { notifications = {} } = await chrome.storage.session.get("notifications");
  const entry = notifications[notificationId];
  if (!entry) return null;
  delete notifications[notificationId];
  await chrome.storage.session.set({ notifications });
  return entry;
}

chrome.notifications?.onClicked.addListener(async notificationId => {
  const { notifications = {} } = await chrome.storage.session.get("notifications");
  const entry = notifications[notificationId];
  if (!entry || entry.tabId === undefined) return;
  if (entry.highlight) chrome.tabs.update(entry.tabId, { active: true }).catch(ignore);
  await callInPage(entry, entry.scriptId, "notification-click", entry.callbackId).catch(ignore);
  chrome.notifications.clear(notificationId);
});
chrome.notifications?.onClosed.addListener(async notificationId => {
  const entry = await takeNotification(notificationId);
  if (entry?.tabId !== undefined) await callInPage(entry, entry.scriptId, "notification-done", entry.callbackId).catch(ignore);
});

async function handleOpenTab(id, { url, active }, sender) {
  await grantedScript(id, "openInTab", "GM_openInTab");
  if (!/^https?:\/\//.test(url ?? "")) throw new Error("GM_openInTab only opens http and https URLs.");
  const tab = await chrome.tabs.create({
    url, active: active !== false,
    ...(sender.tab ? { openerTabId: sender.tab.id, index: sender.tab.index + 1, windowId: sender.tab.windowId } : {})
  });
  const { openedTabs = {} } = await chrome.storage.session.get("openedTabs");
  openedTabs[tab.id] = id;
  await chrome.storage.session.set({ openedTabs });
  return tab.id;
}

async function handleCloseTab(id, { tabId }) {
  const { openedTabs = {} } = await chrome.storage.session.get("openedTabs");
  if (openedTabs[tabId] !== id) throw new Error("Scripts can only close tabs they opened.");
  await chrome.tabs.remove(tabId);
}

const scriptHandlers = {
  value: (id, message) => enqueue(() => handleValue(id, message)),
  xhr: handleXhr,
  notify: handleNotify,
  "open-tab": handleOpenTab,
  "close-tab": handleCloseTab
};

// Chrome only exposes this event while Allow User Scripts is on.
chrome.runtime.onUserScriptMessage?.addListener((message, sender, respond) => {
  const id = sender.userScriptWorldId ?? message?.id;
  if (typeof id !== "string") return false;
  if (message?.type === "run" || message?.type === "error") {
    recordRun(id, message, sender);
    return false;
  }
  if (message?.type === "menu") {
    recordMenu(id, message, sender);
    return false;
  }
  if (message?.type === "xhr-abort") {
    requests.get(message.requestId)?.abort(new Error("Aborted."));
    return false;
  }
  const handler = scriptHandlers[message?.type];
  if (!handler) return false;
  Promise.resolve().then(() => handler(id, message, sender))
    .then(value => respond({ value }), error => respond({ error: error.message }));
  return true;
});

// Badges and menus belong to one document. A navigation clears them unless the new page already reported.
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  enqueueRun(async () => {
    const { tabRuns = {} } = await chrome.storage.session.get("tabRuns");
    const tab = tabRuns[tabId];
    if (!tab || Date.now() - (tab.startedAt ?? 0) < 1500) return;
    tabRuns[tabId] = { scripts: {}, menus: {}, startedAt: 0 };
    updateBadge(tabId, tabRuns[tabId]);
    await chrome.storage.session.set({ tabRuns });
  });
});

chrome.tabs.onRemoved.addListener(tabId => enqueueRun(async () => {
  const { tabRuns = {}, openedTabs = {} } = await chrome.storage.session.get(["tabRuns", "openedTabs"]);
  if (!(tabId in tabRuns) && !(tabId in openedTabs)) return;
  delete tabRuns[tabId];
  delete openedTabs[tabId];
  await chrome.storage.session.set({ tabRuns, openedTabs });
}));

chrome.commands?.onCommand.addListener(command => {
  if (command !== "toggle-pause") return;
  enqueue(async () => {
    const settings = await readSettings();
    await chrome.storage.local.set({ settings: { ...settings, paused: !settings.paused } });
    return reconcile(await readScripts());
  });
});

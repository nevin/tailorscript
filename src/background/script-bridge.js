// Services userscripts reach through messages: values, requests, notifications, tabs, run reports and menu commands.
import { getSession, readScripts, readValues } from "../shared/storage.js";
import { allows, parseSource, syncValueGrants } from "../shared/userscript.js";
import { toBase64 } from "./dependencies.js";
import { reconcile } from "./library.js";
import { enqueue, enqueueRun, ignore } from "./queue.js";
import { callInPage } from "./tab-actions.js";

const valueBytes = 1_000_000;
const responseBytes = 32_000_000;

function text(value, limit) {
  return String(value ?? "").slice(0, limit);
}

export function updateBadge(tabId, tab) {
  const entries = Object.values(tab?.scripts ?? {});
  chrome.action?.setBadgeText({ tabId, text: entries.length ? String(entries.length) : "" }).catch(ignore);
  chrome.action?.setBadgeBackgroundColor({ tabId, color: entries.some(entry => entry.error) ? "#b42318" : "#0a7066" }).catch(ignore);
}

export function recordRun(id, message, sender) {
  enqueueRun(async () => {
    const { runs = {}, tabRuns = {} } = await getSession(["runs", "tabRuns"]);
    const at = Date.now();
    const url = text(sender.url, 2000);
    /** @type {{ at?: number, url?: string, error?: import("../shared/types.js").RunError }} */
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

export function recordMenu(id, { op, commandId, caption }, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  enqueueRun(async () => {
    const { tabRuns = {} } = await getSession("tabRuns");
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
  if (!Object.hasOwn(valueOperations, op)) throw new Error("Unknown value operation.");
  const { metadata } = await grantedScript(id, ...valueOperations[op]);
  const storageKey = `values:${id}`;
  const values = await readValues(id);
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

export function connectAllowed(connects, target, pageUrl) {
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
  const url = new URL(request.url);
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
    // A redirect can lead anywhere, so the final address must also be one the script may reach.
    const final = new URL(response.url || url);
    if (!connectAllowed(metadata.connects, final, sender.url)) {
      throw new Error(`The request was redirected to ${final.hostname}. Add // @connect ${final.hostname} to allow it.`);
    }
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
    if (error.message.startsWith("The request was redirected")) throw error;
    throw new Error(`Request to ${url.host} failed: ${error.message}`, { cause: error });
  } finally {
    clearTimeout(timer);
    requests.delete(requestId);
  }
}

export function abortRequest(requestId) {
  requests.get(requestId)?.abort(new Error("Aborted."));
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
  const { notifications = {} } = await getSession("notifications");
  notifications[notificationId] = {
    scriptId: id, callbackId, tabId: sender.tab?.id, documentId: sender.documentId,
    frameId: sender.frameId, highlight: Boolean(notification?.highlight)
  };
  await chrome.storage.session.set({ notifications });
  if (notification?.timeout > 0) setTimeout(() => chrome.notifications.clear(notificationId), Math.min(notification.timeout, 600_000));
}

async function takeNotification(notificationId) {
  const { notifications = {} } = await getSession("notifications");
  const entry = notifications[notificationId];
  if (!entry) return null;
  delete notifications[notificationId];
  await chrome.storage.session.set({ notifications });
  return entry;
}

export async function notificationClicked(notificationId) {
  const { notifications = {} } = await getSession("notifications");
  const entry = notifications[notificationId];
  if (!entry || entry.tabId === undefined) return;
  if (entry.highlight) chrome.tabs.update(entry.tabId, { active: true }).catch(ignore);
  await callInPage(entry, entry.scriptId, "notification-click", entry.callbackId).catch(ignore);
  chrome.notifications.clear(notificationId);
}

export async function notificationClosed(notificationId) {
  const entry = await takeNotification(notificationId);
  if (entry?.tabId !== undefined) await callInPage(entry, entry.scriptId, "notification-done", entry.callbackId).catch(ignore);
}

async function handleOpenTab(id, { url, active }, sender) {
  await grantedScript(id, "openInTab", "GM_openInTab");
  if (!/^https?:\/\//.test(url)) throw new Error("GM_openInTab only opens http and https URLs.");
  const tab = await chrome.tabs.create({
    url, active: active !== false,
    ...(sender.tab ? { openerTabId: sender.tab.id, index: sender.tab.index + 1, windowId: sender.tab.windowId } : {})
  });
  const { openedTabs = {} } = await getSession("openedTabs");
  openedTabs[tab.id] = id;
  await chrome.storage.session.set({ openedTabs });
  return tab.id;
}

async function handleCloseTab(id, { tabId }) {
  const { openedTabs = {} } = await getSession("openedTabs");
  if (openedTabs[tabId] !== id) throw new Error("Scripts can only close tabs they opened.");
  await chrome.tabs.remove(tabId);
}

// Messages a script awaits an answer to.
export const scriptHandlers = {
  value: (id, message) => enqueue(() => handleValue(id, message)),
  xhr: handleXhr,
  notify: handleNotify,
  "open-tab": handleOpenTab,
  "close-tab": handleCloseTab
};

// Badges and menus belong to one document. A navigation clears them unless the new page already reported.
export function tabLoading(tabId) {
  enqueueRun(async () => {
    const { tabRuns = {} } = await getSession("tabRuns");
    const tab = tabRuns[tabId];
    if (!tab || Date.now() - (tab.startedAt ?? 0) < 1500) return;
    tabRuns[tabId] = { scripts: {}, menus: {}, startedAt: 0 };
    updateBadge(tabId, tabRuns[tabId]);
    await chrome.storage.session.set({ tabRuns });
  });
}

export function tabRemoved(tabId) {
  enqueueRun(async () => {
    const { tabRuns = {}, openedTabs = {} } = await getSession(["tabRuns", "openedTabs"]);
    if (!(tabId in tabRuns) && !(tabId in openedTabs)) return;
    delete tabRuns[tabId];
    delete openedTabs[tabId];
    await chrome.storage.session.set({ tabRuns, openedTabs });
  });
}

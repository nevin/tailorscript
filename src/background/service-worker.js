// Wires Chrome's events to the background modules. Each message is checked against shared/messages.js first.
import { checkMessage, pageMessages, scriptMessages } from "../shared/messages.js";
import { migrate, readScripts, readSettings } from "../shared/storage.js";
import { authenticate } from "./bridge-token.js";
import { collectDiagnostics } from "./diagnostics.js";
import { enablePending, handlers, preparers, purgeExpired, reconcile } from "./library.js";
import { enqueue, ignore } from "./queue.js";
import {
  abortRequest, notificationClicked, notificationClosed, recordMenu, recordRun, scriptHandlers, tabLoading, tabRemoved
} from "./script-bridge.js";
import { runMenuCommand, runNow } from "./tab-actions.js";
import { checkUpdates, scheduleUpdates } from "./update-check.js";

const extensionPages = ["manager/index.html", "popup/popup.html", "install/install.html"].map(path => chrome.runtime.getURL(path));

// Every queued operation waits for the storage upgrade, so nothing reads the library half-migrated.
const migrated = migrate().catch(error => console.error(`Storage upgrade failed: ${error.message}`));
enqueue(() => migrated);

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
chrome.permissions.onAdded.addListener(() => {
  enqueue(enablePending).catch(error => console.warn(error.message));
  refresh();
});
chrome.permissions.onRemoved.addListener(refresh);

chrome.alarms?.onAlarm.addListener(alarm => {
  if (alarm.name === "updates") checkUpdates(null).catch(error => console.warn(error.message));
});

// Messages that do network or tab work answer directly instead of waiting in the write queue.
const direct = {
  "check-updates": ({ id }) => checkUpdates(id ? [id] : null, { manual: true }),
  "run-now": runNow,
  "menu-run": runMenuCommand,
  diagnostics: collectDiagnostics
};

// Saving or deleting compares against the copy the editor loaded, so one tab can't overwrite another's changes.
function checkExpected(message, current) {
  if (!["save", "delete"].includes(message.type)) return;
  const { expected } = message;
  if (Boolean(current) !== Boolean(expected) ||
      (current && (current.source !== expected.source || current.enabled !== expected.enabled))) {
    throw new Error("This script changed in another editor. Reload the manager before saving or deleting it.");
  }
}

function handlePageMessage(message) {
  checkMessage(pageMessages, message);
  if (direct[message.type]) return migrated.then(() => direct[message.type](message));
  return migrated.then(() => preparers[message.type]?.(message) ?? {}).then(prepared => enqueue(async () => {
    const scripts = await readScripts();
    const index = scripts.findIndex(script => script.id === message.id);
    const current = scripts[index];
    checkExpected(message, current);
    return handlers[message.type](message, scripts, index, current, prepared);
  }));
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!extensionPages.includes(sender.url?.replace(/[?#].*$/, "")) || !Object.hasOwn(pageMessages, message?.type)) return false;
  Promise.resolve().then(() => handlePageMessage(message))
    .then(state => respond({ ok: true, state }), error => respond({ error: error.message }));
  return true;
});

// Reports a script sends without waiting for an answer.
const scriptReports = {
  run: recordRun,
  error: recordRun,
  menu: recordMenu,
  "xhr-abort": (id, { requestId }) => abortRequest(requestId)
};

// Chrome only exposes this event while Allow User Scripts is on.
chrome.runtime.onUserScriptMessage?.addListener((message, sender, respond) => {
  const expectsReply = Object.hasOwn(scriptHandlers, message?.type);
  // The token shows which script is asking, so one script can't act as another (see bridge-token.js).
  const result = authenticate(message).then(id => {
    checkMessage(scriptMessages, message);
    if (scriptReports[message.type]) return scriptReports[message.type](id, message, sender);
    return scriptHandlers[message.type](id, message, sender);
  });
  if (expectsReply) result.then(value => respond({ value }), error => respond({ error: error.message }));
  else result.catch(ignore);
  return expectsReply;
});

chrome.notifications?.onClicked.addListener(notificationClicked);
chrome.notifications?.onClosed.addListener(notificationClosed);
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") tabLoading(tabId);
});
chrome.tabs.onRemoved.addListener(tabRemoved);

chrome.commands?.onCommand.addListener(command => {
  if (command !== "toggle-pause") return;
  enqueue(async () => {
    const settings = await readSettings();
    await chrome.storage.local.set({ settings: { ...settings, paused: !settings.paused } });
    return reconcile(await readScripts());
  });
});

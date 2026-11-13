import { $ } from "../shared/dom.js";
import { timeAgo } from "../shared/format.js";
import { applyScriptChanges, getLocal, getSession, readScripts } from "../shared/storage.js";
import { allows, parseSource, runsOn, targetsMatch, updateTargets } from "../shared/userscript.js";
import { validate } from "../shared/validate.js";
import { createCodeEditor } from "./code-editor.js";
import { setupDialogs } from "./dialogs.js";
import { templates } from "./templates.js";
import { element, makeButton, openReview, review } from "./ui.js";
import { setupUpdates } from "./updates-ui.js";

const starter = `// ==UserScript==
// @name        Highlight example heading
// @match       https://example.com/*
// @run-at      document-idle
// @grant       none
// ==/UserScript==

document.querySelector("h1")?.style.setProperty("color", "rebeccapurple");`;

const list = $("#scripts");
const form = $("main form", HTMLFormElement);
const cursorPosition = $("#cursor-position");
const saveButton = $("#save", HTMLButtonElement);
const isMac = /** @type {any} */ (navigator).userAgentData?.platform === "macOS" || navigator.platform.startsWith("Mac");
const modifierLabel = isMac ? "⌘" : "Ctrl+";
for (const key of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-shortcut]"))) key.textContent = modifierLabel + key.dataset.shortcut;
saveButton.setAttribute("aria-keyshortcuts", isMac ? "Meta+S" : "Control+S");

const enabled = $("#enabled", HTMLInputElement);
const status = $("#status");
const newButton = $("#new", HTMLButtonElement);
const deleteButton = $("#delete", HTMLButtonElement);
const historyButton = $("#history", HTMLButtonElement);
const valuesButton = $("#values", HTMLButtonElement);
const trashButton = $("#trash", HTMLButtonElement);
const updatesButton = $("#updates", HTMLButtonElement);
const exportButton = $("#export", HTMLButtonElement);
const backupState = $("#backup-state");
const diagnosticUrl = $("#diagnostic-url", HTMLInputElement);
const diagnosticMessage = $("#diagnostic-message");
const diagnosticResults = $("#diagnostic-results");
const validation = $("#validation", HTMLButtonElement);
const runState = $("#run-state");
const pauseAll = $("#pause-all", HTMLInputElement);
const pausedBanner = $("#paused-banner");
const orderControls = $("#order-controls");
const orderLabel = $("#order-label");
const moveUp = $("#move-up", HTMLButtonElement);
const moveDown = $("#move-down", HTMLButtonElement);
const setupBanner = $("#setup-banner");

const search = $("#search", HTMLInputElement);
// Status filter chips are radio buttons; this keeps the select-style .value interface the library code reads.
const filter = {
  get value() {
    return $('input[name="filter"]:checked', HTMLInputElement).value;
  },
  set value(next) {
    $(`input[name="filter"][value="${next}"]`, HTMLInputElement).checked = true;
  }
};
const tagFilter = $("#tag", HTMLSelectElement);
const sort = $("#sort", HTMLSelectElement);
const empty = $("#library-empty");
const title = $("#script-title");
const draftState = $("#draft-state");
const scriptState = $("#script-state");
const targets = $("#targets");
const setup = $("#setup", HTMLDetailsElement);
const setupName = $("#setup-name", HTMLInputElement);
const setupSites = $("#setup-sites", HTMLTextAreaElement);
const inspect = $("#inspect", HTMLButtonElement);
const diagnostics = $("#diagnostics");

/** @type {import("../shared/types.js").Script[]} */
let scripts = [];
/** @type {import("../shared/types.js").TrashedScript[]} */
let trash = [];
/** @type {import("../shared/types.js").Settings} */
let settings = {};
/** @type {import("../shared/types.js").LocalStore["syncState"]} */
let syncState;
/** @type {import("../shared/types.js").SessionStore["runs"]} */
let runs = {};
let selectedId;
// The stored record the editor was loaded from; saves send it so the worker can reject edits made elsewhere.
let loaded;
let draftBaseline = starter;
let busy = false;
/** @type {import("../shared/types.js").RegistrationState | undefined} */
let registrationState;

function registrationMessage(id) {
  return registrationState?.error || registrationState?.issues[id] || "";
}

function metadataFor(script) {
  try {
    return parseSource(script.source);
  } catch {
    return null;
  }
}

function runSummary(id) {
  const run = runs[id];
  if (!run) return null;
  if (run.error) {
    return { state: "error", text: `Error${run.error.line ? ` on line ${run.error.line}` : ""}: ${run.error.message} · ${timeAgo(run.error.at)}` };
  }
  return { state: "ran", text: `Ran ${timeAgo(run.at)}` };
}

let validationTimer;
function refreshSource() {
  updateDraftState();
  clearTimeout(validationTimer);
  validationTimer = setTimeout(updateTargetsSummary, 250);
}

// The status bar shows the first error, or how many other problems the editor marked.
function renderProblems(found) {
  const errors = found.filter(item => item.severity === "error");
  const warnings = found.filter(item => item.severity === "warning").length;
  validation.dataset.state = errors.length ? "error" : warnings ? "warning" : "";
  validation.textContent = errors.length ? errors[0].message + (errors.length > 1 ? ` (+${errors.length - 1} more)` : "")
    : warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "";
  validation.title = found.length ? "Show all problems" : "";
}

const source = createCodeEditor($("#editor"), {
  onChange: refreshSource,
  onCursor: ({ line, column }) => {
    cursorPosition.textContent = `Ln ${line}, Col ${column}`;
  },
  onDiagnostics: renderProblems
});
validation.addEventListener("click", () => source.openProblems());

function select(script, preserveCaret = false, template = starter) {
  selectedId = script?.id;
  loaded = script;
  if (!preserveCaret) {
    draftBaseline = script?.source ?? template;
    source.load(draftBaseline);
  }
  enabled.checked = script?.enabled ?? false;
  title.textContent = script?.name ?? "New script";
  if (!preserveCaret) {
    setup.open = false;
    populateSetup();
  }
  refreshSource();
  updateTargetsSummary();
  status.textContent = script ? registrationMessage(selectedId) : "";
  render();
}

function renderEditorDetails() {
  const script = scripts.find(item => item.id === selectedId);
  deleteButton.hidden = !script;
  historyButton.hidden = !script?.history?.length;
  const metadata = script && metadataFor(script);
  valuesButton.hidden = !metadata || !["getValue", "setValue", "deleteValue", "listValues"].some(family => allows(metadata.grants, family));
  updatesButton.hidden = !script?.installUrl && !metadata?.updateUrl;
  renderUpdateState(script);
  const index = scripts.indexOf(script);
  orderControls.hidden = !script || scripts.length < 2;
  orderLabel.textContent = `Runs ${index + 1} of ${scripts.length}`;
  if (!busy) {
    moveUp.disabled = index <= 0;
    moveDown.disabled = index === scripts.length - 1;
  }
  const status = script ? scriptStatus(script) : { pill: "New", state: "" };
  scriptState.textContent = status.pill;
  scriptState.dataset.state = status.state;
  runState.replaceChildren();
  source.setRunError(script && runs[script.id]?.error);
  const summary = script && runSummary(script.id);
  if (!summary) return;
  runState.dataset.state = summary.state;
  const { url, error } = runs[script.id];
  runState.append(error ? `Last run failed${error.line ? ` on line ${error.line}` : ""}: ${error.message} · ${timeAgo(error.at)}` : summary.text,
    ...(url && summary.state !== "error" ? [` on ${url.replace(/^https?:\/\//, "")}`] : []));
  const line = runs[script.id].error?.line;
  if (line) runState.append(" ", makeButton(`Go to line ${line}`, () => source.goToLine(line)));
}

function renderDiagnostics() {
  diagnosticResults.replaceChildren();
  diagnosticMessage.textContent = "Open the extension from a page or enter its URL.";
  if (!diagnosticUrl.value.trim()) return;
  let url;
  try {
    url = new URL(diagnosticUrl.value.trim());
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
  } catch {
    diagnosticMessage.textContent = "Enter a valid HTTP or HTTPS URL.";
    return;
  }
  diagnosticMessage.textContent = !scripts.length ? "No saved scripts."
    : settings.paused ? "All scripts are paused."
    : "Registration status reflects Chrome’s registry. Run times come from the most recent page load anywhere.";
  for (const script of scripts) {
    const item = document.createElement("li");
    let state;
    try {
      const { targets } = parseSource(script.source);
      const included = targetsMatch({ ...targets, excludeMatches: [], excludeGlobs: [], guard: targets.guard && { ...targets.guard, exclude: [] } }, url);
      if (!included) state = "URL does not match";
      else if (!targetsMatch(targets, url)) state = "Excluded by rule";
      else if (!script.enabled) state = "Matches · disabled";
      else if (registrationState?.active.includes(script.id)) {
        state = "Matches · registered" + (runSummary(script.id) ? ` · ${runSummary(script.id).text}` : "");
      } else state = "Matches · " + (registrationMessage(script.id) || "unregistered");
    } catch (error) {
      state = error.message;
    }
    item.textContent = `${script.name} · ${state}`;
    diagnosticResults.append(item);
  }
}

// One status per script: a short pill label, a longer detail for the library, and the state used for colour and filters.
function scriptStatus(script) {
  if (!script.enabled) return { pill: "Off", detail: "Off", state: "off" };
  if (settings.paused) return { pill: "Paused", detail: "Paused", state: "off" };
  if (registrationState?.setupNeeded) return { pill: "Needs setup", detail: "Chrome is blocking userscripts", state: "warning" };
  if (registrationState?.manual?.includes(script.id)) return { pill: "Manual", detail: "Runs when you choose Run now", state: "ready" };
  if (!registrationState?.active.includes(script.id)) {
    return { pill: "Needs attention", detail: registrationState?.issues[script.id] ? "Needs site access" : "Not registered", state: "warning" };
  }
  const summary = runSummary(script.id);
  if (summary?.state === "error") return { pill: "Error", detail: "Error on last run", state: "error" };
  return { pill: "Active", detail: summary ? summary.text : "Active · hasn’t run yet", state: "ready" };
}

function checkedPage() {
  try {
    const url = new URL(diagnosticUrl.value.trim());
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function renderTags(entries) {
  const tags = [...new Set(entries.flatMap(({ metadata }) => metadata?.tags ?? []))].sort();
  const current = tagFilter.value;
  tagFilter.replaceChildren(new Option("All tags", ""), ...tags.map(tag => new Option(tag, tag)));
  tagFilter.value = tags.includes(current) ? current : "";
  tagFilter.hidden = !tags.length;
}

function renderLibrary() {
  const query = search.value.trim().toLowerCase();
  const page = checkedPage();
  const entries = scripts.map((script, index) => ({ script, index, metadata: metadataFor(script) }));
  renderTags(entries);
  const visible = entries.filter(({ script, metadata }) => {
    const { state } = scriptStatus(script);
    if (filter.value === "enabled" && !script.enabled) return false;
    if (filter.value === "disabled" && script.enabled) return false;
    if (filter.value === "attention" && !["warning", "error"].includes(state)) return false;
    if (filter.value === "page" && !(page && runsOn(script.source, page))) return false;
    if (tagFilter.value && !metadata?.tags.includes(tagFilter.value)) return false;
    return !query || script.name.toLowerCase().includes(query) ||
      (metadata?.matches ?? []).some(pattern => pattern.toLowerCase().includes(query)) ||
      (metadata?.tags ?? []).some(tag => tag.toLowerCase().includes(query));
  });
  if (sort.value === "name") visible.sort((a, b) => a.script.name.localeCompare(b.script.name));
  if (sort.value === "recent") visible.sort((a, b) => (b.script.updatedAt ?? 0) - (a.script.updatedAt ?? 0));
  empty.textContent = visible.length ? ""
    : !scripts.length ? "Create a script or import one to get started."
    : filter.value === "page" && !page ? "Enter a page under Check a page to filter by it."
    : "No scripts match these filters.";
  list.replaceChildren(...visible.map(({ script, metadata }) => {
    const row = document.createElement("div");
    row.className = "script-row";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "switch";
    toggle.setAttribute("role", "switch");
    toggle.checked = script.enabled;
    toggle.disabled = busy;
    toggle.setAttribute("aria-label", `Enable ${script.name}`);
    toggle.addEventListener("change", () => setEnabled(script, toggle.checked));
    const button = document.createElement("button");
    button.type = "button";
    const status = scriptStatus(script);
    const state = element("span", status.detail, "script-state");
    state.dataset.state = status.state;
    const meta = element("span", undefined, "script-meta");
    meta.append(state);
    if (script.pendingUpdate) meta.append(element("span", "Update available", "script-update"));
    if (metadata?.tags.length) meta.append(element("span", metadata.tags.map(tag => `#${tag}`).join(" "), "script-tags"));
    button.append(element("span", script.name, "script-name"), meta);
    button.title = registrationState?.issues[script.id] ?? runs[script.id]?.error?.message ?? "";
    button.setAttribute("aria-pressed", String(script.id === selectedId));
    button.addEventListener("click", () => {
      if (!busy && script.id !== selectedId && canLeave()) {
        select(script);
        /** @type {HTMLElement} */ (list.querySelector('[aria-pressed="true"]'))?.focus();
      }
    });
    row.append(button, toggle);
    return row;
  }));
}

function renderBackupState() {
  trashButton.textContent = trash.length ? `Trash (${trash.length})` : "Trash";
  backupState.dataset.state = "";
  if (!scripts.length) {
    backupState.textContent = "";
    return;
  }
  if (settings.syncBackup && syncState?.at && !syncState.error) {
    backupState.textContent = `Backed up to Chrome sync ${timeAgo(syncState.at)}.`;
    return;
  }
  const changedSince = scripts.some(script => (script.updatedAt ?? 0) > (settings.lastExportAt ?? 0));
  const stale = !settings.lastExportAt || Date.now() - settings.lastExportAt > 7 * 86_400_000;
  backupState.textContent = settings.syncBackup && syncState?.error ? `Chrome sync backup failed: ${syncState.error}`
    : settings.lastExportAt ? `Last exported ${timeAgo(settings.lastExportAt)}.` : "Never exported.";
  if ((changedSince && stale) || syncState?.error) {
    backupState.dataset.state = "warning";
    if (!syncState?.error) {
      backupState.textContent += " Recent changes aren’t backed up.";
      backupState.append(document.createElement("br"), makeButton("Export now", () => exportButton.click()));
    }
  }
}

function renderSettings() {
  pauseAll.checked = Boolean(settings.paused);
  pausedBanner.hidden = !settings.paused;
  setupBanner.hidden = !registrationState?.setupNeeded;
}

function render() {
  renderSettings();
  renderLibrary();
  renderDiagnostics();
  renderEditorDetails();
  renderBackupState();
}

function populateSetup() {
  try {
    const metadata = parseSource(source.value);
    setupName.value = metadata.name;
    setupSites.value = metadata.matches.join("\n");
  } catch {
    setupName.value = "";
    setupSites.value = "";
  }
}

function updateTargetsSummary() {
  try {
    const metadata = parseSource(source.value);
    const sites = [...metadata.matches, ...metadata.includes];
    const excluded = [...metadata.excludeMatches, ...metadata.excludes];
    targets.replaceChildren("Runs on", ...sites.map(pattern => element("code", pattern)));
    if (excluded.length) targets.append("except", ...excluded.map(pattern => element("code", pattern, "excluded")));
    if (metadata.allFrames) targets.append("including frames");
    if (metadata.runAt === "manual") targets.append("· only from Run now in the popup");
    if (metadata.injectInto === "page") targets.append("· in the page’s own context");
    const files = metadata.requires.length + metadata.resources.length;
    if (files) targets.append(`· loads ${files} file${files === 1 ? "" : "s"}`);
  } catch {
    targets.textContent = "Add the sites this script runs on under Name and sites.";
  }
}

function isDirty() {
  const baseline = (loaded?.source ?? draftBaseline).replace(/\r\n?/g, "\n");
  return source.value !== baseline || enabled.checked !== (loaded?.enabled ?? false);
}

function updateDraftState() {
  const dirty = isDirty();
  draftState.textContent = dirty ? "Unsaved" : "";
  saveButton.dataset.dirty = String(dirty);
}

function canLeave() {
  return !isDirty() || confirm("Discard unsaved changes?");
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? "The script manager did not respond.");
  // Most replies are the registration state; a few (diagnostics) carry something else.
  if (Array.isArray(response.state?.active)) registrationState = response.state;
  return response.state;
}

/** @returns {any[]} every control that is disabled while an operation runs */
function controls() {
  return [...form.elements, ...document.querySelectorAll("aside button, aside input[type=checkbox], .app-header button, .app-header input, #resume")];
}

async function perform(operation) {
  if (busy) return;
  busy = true;
  const affected = controls().map(control => /** @type {[any, boolean]} */ ([control, control.disabled]));
  for (const [control] of affected) control.disabled = true;
  status.textContent = "";
  try {
    await operation();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    busy = false;
    for (const [control, disabled] of affected) control.disabled = disabled;
    render();
  }
}

async function reloadData() {
  const [library, stored] = await Promise.all([readScripts(), getLocal(["trash", "settings", "syncState"])]);
  scripts = library;
  trash = stored.trash ?? [];
  settings = stored.settings ?? {};
  syncState = stored.syncState;
}

async function requestAccess(script) {
  const granted = await chrome.permissions.request({ origins: parseSource(script.source).origins });
  if (!granted) throw new Error("Site access was declined. Grant access or keep the script disabled.");
}

function setEnabled(script, value) {
  perform(async () => {
    if (value) await requestAccess(script);
    await send({ type: "toggle", id: script.id, enabled: value });
    await reloadData();
    const fresh = scripts.find(item => item.id === script.id);
    if (script.id === selectedId) select(fresh, true);
    status.textContent = registrationMessage(script.id) ||
      `${fresh.name} ${value ? "enabled" : "disabled"}. Reload matching tabs to apply.`;
  });
}

async function reloadMatchingTabs(script) {
  const tabs = await chrome.tabs.query({ url: parseSource(script.source).targets.matches });
  const matching = tabs.filter(tab => tab.url && runsOn(script.source, new URL(tab.url)));
  await Promise.all(matching.map(tab => chrome.tabs.reload(tab.id)));
  return matching.length;
}

function sendSettings(patch) {
  return perform(async () => {
    await send({ type: "settings", patch });
    await reloadData();
  });
}

search.addEventListener("input", renderLibrary);
for (const control of [tagFilter, sort, ...document.querySelectorAll('input[name="filter"]')]) {
  control.addEventListener("change", renderLibrary);
}
enabled.addEventListener("change", updateDraftState);
pauseAll.addEventListener("change", () => sendSettings({ paused: pauseAll.checked }));
$("#resume", HTMLButtonElement).addEventListener("click", () => sendSettings({ paused: false }));
window.addEventListener("beforeunload", event => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = true;
});
setup.querySelector("summary").addEventListener("click", () => {
  if (!setup.open) populateSetup();
});
const applySetup = $("#apply-setup", HTMLButtonElement);
setupName.addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  applySetup.click();
});
applySetup.addEventListener("click", () => {
  try {
    const patterns = setupSites.value.split("\n").map(line => line.trim()).filter(Boolean);
    const next = updateTargets(source.value, setupName.value, patterns);
    parseSource(next + "\n;");
    source.replace(next);
    setup.open = false;
    status.textContent = "Site settings applied to the draft. Save to use them.";
    source.focus();
  } catch (error) {
    status.textContent = error.message;
  }
});

function showDiagnostics(open) {
  diagnostics.hidden = !open;
  inspect.setAttribute("aria-expanded", String(open));
}

inspect.addEventListener("click", () => {
  showDiagnostics(diagnostics.hidden);
  if (!diagnostics.hidden) diagnosticUrl.focus();
});

function primary(event) {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

document.addEventListener("keydown", event => {
  if (event.isComposing || event.altKey || event.shiftKey || review.open || !primary(event)) return;
  const key = event.key.toLowerCase();
  if (key === "s") {
    event.preventDefault();
    if (!busy && !event.repeat) form.requestSubmit(saveButton);
  } else if (key === "f" && form.contains(document.activeElement) && !event.defaultPrevented) {
    event.preventDefault();
    source.openSearch();
  }
});

function openTemplates(site) {
  if (!canLeave()) return;
  const host = site && new URL(site.replace("*", "")).host;
  const choices = element("div", undefined, "template-list");
  for (const template of templates) {
    const button = makeButton("", () => {
      review.close();
      const name = template.source ? parseSource(template.source).name : `${host} tweaks`;
      select(undefined, false, site ? updateTargets(template.source, name, [site]) : template.source);
      setup.open = true;
      populateSetup();
      setupName.focus();
      setupName.select();
    });
    button.append(element("strong", template.name), element("span", template.description));
    choices.append(button);
  }
  const help = element("p", "New to userscripts? ", "template-help");
  help.append(guideLink("Read the scripting guide"), ", which explains the header, the GM APIs and has an example for each.");
  openReview(host ? `New script for ${host}` : "Start a new script", choices, help);
}
newButton.addEventListener("click", () => openTemplates());

form.addEventListener("submit", event => {
  event.preventDefault();
  perform(async () => {
    const { name, origins } = validate(source.value);
    const script = {
      id: selectedId ?? crypto.randomUUID(),
      name,
      source: source.value,
      enabled: enabled.checked
    };
    const wasEnabled = Boolean(loaded?.enabled);
    if (script.enabled) {
      const granted = await chrome.permissions.request({ origins });
      if (!granted) throw new Error("Site access was declined. Grant access or save the script disabled.");
    }
    await send({ type: "save", id: script.id, script, expected: loaded });
    await reloadData();
    const saved = scripts.find(item => item.id === script.id);
    select(saved, true);
    const issue = registrationMessage(script.id);
    let message = issue ? `Saved. ${issue}`
      : script.enabled ? "Saved. Reload matching pages to run the script." : "Saved as disabled.";
    if (settings.reloadAfterSave && !issue && (script.enabled || wasEnabled)) {
      const count = await reloadMatchingTabs(saved);
      message = `Saved and reloaded ${count} matching tab${count === 1 ? "" : "s"}.`;
    }
    status.textContent = message;
  });
});

function restore(id) {
  return perform(async () => {
    await send({ type: "restore", id });
    await reloadData();
    const restored = scripts.find(item => item.id === id);
    if (restored && canLeave()) select(restored);
    status.textContent = "Script restored from the Trash. It stays disabled until you enable it.";
  });
}

deleteButton.addEventListener("click", () => {
  perform(async () => {
    const id = selectedId;
    await send({ type: "delete", id, expected: loaded });
    await reloadData();
    select(scripts[0]);
    status.replaceChildren(`Script moved to the Trash. ${registrationMessage(id)}`.trim(), " ", makeButton("Undo", () => restore(id)));
  });
});

moveUp.addEventListener("click", () => move(-1));
moveDown.addEventListener("click", () => move(1));
function move(offset) {
  perform(async () => {
    await send({ type: "move", id: selectedId, offset });
    await reloadData();
    loaded = scripts.find(item => item.id === selectedId);
    sort.value = "order";
    status.textContent = "Run order updated. Reload matching pages to apply it.";
  });
}

/** @param {string} selector @returns {NodeListOf<HTMLDetailsElement>} */
const menus = selector => document.querySelectorAll(selector);

for (const menu of menus("details.menu")) {
  menu.addEventListener("click", event => {
    if (/** @type {Element} */ (event.target).closest(".menu-items button")) menu.open = false;
  });
}
document.addEventListener("click", event => {
  for (const menu of menus("details.menu[open]")) {
    if (!menu.contains(/** @type {Node} */ (event.target))) menu.open = false;
  }
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  for (const menu of menus("details.menu[open]")) {
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});

diagnosticUrl.addEventListener("input", () => {
  renderDiagnostics();
  if (filter.value === "page") renderLibrary();
});

$("#open-extension-settings", HTMLButtonElement).addEventListener("click", () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});
// Allow User Scripts has no change event, so check again whenever the user comes back to this tab.
window.addEventListener("focus", () => {
  if (registrationState?.setupNeeded && !busy) perform(() => send({ type: "sync" }));
});

// The scripting guide opens in one tab that later links reuse.
function guideLink(text, anchor = "") {
  const link = document.createElement("a");
  link.href = `../guide/guide.html${anchor}`;
  link.target = "tailorscript-guide";
  link.textContent = text;
  return link;
}
$("#guide", HTMLButtonElement).addEventListener("click", () => window.open("../guide/guide.html", "tailorscript-guide"));

// "Start a script from this" in the guide: opens the example as a new, unsaved script.
function exampleRequested(example) {
  chrome.storage.session.remove("newScriptSource");
  if (!canLeave()) return;
  if (review.open) review.close();
  select(undefined, false, example);
  status.textContent = "Example loaded. Set the site under Name and sites, then turn on Enabled and save.";
}

function newScriptRequested(site) {
  chrome.storage.session.remove("newScriptSite");
  openTemplates(site);
}

function focusRequested(id, message) {
  chrome.storage.session.remove(["focusScript", "focusMessage"]);
  const script = scripts.find(item => item.id === id);
  if (!script) return;
  if (script.id !== selectedId && !canLeave()) return;
  if (script.id !== selectedId) select(script);
  if (message) status.textContent = message;
  source.focus();
}

// What the dialog modules may read and do. Getters keep them reading the current state rather than a copy.
const app = {
  get scripts() { return scripts; },
  get trash() { return trash; },
  get settings() { return settings; },
  get syncState() { return syncState; },
  get selectedId() { return selectedId; },
  get loaded() { return loaded; },
  set loaded(value) { loaded = value; },
  source, status,
  perform, send, reloadData, sendSettings, select, isDirty, canLeave, restore, metadataFor
};
setupDialogs(app);
const { renderUpdateState } = setupUpdates(app);

// Stored values arrive untyped; their shapes are the ones in shared/types.js.
chrome.storage.onChanged.addListener((/** @type {Record<string, { newValue?: any, oldValue?: any }>} */ changes, area) => {
  if (area === "local") {
    if (changes.trash) trash = changes.trash.newValue ?? [];
    if (changes.settings) settings = changes.settings.newValue ?? {};
    if (changes.syncState) syncState = changes.syncState.newValue;
    const changed = applyScriptChanges(scripts, changes);
    if (changed) {
      scripts = changed;
      // Operations in this tab select their own result; only follow changes made elsewhere, such as the popup.
      if (!busy) {
        const fresh = scripts.find(item => item.id === selectedId);
        if (selectedId && !fresh) {
          if (!isDirty()) select(scripts[0]);
          else status.textContent = "This script was deleted elsewhere. Copy your changes before leaving.";
        } else if (fresh && loaded && (fresh.source !== loaded.source || fresh.enabled !== loaded.enabled)) {
          if (!isDirty() || (fresh.source === source.value && fresh.enabled === enabled.checked)) select(fresh, fresh.source === source.value);
          else status.textContent = "This script changed elsewhere. Copy your changes and reload before saving.";
        } else if (fresh) {
          loaded = fresh;
        }
      }
    }
    if (!busy) render();
    return;
  }
  if (area !== "session") return;
  if (changes.diagnosticUrl?.newValue !== undefined) {
    diagnosticUrl.value = changes.diagnosticUrl.newValue ?? "";
    if (diagnosticUrl.value) showDiagnostics(true);
  }
  if (changes.showDiagnostics?.newValue) showDiagnostics(true);
  if (changes.runs) runs = changes.runs.newValue ?? {};
  if (changes.focusScript?.newValue) focusRequested(changes.focusScript.newValue, changes.focusMessage?.newValue);
  if (changes.newScriptSite?.newValue) newScriptRequested(changes.newScriptSite.newValue);
  if (changes.newScriptSource?.newValue) exampleRequested(changes.newScriptSource.newValue);
  if (changes.registrationState) {
    // Only replace a registration message, so results such as "Saved." stay visible.
    const previous = selectedId && registrationMessage(selectedId);
    registrationState = changes.registrationState.newValue;
    if (!busy && selectedId && status.textContent === previous) status.textContent = registrationMessage(selectedId);
  }
  if (!busy) render();
});

await perform(async () => {
  await reloadData();
  const context = await getSession(["diagnosticUrl", "runs", "focusScript", "focusMessage", "newScriptSite", "newScriptSource"]);
  runs = context.runs ?? {};
  diagnosticUrl.value = context.diagnosticUrl ?? "";
  if (diagnosticUrl.value) showDiagnostics(true);
  select(scripts.find(item => item.id === context.focusScript) ?? scripts[0]);
  await send({ type: "sync" });
  if (selectedId) status.textContent = context.focusMessage || registrationMessage(selectedId);
  if (context.focusScript) chrome.storage.session.remove(["focusScript", "focusMessage"]);
  if (context.newScriptSite) setTimeout(() => newScriptRequested(context.newScriptSite));
  if (context.newScriptSource) setTimeout(() => exampleRequested(context.newScriptSource));
});

import { timeAgo } from "../shared/format.js";
import { readScripts } from "../shared/storage.js";
import { readSyncBackup } from "../shared/sync-backup.js";
import { describeGrants, installOrigins, installPageUrl } from "../shared/install.js";
import { allows, grantFamilies, parseSource, runsOn, targetsMatch, updateTargets } from "../shared/userscript.js";
import { validate } from "../shared/validate.js";
import { decodeImport } from "./backup-file.js";
import { diffView } from "./diff.js";
import { createCodeEditor } from "./code-editor.js";
import { templates } from "./templates.js";

const starter = `// ==UserScript==
// @name        Highlight example heading
// @match       https://example.com/*
// @run-at      document-idle
// @grant       none
// ==/UserScript==

document.querySelector("h1")?.style.setProperty("color", "rebeccapurple");`;

const list = document.querySelector("#scripts");
const form = document.querySelector("main form");
const cursorPosition = document.querySelector("#cursor-position");
const saveButton = document.querySelector("#save");
const isMac = navigator.userAgentData?.platform === "macOS" || navigator.platform.startsWith("Mac");
const modifierLabel = isMac ? "⌘" : "Ctrl+";
for (const key of document.querySelectorAll("[data-shortcut]")) key.textContent = modifierLabel + key.dataset.shortcut;
saveButton.setAttribute("aria-keyshortcuts", isMac ? "Meta+S" : "Control+S");

const enabled = document.querySelector("#enabled");
const status = document.querySelector("#status");
const newButton = document.querySelector("#new");
const deleteButton = document.querySelector("#delete");
const historyButton = document.querySelector("#history");
const valuesButton = document.querySelector("#values");
const importButton = document.querySelector("#import");
const importFile = document.querySelector("#import-file");
const exportButton = document.querySelector("#export");
const backupButton = document.querySelector("#backup");
const trashButton = document.querySelector("#trash");
const backupState = document.querySelector("#backup-state");
const diagnosticUrl = document.querySelector("#diagnostic-url");
const diagnosticMessage = document.querySelector("#diagnostic-message");
const diagnosticResults = document.querySelector("#diagnostic-results");
const review = document.querySelector("#review");
const reviewTitle = document.querySelector("#review-title");
const reviewContent = document.querySelector("#review-content");
const validation = document.querySelector("#validation");
const runState = document.querySelector("#run-state");
const pauseAll = document.querySelector("#pause-all");
const pausedBanner = document.querySelector("#paused-banner");
const orderControls = document.querySelector("#order-controls");
const orderLabel = document.querySelector("#order-label");
const moveUp = document.querySelector("#move-up");
const moveDown = document.querySelector("#move-down");
const setupBanner = document.querySelector("#setup-banner");
const updatesButton = document.querySelector("#updates");
const updateState = document.querySelector("#update-state");

const search = document.querySelector("#search");
// Status filter chips are radio buttons; this keeps the select-style .value interface the library code reads.
const filter = {
  get value() {
    return document.querySelector('input[name="filter"]:checked').value;
  },
  set value(next) {
    document.querySelector(`input[name="filter"][value="${next}"]`).checked = true;
  }
};
const tagFilter = document.querySelector("#tag");
const sort = document.querySelector("#sort");
const empty = document.querySelector("#library-empty");
const title = document.querySelector("#script-title");
const draftState = document.querySelector("#draft-state");
const scriptState = document.querySelector("#script-state");
const targets = document.querySelector("#targets");
const setup = document.querySelector("#setup");
const setupName = document.querySelector("#setup-name");
const setupSites = document.querySelector("#setup-sites");
const inspect = document.querySelector("#inspect");
const diagnostics = document.querySelector("#diagnostics");

let scripts = [];
let trash = [];
let settings = {};
let syncState;
let runs = {};
let selectedId;
// The stored record the editor was loaded from; saves send it so the worker can reject edits made elsewhere.
let loaded;
let draftBaseline = starter;
let busy = false;
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

const source = createCodeEditor(document.querySelector("#editor"), {
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
        list.querySelector('[aria-pressed="true"]')?.focus();
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
  registrationState = response.state;
  return response.state;
}

function controls() {
  return [...form.elements, ...document.querySelectorAll("aside button, aside input[type=checkbox], .app-header button, .app-header input, #resume")];
}

async function perform(operation) {
  if (busy) return;
  busy = true;
  const affected = controls().map(control => [control, control.disabled]);
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
  const stored = await chrome.storage.local.get(["scripts", "trash", "settings", "syncState"]);
  scripts = stored.scripts ?? [];
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
document.querySelector("#resume").addEventListener("click", () => sendSettings({ paused: false }));
window.addEventListener("beforeunload", event => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = true;
});
setup.querySelector("summary").addEventListener("click", () => {
  if (!setup.open) populateSetup();
});
const applySetup = document.querySelector("#apply-setup");
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

function openReview(heading, ...content) {
  reviewTitle.textContent = heading;
  reviewContent.replaceChildren(...content);
  if (!review.open) review.showModal();
}

function makeButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

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
  openReview(host ? `New script for ${host}` : "Start a new script", choices);
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

for (const menu of document.querySelectorAll("details.menu")) {
  menu.addEventListener("click", event => {
    if (event.target.closest(".menu-items button")) menu.open = false;
  });
}
document.addEventListener("click", event => {
  for (const menu of document.querySelectorAll("details.menu[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  for (const menu of document.querySelectorAll("details.menu[open]")) {
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});

diagnosticUrl.addEventListener("input", () => {
  renderDiagnostics();
  if (filter.value === "page") renderLibrary();
});

function downloadBackup(data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "tailorscript-backup.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

exportButton.addEventListener("click", () => perform(async () => {
  const latest = await readScripts();
  if (!latest.length) throw new Error("There are no scripts to export.");
  downloadBackup({ version: 1, scripts: latest.map(({ source, history = [] }) => ({ source, history })) });
  await send({ type: "settings", patch: { lastExportAt: Date.now() } });
  await reloadData();
}));

function reviewImport(entries, origin) {
  const rows = element("ul", undefined, "import-list");
  const choices = entries.map(entry => {
    const identical = scripts.find(script => script.source === entry.source);
    const sameName = scripts.find(script => script.name === entry.name);
    const item = element("li");
    const choice = document.createElement("select");
    choice.append(new Option("Add as a new script", "new"));
    if (!identical && sameName) choice.append(new Option(`Replace “${sameName.name}” (disables it for review)`, sameName.id));
    choice.append(new Option("Skip", "skip"));
    choice.value = identical ? "skip" : "new";
    choice.setAttribute("aria-label", `Import action for ${entry.name}`);
    item.append(element("strong", entry.name),
      element("span", ` — ${[...entry.matches, ...entry.includes].join(", ")}${entry.excludeMatches.length + entry.excludes.length
        ? `; excludes ${[...entry.excludeMatches, ...entry.excludes].join(", ")}` : ""}`),
      element("span", identical ? "Identical to a script in your library." : sameName ? "A script with this name already exists." : "", "import-note"),
      choice);
    rows.append(item);
    return choice;
  });
  openReview(`Review import from ${origin}`, element("p", "Imported scripts start disabled so you can review them."), rows,
    makeButton("Import selected", () => {
      const chosen = entries.flatMap(({ source, history }, index) => {
        const action = choices[index].value;
        return action === "skip" ? [] : [{ source, history, ...(action === "new" ? {} : { replace: action }) }];
      });
      review.close();
      if (!chosen.length) return;
      perform(async () => {
        await send({ type: "import", entries: chosen });
        await reloadData();
        const replacedSelected = chosen.some(entry => entry.replace === selectedId);
        if (replacedSelected && !isDirty()) select(scripts.find(item => item.id === selectedId));
        status.textContent = `Imported ${chosen.length} disabled script(s).` +
          (replacedSelected && isDirty() ? " The open script was replaced; reload it before saving." : "");
      });
    }));
}

importButton.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  const [file] = importFile.files;
  importFile.value = "";
  if (!file) return;
  perform(async () => {
    reviewImport(decodeImport(await file.text(), file.name.toLowerCase().endsWith(".json")), file.name);
  });
});

function showHistory() {
  const script = scripts.find(item => item.id === selectedId);
  if (!script?.history?.length) return;
  const versions = document.createElement("ol");
  for (const version of script.history) {
    const item = document.createElement("li");
    const details = document.createElement("details");
    const summary = element("summary", new Date(version.savedAt).toLocaleString());
    if (version.label) summary.append(" — ", element("strong", version.label));
    const label = document.createElement("input");
    label.type = "text";
    label.value = version.label ?? "";
    label.placeholder = "Label this version";
    label.maxLength = 80;
    label.setAttribute("aria-label", "Version label");
    const preview = element("pre", version.source, "version-source");
    const actions = element("div", undefined, "version-actions");
    actions.append(label, makeButton("Save label", () => {
      review.close();
      perform(async () => {
        await send({ type: "label", id: script.id, savedAt: version.savedAt, label: label.value });
        await reloadData();
        loaded = { ...loaded, history: scripts.find(item => item.id === script.id)?.history };
        showHistory();
      });
    }), makeButton("Compare with editor", () => {
      try {
        openReview(`Changes since ${new Date(version.savedAt).toLocaleString()}`,
          element("p", "Lines marked - are only in that version. Lines marked + are only in the editor.", "diff-help"),
          diffView(version.source, source.value), makeButton("Back to history", showHistory));
      } catch (error) {
        status.textContent = error.message;
      }
    }), makeButton("Load into editor", () => {
      if (!canLeave()) return;
      source.replace(version.source);
      review.close();
      source.focus();
      status.textContent = "Version loaded. Save to restore it.";
    }));
    details.append(summary, actions, preview);
    item.append(details);
    versions.append(item);
  }
  openReview("Version history", versions);
}
historyButton.addEventListener("click", showHistory);

async function showValues() {
  const id = selectedId;
  const key = `values:${id}`;
  const { [key]: values = {} } = await chrome.storage.local.get(key);
  const entries = Object.entries(values);
  const content = entries.length ? element("dl", undefined, "stored-values") : element("p", "This script hasn’t stored any values yet.");
  for (const [name, value] of entries) content.append(element("dt", name), element("dd", JSON.stringify(value, null, 2)));
  openReview("Stored values", element("p", "Values saved with GM.setValue. They stay in this Chrome profile and aren’t included in backups."), content,
    ...(entries.length ? [makeButton("Clear stored values", () => {
      if (!confirm("Clear every value this script has stored? This can’t be undone.")) return;
      review.close();
      perform(async () => {
        await send({ type: "clear-values", id });
        status.textContent = "Stored values cleared.";
      });
    })] : []));
}
valuesButton.addEventListener("click", showValues);

function showTrash() {
  const content = trash.length ? element("ul", undefined, "trash-list")
    : element("p", "The Trash is empty. Deleted scripts stay here for 30 days.");
  for (const script of trash) {
    const item = element("li");
    item.append(element("strong", script.name), element("span", ` deleted ${timeAgo(script.deletedAt)}`, "trash-age"),
      makeButton("Restore", () => {
        review.close();
        if (canLeave()) restore(script.id);
      }),
      makeButton("Delete forever", () => {
        if (!confirm(`Permanently delete “${script.name}” and its history? This can’t be undone.`)) return;
        perform(async () => {
          await send({ type: "purge", id: script.id });
          await reloadData();
          showTrash();
        });
      }));
    content.append(item);
  }
  openReview("Trash", element("p", "Deleted scripts are kept for 30 days, then removed with their history and stored values."), content,
    ...(trash.length ? [makeButton("Empty Trash", () => {
      if (!confirm(`Permanently delete ${trash.length} script(s)? This can’t be undone.`)) return;
      perform(async () => {
        await send({ type: "purge" });
        await reloadData();
        showTrash();
      });
    })] : []));
}
trashButton.addEventListener("click", showTrash);

async function showSiteAccess() {
  const { origins = [] } = await chrome.permissions.getAll();
  const granted = origins.filter(origin => /^https?:|^\*:/.test(origin));
  const content = granted.length ? element("ul", undefined, "access-list")
    : element("p", "No sites have been granted yet. Saving an enabled script asks for access.");
  for (const origin of granted) {
    const users = scripts.filter(script => {
      const metadata = metadataFor(script);
      return metadata?.origins.includes(origin);
    });
    const item = element("li");
    item.append(element("code", origin),
      element("span", users.length ? ` — used by ${users.map(script => script.name).join(", ")}` : " — not used by any script", "access-users"),
      makeButton("Remove access", async () => {
        const running = users.filter(script => script.enabled).length;
        if (running && !confirm(`${running} enabled script(s) will stop running on ${origin}. Remove access?`)) return;
        try {
          if (!await chrome.permissions.remove({ origins: [origin] })) throw new Error("Chrome kept this site access.");
          await showSiteAccess();
          status.textContent = `Removed access to ${origin}.`;
        } catch (error) {
          status.textContent = error.message;
        }
      }));
    content.append(item);
  }
  openReview("Site access", element("p", "Sites this extension may run scripts on. Removing access stops matching scripts until you save them enabled again."), content);
}
document.querySelector("#site-access").addEventListener("click", () => showSiteAccess().catch(error => {
  status.textContent = error.message;
}));

function settingSwitch(key, title, help) {
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "switch";
  toggle.setAttribute("role", "switch");
  toggle.checked = Boolean(settings[key]);
  toggle.addEventListener("change", () => {
    review.close();
    sendSettings({ [key]: toggle.checked }).then(showBackup);
  });
  const label = element("label", undefined, "switch-label");
  const text = element("span", title);
  text.append(element("small", help));
  label.append(toggle, text);
  return label;
}

function oneClickSwitch(granted) {
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "switch";
  toggle.setAttribute("role", "switch");
  toggle.checked = granted;
  toggle.addEventListener("change", async () => {
    try {
      const changed = toggle.checked
        ? await chrome.permissions.request({ origins: installOrigins })
        : await chrome.permissions.remove({ origins: installOrigins });
      if (!changed) toggle.checked = !toggle.checked;
    } catch (error) {
      toggle.checked = !toggle.checked;
      status.textContent = error.message;
    }
  });
  const label = element("label", undefined, "switch-label");
  const text = element("span", "One-click installs");
  text.append(element("small", "Opening a .user.js link on Greasy Fork, OpenUserJS or GitHub shows Tailorscript’s install page. Needs access to those sites."));
  label.append(toggle, text);
  return label;
}

async function showBackup() {
  const [oneClick, commands] = await Promise.all([
    chrome.permissions.contains({ origins: installOrigins }),
    chrome.commands?.getAll() ?? []
  ]);
  const shortcut = commands.find(command => command.name === "toggle-pause")?.shortcut;
  const syncHelp = settings.syncBackup
    ? syncState?.error ? `Last attempt failed: ${syncState.error}` : syncState?.at ? `Last synced ${timeAgo(syncState.at)}.` : "Waiting for the next change."
    : "Stores script sources only (about 100 KB), not history, site access, or enabled settings.";
  const list = element("div", undefined, "settings-list");
  list.append(
    settingSwitch("reloadAfterSave", "Reload matching tabs after saving", "Open tabs that a saved script runs on reload so the change applies right away."),
    settingSwitch("syncBackup", "Back up to Chrome sync", syncHelp),
    oneClickSwitch(oneClick));
  const keys = element("p", shortcut ? `Press ${shortcut} anywhere in Chrome to pause or resume all scripts. ` : "Set a keyboard shortcut to pause or resume all scripts. ");
  keys.append(makeButton("Change shortcut", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" })));
  openReview("Settings & backup", list, keys,
    element("p", settings.lastExportAt ? `Last exported ${new Date(settings.lastExportAt).toLocaleString()}.` : "You haven’t exported a backup file yet."),
    makeButton("Restore from Chrome sync", () => perform(async () => {
      const { text, savedAt } = await readSyncBackup();
      reviewImport(decodeImport(text, true), `Chrome sync (${new Date(savedAt).toLocaleString()})`);
    })));
}
backupButton.addEventListener("click", showBackup);


function renderUpdateState(script) {
  updateState.replaceChildren();
  updateState.dataset.state = "";
  if (script?.pendingUpdate) {
    updateState.dataset.state = "available";
    updateState.append(`Version ${script.pendingUpdate.version} is available${script.pendingUpdate.reasons.length ? " and needs your review" : ""}.`,
      makeButton("Review update", () => reviewUpdate(script)));
  } else if (script?.updateCheck?.error) {
    updateState.dataset.state = "warning";
    updateState.append(`Update check failed ${timeAgo(script.updateCheck.at)}: ${script.updateCheck.error}`);
  }
}

function bulletList(items) {
  const node = element("ul", undefined, "plain-list");
  node.append(...items.map(({ text, warning }) => element("li", text, warning ? "warning-item" : "")));
  return node;
}

function reviewUpdate(script) {
  const update = script.pendingUpdate;
  let next;
  try {
    next = parseSource(update.source);
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  const apply = makeButton("Apply update", () => {
    review.close();
    perform(async () => {
      if (script.enabled && !await chrome.permissions.request({ origins: next.origins })) {
        throw new Error("Site access was declined, so the update wasn’t applied.");
      }
      await send({ type: "apply-update", id: script.id });
      await reloadData();
      const updated = scripts.find(item => item.id === script.id);
      if (script.id === selectedId && !isDirty()) select(updated);
      status.textContent = `Updated “${updated.name}” to v${update.version}. Reload matching pages to run it.`;
    });
  });
  apply.className = "primary";
  const actions = element("div", undefined, "dialog-actions");
  actions.append(apply, makeButton("Skip this version", () => {
    review.close();
    perform(async () => {
      await send({ type: "dismiss-update", id: script.id });
      await reloadData();
      status.textContent = `Skipped v${update.version}. Tailorscript will offer the next version.`;
    });
  }));
  openReview(`Update “${script.name}” to v${update.version}`,
    ...(update.reasons.length ? [element("p", "This update wasn’t applied automatically because:"), bulletList(update.reasons.map(text => ({ text })))] : []),
    element("p", "After updating, it can:"), bulletList(describeGrants(next, grantFamilies)),
    actions, element("p", "Changes:"), diffView(script.source, update.source));
}

function showUpdates() {
  const script = scripts.find(item => item.id === selectedId);
  if (!script) return;
  const metadata = metadataFor(script);
  const details = element("dl", undefined, "facts");
  const fact = (label, value) => details.append(element("dt", label), element("dd", value));
  fact("Installed from", script.installUrl ?? metadata?.updateUrl ?? "—");
  fact("Version", metadata?.version ? `v${metadata.version}` : "Not declared");
  fact("Last checked", script.updateCheck?.at ? timeAgo(script.updateCheck.at) : "Never");
  if (script.updateCheck?.error) fact("Last error", script.updateCheck.error);
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "switch";
  toggle.setAttribute("role", "switch");
  toggle.checked = script.autoUpdate !== false;
  toggle.addEventListener("change", () => perform(async () => {
    await send({ type: "auto-update", id: script.id, enabled: toggle.checked });
    await reloadData();
  }));
  const label = element("label", undefined, "switch-label");
  const text = element("span", "Update automatically");
  text.append(element("small", "Updates that need new access or APIs, or would replace your edits, always wait for your review."));
  label.append(toggle, text);
  const settingsList = element("div", undefined, "settings-list");
  settingsList.append(label);
  const actions = element("div", undefined, "dialog-actions");
  actions.append(makeButton("Check now", () => {
    review.close();
    checkForUpdates(script.id);
  }));
  if (script.pendingUpdate) actions.prepend(makeButton(`Review v${script.pendingUpdate.version}`, () => reviewUpdate(script)));
  openReview("Updates", details, settingsList, actions);
}
updatesButton.addEventListener("click", showUpdates);

function checkForUpdates(id) {
  return perform(async () => {
    status.textContent = "Checking for updates…";
    const { updateSummary: summary } = await send({ type: "check-updates", id });
    await reloadData();
    const fresh = scripts.find(item => item.id === selectedId);
    if (fresh && !isDirty() && fresh.source !== loaded?.source) select(fresh);
    const parts = [
      summary.updated.length && `updated ${summary.updated.join(", ")}`,
      summary.waiting.length && `${summary.waiting.length} waiting for review`,
      summary.failed.length && `${summary.failed.length} couldn’t be checked`
    ].filter(Boolean);
    status.textContent = !summary.checked ? "None of your scripts have an update address."
      : parts.length ? `Checked ${summary.checked} script${summary.checked === 1 ? "" : "s"}: ${parts.join(", ")}.`
      : `Checked ${summary.checked} script${summary.checked === 1 ? "" : "s"}. Everything is up to date.`;
  });
}
document.querySelector("#check-updates").addEventListener("click", () => checkForUpdates());

document.querySelector("#install-url").addEventListener("click", () => {
  const field = document.createElement("input");
  field.type = "url";
  field.placeholder = "https://greasyfork.org/…/script.user.js";
  field.setAttribute("aria-label", "Script address");
  const go = makeButton("Review script", () => {
    try {
      const url = new URL(field.value.trim());
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      review.close();
      chrome.tabs.create({ url: installPageUrl(url.href) });
    } catch {
      field.setCustomValidity("Enter an http or https address.");
      field.reportValidity();
    }
  });
  go.className = "primary";
  field.addEventListener("input", () => field.setCustomValidity(""));
  field.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing) go.click();
  });
  const row = element("div", undefined, "url-row");
  row.append(field, go);
  openReview("Install from URL", element("p", "Paste the address of a .user.js file. You’ll see what it does before anything is installed."), row);
  field.focus();
});

document.querySelector("#open-extension-settings").addEventListener("click", () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});
// Allow User Scripts has no change event, so check again whenever the user comes back to this tab.
window.addEventListener("focus", () => {
  if (registrationState?.setupNeeded && !busy) perform(() => send({ type: "sync" }));
});

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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.trash) trash = changes.trash.newValue ?? [];
    if (changes.settings) settings = changes.settings.newValue ?? {};
    if (changes.syncState) syncState = changes.syncState.newValue;
    if (changes.scripts) {
      scripts = changes.scripts.newValue ?? [];
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
  const context = await chrome.storage.session.get(["diagnosticUrl", "runs", "focusScript", "focusMessage", "newScriptSite"]);
  runs = context.runs ?? {};
  diagnosticUrl.value = context.diagnosticUrl ?? "";
  if (diagnosticUrl.value) showDiagnostics(true);
  select(scripts.find(item => item.id === context.focusScript) ?? scripts[0]);
  await send({ type: "sync" });
  if (selectedId) status.textContent = context.focusMessage || registrationMessage(selectedId);
  if (context.focusScript) chrome.storage.session.remove(["focusScript", "focusMessage"]);
  if (context.newScriptSite) setTimeout(() => newScriptRequested(context.newScriptSite));
});

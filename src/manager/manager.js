import { timeAgo } from "../shared/format.js";
import { readScripts } from "../shared/storage.js";
import { readSyncBackup } from "../shared/sync-backup.js";
import { matchesUrl, originsFor, parseSource, runsOn, updateTargets } from "../shared/userscript.js";
import { validate } from "../shared/validate.js";
import { decodeImport } from "./backup-file.js";
import { diffLines } from "./diff.js";
import { editLines, findMatches, highlight } from "./editor.js";
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
const source = document.querySelector("#source");
const lineNumbers = document.querySelector("#line-numbers");
const cursorPosition = document.querySelector("#cursor-position");
const saveButton = document.querySelector("#save");
const isMac = navigator.userAgentData?.platform === "macOS" || navigator.platform.startsWith("Mac");
const modifierLabel = isMac ? "⌘" : "Ctrl+";
for (const key of document.querySelectorAll("[data-shortcut]")) key.textContent = modifierLabel + key.dataset.shortcut;
saveButton.setAttribute("aria-keyshortcuts", isMac ? "Meta+S" : "Control+S");

const enabled = document.querySelector("#enabled");
const reloadAfterSave = document.querySelector("#reload-after-save");
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
const code = document.querySelector("#highlight");
const validation = document.querySelector("#validation");
const runState = document.querySelector("#run-state");
const pauseAll = document.querySelector("#pause-all");
const pausedBanner = document.querySelector("#paused-banner");
const orderControls = document.querySelector("#order-controls");
const orderLabel = document.querySelector("#order-label");
const moveUp = document.querySelector("#move-up");
const moveDown = document.querySelector("#move-down");

const search = document.querySelector("#search");
const filter = document.querySelector("#filter");
const tagFilter = document.querySelector("#tag");
const sort = document.querySelector("#sort");
const empty = document.querySelector("#library-empty");
const title = document.querySelector("#script-title");
const draftState = document.querySelector("#draft-state");
const targets = document.querySelector("#targets");
const setup = document.querySelector("#setup");
const setupName = document.querySelector("#setup-name");
const setupSites = document.querySelector("#setup-sites");
const inspect = document.querySelector("#inspect");
const diagnostics = document.querySelector("#diagnostics");

const findBar = document.querySelector("#find-bar");
const findInput = document.querySelector("#find-input");
const replaceInput = document.querySelector("#replace-input");
const findCase = document.querySelector("#find-case");
const findCount = document.querySelector("#find-count");

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
let currentMatch;

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

let lineCount = 0;

function syncGutter() {
  code.style.transform = `translate(-${source.scrollLeft}px, -${source.scrollTop}px)`;
  lineNumbers.style.transform = `translateY(-${source.scrollTop}px)`;
}

function findMarks() {
  if (findBar.hidden) return [];
  const length = findInput.value.length;
  const marks = findMatches(source.value, findInput.value, findCase.checked).slice(0, 500)
    .filter(start => start !== currentMatch?.start)
    .map(start => ({ start, end: start + length, kind: "find-match" }));
  return currentMatch ? [...marks, { ...currentMatch, kind: "find-current" }] : marks;
}

function refreshHighlight() {
  const caret = source.selectionStart === source.selectionEnd && document.activeElement === source ? source.selectionStart : -1;
  highlight(source.value, code, { caret, marks: findMarks() });
}

function updateEditor() {
  const lines = source.value.split("\n").length;
  if (lines !== lineCount) {
    lineCount = lines;
    lineNumbers.textContent = Array.from({ length: lines }, (_, index) => index + 1).join("\n");
  }
  const beforeCaret = source.value.slice(0, source.selectionDirection === "backward"
    ? source.selectionStart : source.selectionEnd);
  const line = beforeCaret.split("\n").length;
  const column = beforeCaret.length - beforeCaret.lastIndexOf("\n");
  cursorPosition.textContent = `Ln ${line}, Col ${column}`;
  syncGutter();
}

let validationTimer;
function refreshSource() {
  updateEditor();
  updateDraftState();
  if (currentMatch && source.value.slice(currentMatch.start, currentMatch.end) !== findInput.value) currentMatch = undefined;
  refreshHighlight();
  if (!findBar.hidden) updateFindCount();
  clearTimeout(validationTimer);
  validationTimer = setTimeout(() => {
    updateTargetsSummary();
    try {
      validate(source.value);
      validation.textContent = "";
    } catch (error) {
      validation.textContent = error.message;
    }
  }, 250);
}

function scrollToOffset(offset) {
  const lineHeight = parseFloat(getComputedStyle(source).lineHeight);
  const line = source.value.slice(0, offset).split("\n").length - 1;
  if (line * lineHeight < source.scrollTop || (line + 1) * lineHeight > source.scrollTop + source.clientHeight - 24) {
    source.scrollTop = Math.max(0, (line - 4) * lineHeight);
  }
}

function goToLine(line) {
  const lines = source.value.split("\n");
  const start = lines.slice(0, line - 1).reduce((total, text) => total + text.length + 1, 0);
  source.focus();
  source.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
  scrollToOffset(start);
}

function select(script, preserveCaret = false, template = starter) {
  selectedId = script?.id;
  loaded = script;
  if (!preserveCaret) {
    draftBaseline = script?.source ?? template;
    source.value = draftBaseline;
    source.setSelectionRange(0, 0);
    source.scrollTop = 0;
    source.scrollLeft = 0;
    currentMatch = undefined;
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
  valuesButton.hidden = !metadataFor(script ?? { source: "" })?.grants.some(grant => grant.startsWith("GM."));
  const index = scripts.indexOf(script);
  orderControls.hidden = !script || scripts.length < 2;
  orderLabel.textContent = `Runs ${index + 1} of ${scripts.length}`;
  if (!busy) {
    moveUp.disabled = index <= 0;
    moveDown.disabled = index === scripts.length - 1;
  }
  runState.replaceChildren();
  const summary = script && runSummary(script.id);
  if (!summary) return;
  runState.dataset.state = summary.state;
  runState.append(summary.text + (runs[script.id].url ? ` · ${runs[script.id].url}` : ""));
  const line = runs[script.id].error?.line;
  if (line) runState.append(" ", makeButton(`Go to line ${line}`, () => goToLine(line)));
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
      const { matches, excludeMatches } = parseSource(script.source);
      if (!matches.some(pattern => matchesUrl(pattern, url))) state = "URL does not match";
      else if (excludeMatches.some(pattern => matchesUrl(pattern, url))) state = "Excluded by rule";
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

function libraryState(script) {
  if (!script.enabled) return ["Disabled", "off"];
  if (settings.paused) return ["Paused", "off"];
  if (!registrationState?.active.includes(script.id)) return ["Needs attention", "warning"];
  const summary = runSummary(script.id);
  if (summary?.state === "error") return ["Error on last run", "error"];
  return [summary ? summary.text : "Registered", "ready"];
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
    const [, state] = libraryState(script);
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
    toggle.checked = script.enabled;
    toggle.disabled = busy;
    toggle.setAttribute("aria-label", `Enable ${script.name}`);
    toggle.addEventListener("change", () => setEnabled(script, toggle.checked));
    const button = document.createElement("button");
    const name = document.createElement("span");
    const state = document.createElement("span");
    button.type = "button";
    name.textContent = script.name;
    state.className = "script-state";
    [state.textContent, state.dataset.state] = libraryState(script);
    button.append(name, state);
    if (metadata?.tags.length) {
      const tags = document.createElement("span");
      tags.className = "script-tags";
      tags.textContent = metadata.tags.map(tag => `#${tag}`).join(" ");
      button.append(tags);
    }
    button.title = registrationState?.issues[script.id] ?? runs[script.id]?.error?.message ?? "";
    button.setAttribute("aria-pressed", String(script.id === selectedId));
    button.addEventListener("click", () => {
      if (!busy && script.id !== selectedId && canLeave()) {
        select(script);
        list.querySelector('[aria-pressed="true"]')?.focus();
      }
    });
    row.append(toggle, button);
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
    if (!syncState?.error) backupState.textContent += " Export a backup to protect recent changes.";
  }
}

function renderSettings() {
  pauseAll.checked = Boolean(settings.paused);
  pausedBanner.hidden = !settings.paused;
  reloadAfterSave.checked = Boolean(settings.reloadAfterSave);
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
    const { matches, allFrames } = parseSource(source.value);
    targets.textContent = `Matches ${matches.join(", ")}${allFrames ? " · runs in frames too" : ""}`;
  } catch {
    targets.textContent = "Add site rules under Set name and sites.";
  }
}

function isDirty() {
  const baseline = (loaded?.source ?? draftBaseline).replace(/\r\n?/g, "\n");
  return source.value !== baseline || enabled.checked !== (loaded?.enabled ?? false);
}

function updateDraftState() {
  draftState.textContent = isDirty() ? "Unsaved changes" : "";
}

function canLeave() {
  return !isDirty() || confirm("Discard unsaved changes?");
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? "The script manager did not respond.");
  registrationState = response.state;
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
  const granted = await chrome.permissions.request({ origins: originsFor(parseSource(script.source).matches) });
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
  const { matches } = parseSource(script.source);
  const tabs = await chrome.tabs.query({ url: matches });
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
for (const control of [filter, tagFilter, sort]) control.addEventListener("change", renderLibrary);
enabled.addEventListener("change", updateDraftState);
pauseAll.addEventListener("change", () => sendSettings({ paused: pauseAll.checked }));
document.querySelector("#resume").addEventListener("click", () => sendSettings({ paused: false }));
reloadAfterSave.addEventListener("change", () => sendSettings({ reloadAfterSave: reloadAfterSave.checked }));
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
    source.value = next;
    source.setSelectionRange(next.length, next.length);
    setup.open = false;
    refreshSource();
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

source.addEventListener("input", refreshSource);
source.addEventListener("selectionchange", () => {
  updateEditor();
  refreshHighlight();
});
source.addEventListener("blur", refreshHighlight);
source.addEventListener("scroll", syncGutter);

function primary(event) {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

document.addEventListener("keydown", event => {
  if (event.isComposing || event.altKey || event.shiftKey || review.open || !primary(event)) return;
  const key = event.key.toLowerCase();
  if (key === "s") {
    event.preventDefault();
    if (!busy && !event.repeat) form.requestSubmit(saveButton);
  } else if (key === "f" && form.contains(document.activeElement)) {
    event.preventDefault();
    openFind();
  }
});

function applyEdit({ from, to, text, selectionStart, selectionEnd }) {
  source.focus();
  source.setSelectionRange(from, to);
  // execCommand keeps the edit on the textarea's native undo stack.
  document.execCommand("insertText", false, text);
  source.setSelectionRange(selectionStart, selectionEnd);
}

source.addEventListener("keydown", event => {
  if (event.isComposing || event.altKey || event.shiftKey) return;
  const lineCommands = { "]": "indent", "[": "outdent", "/": "comment" };
  if (primary(event) && lineCommands[event.key]) {
    event.preventDefault();
    applyEdit(editLines(source.value, source.selectionStart, source.selectionEnd, lineCommands[event.key]));
  } else if (!event.ctrlKey && !event.metaKey && event.key === "Enter") {
    const beforeCaret = source.value.slice(0, source.selectionStart);
    const line = beforeCaret.slice(beforeCaret.lastIndexOf("\n") + 1);
    const indent = line.match(/^[ \t]*/)[0];
    if (!indent && !line.trimEnd().endsWith("{")) return;
    event.preventDefault();
    document.execCommand("insertText", false, "\n" + indent + (line.trimEnd().endsWith("{") ? "  " : ""));
  }
});

function updateFindCount() {
  const matches = findMatches(source.value, findInput.value, findCase.checked);
  const position = currentMatch ? matches.indexOf(currentMatch.start) + 1 : 0;
  findCount.textContent = !findInput.value ? "" : !matches.length ? "No matches"
    : position ? `${position} of ${matches.length}` : `${matches.length} matches`;
}

function findStep(direction, from = source.selectionStart) {
  const matches = findMatches(source.value, findInput.value, findCase.checked);
  let start;
  if (direction > 0) start = matches.find(index => index >= from) ?? matches[0];
  else start = matches.findLast(index => index < from) ?? matches.at(-1);
  currentMatch = start === undefined ? undefined : { start, end: start + findInput.value.length };
  if (currentMatch) {
    source.setSelectionRange(currentMatch.start, currentMatch.end);
    scrollToOffset(currentMatch.start);
  }
  refreshHighlight();
  updateFindCount();
}

function openFind() {
  findBar.hidden = false;
  const selected = source.value.slice(source.selectionStart, source.selectionEnd);
  if (selected && !selected.includes("\n")) findInput.value = selected;
  findInput.focus();
  findInput.select();
  findStep(1, source.selectionStart);
}

function closeFind() {
  findBar.hidden = true;
  currentMatch = undefined;
  refreshHighlight();
  source.focus();
}

findInput.addEventListener("input", () => findStep(1, currentMatch?.start ?? source.selectionStart));
findCase.addEventListener("change", () => findStep(1, currentMatch?.start ?? 0));
document.querySelector("#find-next").addEventListener("click", () => findStep(1, (currentMatch?.start ?? -1) + 1));
document.querySelector("#find-previous").addEventListener("click", () => findStep(-1, currentMatch?.start ?? source.selectionStart));
document.querySelector("#find-close").addEventListener("click", closeFind);
for (const input of [findInput, replaceInput]) {
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    } else if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      if (input === replaceInput) document.querySelector("#replace-one").click();
      else findStep(event.shiftKey ? -1 : 1, event.shiftKey ? currentMatch?.start ?? 0 : (currentMatch?.start ?? -1) + 1);
    }
  });
}
document.querySelector("#replace-one").addEventListener("click", () => {
  if (!currentMatch) return findStep(1);
  const { start, end } = currentMatch;
  applyEdit({ from: start, to: end, text: replaceInput.value, selectionStart: start, selectionEnd: start + replaceInput.value.length });
  findStep(1, start + replaceInput.value.length);
  replaceInput.focus();
});
document.querySelector("#replace-all").addEventListener("click", () => {
  const matches = findMatches(source.value, findInput.value, findCase.checked);
  if (!matches.length) return;
  let next = source.value;
  for (const start of matches.toReversed()) next = next.slice(0, start) + replaceInput.value + next.slice(start + findInput.value.length);
  const { scrollTop } = source;
  applyEdit({ from: 0, to: source.value.length, text: next, selectionStart: 0, selectionEnd: 0 });
  source.scrollTop = scrollTop;
  currentMatch = undefined;
  refreshSource();
  findCount.textContent = `Replaced ${matches.length}`;
  replaceInput.focus();
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

newButton.addEventListener("click", () => {
  if (!canLeave()) return;
  const choices = element("div", undefined, "template-list");
  for (const template of templates) {
    const button = makeButton("", () => {
      review.close();
      select(undefined, false, template.source);
      setup.open = true;
      populateSetup();
      setupName.focus();
      setupName.select();
    });
    button.append(element("strong", template.name), element("span", template.description));
    choices.append(button);
  }
  openReview("Start a new script", choices);
});

form.addEventListener("submit", event => {
  event.preventDefault();
  perform(async () => {
    const { name, matches } = validate(source.value);
    const script = {
      id: selectedId ?? crypto.randomUUID(),
      name,
      source: source.value,
      enabled: enabled.checked
    };
    const wasEnabled = Boolean(loaded?.enabled);
    if (script.enabled) {
      const granted = await chrome.permissions.request({ origins: originsFor(matches) });
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
      element("span", ` — ${entry.matches.join(", ")}${entry.excludeMatches.length ? `; excludes ${entry.excludeMatches.join(", ")}` : ""}`),
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

function renderDiff(before, after) {
  const rows = diffLines(before, after);
  const output = element("pre", undefined, "diff");
  const changed = rows.map(row => row.kind !== "same");
  const near = index => changed.slice(Math.max(0, index - 3), index + 4).some(Boolean);
  let hidden = 0;
  const flush = () => {
    if (hidden) output.append(element("span", `… ${hidden} unchanged line${hidden === 1 ? "" : "s"}\n`, "diff-skip"));
    hidden = 0;
  };
  rows.forEach((row, index) => {
    if (!near(index)) {
      hidden++;
      return;
    }
    flush();
    output.append(element("span", `${{ same: " ", added: "+", removed: "-" }[row.kind]} ${row.text}\n`, `diff-${row.kind}`));
  });
  flush();
  if (!changed.some(Boolean)) return element("p", "This version matches the editor.");
  return output;
}

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
          renderDiff(version.source, source.value), makeButton("Back to history", showHistory));
      } catch (error) {
        status.textContent = error.message;
      }
    }), makeButton("Load into editor", () => {
      if (!canLeave()) return;
      source.value = version.source;
      source.setSelectionRange(0, 0);
      source.scrollTop = source.scrollLeft = 0;
      refreshSource();
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
      return metadata && originsFor(metadata.matches).includes(origin);
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

function showBackup() {
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = Boolean(settings.syncBackup);
  toggle.addEventListener("change", () => {
    review.close();
    sendSettings({ syncBackup: toggle.checked }).then(() => showBackup());
  });
  const label = element("label", undefined, "toggle");
  label.append(toggle, " Back up script sources to Chrome sync after every change");
  const state = settings.syncBackup
    ? syncState?.error ? `Last attempt failed: ${syncState.error}` : syncState?.at ? `Last synced ${timeAgo(syncState.at)}.` : "Waiting for the next change."
    : "Chrome sync backup is off.";
  openReview("Backup settings",
    element("p", settings.lastExportAt ? `Last exported ${new Date(settings.lastExportAt).toLocaleString()}.` : "You haven’t exported a backup yet."),
    label,
    element("p", `${state} Sync holds up to about 100 KB and stores sources only, not history, site access, or enabled settings.`, "backup-help"),
    makeButton("Restore from Chrome sync", () => perform(async () => {
      const { text, savedAt } = await readSyncBackup();
      reviewImport(decodeImport(text, true), `Chrome sync (${new Date(savedAt).toLocaleString()})`);
    })));
}
backupButton.addEventListener("click", showBackup);

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
  const context = await chrome.storage.session.get(["diagnosticUrl", "runs", "focusScript", "focusMessage"]);
  runs = context.runs ?? {};
  diagnosticUrl.value = context.diagnosticUrl ?? "";
  if (diagnosticUrl.value) showDiagnostics(true);
  select(scripts.find(item => item.id === context.focusScript) ?? scripts[0]);
  await send({ type: "sync" });
  if (selectedId) status.textContent = context.focusMessage || registrationMessage(selectedId);
  if (context.focusScript) chrome.storage.session.remove(["focusScript", "focusMessage"]);
});

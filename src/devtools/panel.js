// The Tailorscript tab in DevTools: lists the inspected page's elements, lets the user drag them onto actions to build
// a recipe of steps, tests the recipe on the page and saves it as a userscript. Page access goes through probe.js.
import { highlight } from "../guide/render.js";
import { $ } from "../shared/dom.js";
import { readScripts } from "../shared/storage.js";
import { parseSource } from "../shared/userscript.js";
import { actions, compile, createRunner, defaultAction, describeStep, generateRecipe, readRecipe, stepLabel, stepProblem } from "./generator.js";
import { previewPage } from "./preview.js";
import { probe } from "./probe.js";

const inspected = chrome.devtools.inspectedWindow;
// DevTools has its own light or dark setting, which can differ from the system's.
const theme = chrome.devtools.panels?.themeName;
if (theme) document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";

const elements = $("#elements");
const stepsList = $("#steps");
const workspace = $("#workspace");
const palette = $("#palette");
const status = $("#status");
const site = $("#site");
const search = $("#search", HTMLInputElement);
const name = $("#name", HTMLInputElement);
const preview = $("#preview");
const summary = $("#summary");
const code = $("#code", HTMLDetailsElement);
const scope = $("#scope", HTMLSelectElement);
const watch = $("#watch", HTMLInputElement);
const previewMessage = $("#preview-message");
const save = $("#save-recipe", HTMLButtonElement);
const saved = $("#saved", HTMLSelectElement);
const test = $("#test", HTMLButtonElement);
const undo = $("#undo", HTMLButtonElement);
const copy = $("#copy", HTMLButtonElement);
const scan = $("#scan", HTMLButtonElement);
const pick = $("#pick", HTMLButtonElement);
const selected = $("#selected", HTMLButtonElement);
const enabled = $("#enabled", HTMLInputElement);
const enabledLabel = $("#enabled-label");
const openManager = $("#open-manager", HTMLButtonElement);
const draftState = $("#draft-state");
const stepSummary = $("#step-summary");
const stepCount = $("#step-count");
const nextIssue = $("#next-issue", HTMLButtonElement);
const recovery = $("#recovery");
const recoveryMessage = $("#recovery-message");
const resumeDraft = $("#resume-draft", HTMLButtonElement);
const discardDraft = $("#discard-draft", HTMLButtonElement);
const workspaceContent = $("main");

const kinds = {
  overlay: "Pinned bars and pop-ups", button: "Buttons", field: "Fields", link: "Links",
  heading: "Headings", media: "Images and media", section: "Page sections"
};
const blankRecipe = { version: 2, name: "Page customizations", page: "", scope: "site", watch: false, steps: [] };
const draftPrefix = "builderDraft:";

let issueCursor = -1;
let page = "";
let draftPage = "";
let scanVersion = 0;
let items = [];
let selectedItem;
// What is being dragged: { item } from the element list, or { step } when reordering.
let dragged = null;
const steps = [];
let activePick;
let diagnosticVersion = 0;
let diagnosticTimer;
const stepMessages = [];
const stepResults = [];
let current;
let library = [];
let baseline = "";
let generated = "";
let pendingDraft;
let draftWrites = Promise.resolve();
let lastDraftKey;
let lastDraftJSON;
let saving = false;

function say(text, kind = "info") {
  status.textContent = text;
  status.dataset.kind = kind;
}

function report(error) {
  say(error.message, "error");
}

function make(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function button(label, click, className) {
  const control = make("button", className, label);
  control.type = "button";
  control.addEventListener("click", click);
  return control;
}

function inspect(command, argument = "null") {
  return evaluate(`(${probe.toString()})(${JSON.stringify(command)}, ${argument})`);
}

function evaluate(expression) {
  return new Promise((resolve, reject) => {
    inspected.eval(expression, (result, error) => {
      if (error) reject(new Error("Couldn’t inspect this page. Try an ordinary web page and scan again."));
      else resolve(result);
    });
  });
}

// Outlines a selector's matches on the page a moment after the pointer settles; null clears the outline.
let highlightTimer;
function highlightSoon(selector) {
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    if (!activePick) inspect("highlight", JSON.stringify(selector ?? null)).catch(() => {});
  }, selector ? 80 : 150);
}

/* Drafts: unsaved work is kept per site so closing DevTools doesn't lose it. */

function storeDraft(data, dirty) {
  if (pendingDraft) return;
  const address = data.page || current && readRecipe(current.source)?.page || page;
  if (!address) return;
  const key = draftPrefix + new URL(address).origin;
  const entry = { data, id: current?.id, updatedAt: current?.updatedAt };
  const json = dirty ? JSON.stringify(entry) : "";
  if (key === lastDraftKey && json === lastDraftJSON) return;
  if (!dirty && lastDraftKey !== key) return;
  lastDraftKey = key;
  lastDraftJSON = json;
  draftWrites = draftWrites.then(() => dirty ? chrome.storage.local.set({ [key]: JSON.parse(json) })
    : chrome.storage.local.remove(key)).catch(error => {
    lastDraftJSON = undefined;
    report(error);
  });
}

async function offerDraft() {
  if (!page || pendingDraft || baseline !== JSON.stringify(recipe())) return;
  const key = draftPrefix + new URL(page).origin;
  const entry = (await chrome.storage.local.get(key))[key];
  if (!entry || typeof entry !== "object" || !("data" in entry) || !entry.data ||
      typeof entry.data !== "object" || !("name" in entry.data) || /** @type {any} */ (entry.data).version !== blankRecipe.version ||
      pendingDraft || !page || key !== draftPrefix + new URL(page).origin || baseline !== JSON.stringify(recipe())) return;
  pendingDraft = { key, entry };
  recoveryMessage.textContent = `You have unsaved work on “${entry.data?.name || "Untitled recipe"}” for this site.`;
  recovery.hidden = false;
  workspaceContent.inert = true;
  saved.disabled = true;
  save.disabled = true;
}

function closeRecovery() {
  pendingDraft = undefined;
  recovery.hidden = true;
  workspaceContent.inert = false;
  saved.disabled = false;
}

resumeDraft.addEventListener("click", async () => {
  if (!pendingDraft) return;
  const draft = pendingDraft;
  try {
    await refreshLibrary();
    if (pendingDraft !== draft) return;
    const { entry } = draft;
    const original = library.find(item => item.id === entry.id && item.updatedAt === entry.updatedAt);
    closeRecovery();
    load(original, entry.data);
    saved.value = original?.id ?? "";
    name.focus();
    say(entry.id && !original ? "The saved recipe changed. Draft recovered as a new recipe." : "Draft recovered.", "success");
  } catch (error) {
    report(error);
  }
});

discardDraft.addEventListener("click", async () => {
  if (!pendingDraft) return;
  try {
    await chrome.storage.local.remove(pendingDraft.key);
    closeRecovery();
    refreshPreview();
    saved.focus();
  } catch (error) {
    report(error);
  }
});

/* The element list. */

// Adds a step for an element: with the given action or the usual one for its kind, at index or the end,
// and for every element like it when group is set.
/** @param {any} item @param {{ action?: string, index?: number, group?: boolean }} [options] */
function add(item, { action, index = steps.length, group = false } = {}) {
  if (!page || !item?.selector || item.matches !== 1) {
    report(new Error("That element can’t be used. Choose one in the top-level page."));
    return;
  }
  const origin = new URL(page).origin;
  if (draftPage && new URL(draftPage).origin !== origin) {
    report(new Error("These steps belong to another site. Remove them before adding elements from this page."));
    return;
  }
  draftPage ||= page;
  const everyone = group && item.group;
  const step = {
    selector: everyone ? item.group.selector : item.selector, label: item.label, action: action ?? defaultAction(item.kind),
    values: {}, all: Boolean(everyone), valid: true, expectedCount: everyone ? undefined : 1, tag: item.tag,
    one: item.selector, group: item.group ?? undefined, plain: item.plain
  };
  steps.splice(index, 0, step);
  renderSteps();
  say(`Added “${item.label}” as step ${index + 1}.`, "success");
  /** @type {HTMLElement} */ (stepsList.children[index]?.querySelector(".step-action input:not([hidden])"))?.focus();
}

function select(item) {
  selectedItem = selectedItem === item ? undefined : item;
  renderElements();
}

function renderItem(item) {
  const row = make("li", "item");
  const positional = item.basis === "Position-based";
  const label = button(item.label, () => select(item), "item-label");
  label.title = item.selector;
  label.setAttribute("aria-expanded", String(selectedItem === item));
  const head = make("div", "item-row", label);
  if (positional) head.append(make("span", "tag", "by position"));
  const addButton = button("Add", () => add(item), "add");
  addButton.setAttribute("aria-label", `Add ${item.label}`);
  head.append(addButton);
  row.append(head);
  if (selectedItem === item) {
    row.classList.add("selected");
    const detail = make("div", "item-detail", make("code", "", item.selector),
      make("span", positional ? "warn" : "", positional
        ? "Found by its position on the page, so it may stop matching if the layout changes."
        : `Found by its ${item.basis.toLowerCase()}.`));
    if (item.group) detail.append(button(`Add all ${item.group.count} like this`, () => add(item, { group: true })));
    row.append(detail);
  }
  row.draggable = true;
  row.addEventListener("dragstart", event => {
    dragged = { item };
    event.dataTransfer.setData("text/plain", item.selector);
    event.dataTransfer.effectAllowed = "copy";
    workspace.classList.add("dragging");
  });
  row.addEventListener("dragend", clearDrag);
  row.addEventListener("mouseenter", () => highlightSoon(item.selector));
  row.addEventListener("mouseleave", () => highlightSoon(null));
  row.addEventListener("focusin", () => highlightSoon(item.selector));
  return row;
}

function renderElements() {
  const query = search.value.trim().toLowerCase();
  const visible = items.filter(item => [item.label, kinds[item.kind], item.selector].some(value => value.toLowerCase().includes(query)));
  elements.replaceChildren(...Object.entries(kinds).flatMap(([kind, title]) => {
    const group = visible.filter(item => item.kind === kind);
    if (!group.length) return [];
    return [make("section", "", make("h3", "", `${title} · ${group.length}`), make("ul", "", ...group.map(renderItem)))];
  }));
  if (!visible.length) {
    elements.append(make("p", "empty", items.length ? "No elements match your search." : "No elements found. Choose Scan, or Pick on page."));
  }
}

/* The recipe. */

function recipe() {
  return {
    version: blankRecipe.version, name: name.value, page: draftPage, scope: scope.value, watch: watch.checked,
    steps: steps.map(({ selector, label, action, values, all, expectedCount, tag, one, group, plain }) => ({
      selector, label, action, value: values[action], all, expectedCount, tag, one, group, plain
    }))
  };
}

function renderCode() {
  if (!code.open) return;
  preview.replaceChildren(...highlight(generated).map(({ text, kind }) => kind ? make("span", `tok-${kind}`, text) : text));
  summary.replaceChildren(...recipe().steps.filter(step => !stepProblem(step)).map(step => make("li", "", describeStep(step))));
}
code.addEventListener("toggle", renderCode);

function refreshPreview() {
  const data = recipe();
  const usable = data.steps.filter(step => !stepProblem(step));
  const available = usable.length > 0 && Boolean(draftPage) && steps.every(step => step.valid);
  previewMessage.textContent = steps.some(step => !step.valid) ? "Fix the selectors marked above to see the code."
    : !available ? "Add a step to see the code." : usable.length < steps.length ? "Unfinished steps are left out." : "";
  generated = available ? generateRecipe(data) : "";
  copy.disabled = test.disabled = !available;
  const dirty = baseline !== JSON.stringify(data);
  storeDraft(data, dirty);
  save.disabled = !available || saving || !dirty || Boolean(pendingDraft);
  draftState.textContent = saving ? "Saving…" : dirty ? "Unsaved changes" : current ? "Saved" : "";
  stepCount.textContent = steps.length ? `(${steps.length})` : "";
  enabledLabel.hidden = openManager.hidden = !current;
  enabled.checked = Boolean(current?.enabled);
  const address = draftPage || page;
  if (address) {
    const url = new URL(address);
    scope.options[0].text = `Every page on ${url.host}`;
    scope.options[1].text = `Only ${url.host}${url.pathname}`;
  }
  for (const result of stepResults) result.textContent = "";
  renderCode();
  diagnoseSteps();
}

function updateStepSummary() {
  const issues = stepMessages.filter(message => message.dataset.state === "warning").length;
  const count = steps.length;
  stepSummary.textContent = count ? `${count} ${count === 1 ? "step" : "steps"}${issues ? ` · ${issues} need attention` : ""}` : "";
  nextIssue.hidden = !issues;
}

nextIssue.addEventListener("click", () => {
  const indices = stepMessages.flatMap((message, index) => message.dataset.state === "warning" ? [index] : []);
  issueCursor = indices.find(index => index > issueCursor) ?? indices[0] ?? -1;
  if (issueCursor < 0) return;
  const row = stepsList.children[issueCursor];
  row.querySelector("select")?.focus();
  row.scrollIntoView({ block: "nearest" });
});

// Checks each step's selector against the page as it is now.
function diagnoseSteps() {
  const version = ++diagnosticVersion;
  clearTimeout(diagnosticTimer);
  for (const message of stepMessages) {
    message.textContent = "";
    delete message.dataset.state;
  }
  updateStepSummary();
  if (!page || !steps.length) return;
  const inspectedPage = new URL(page);
  const targetPage = new URL(draftPage);
  if (inspectedPage.origin !== targetPage.origin ||
      (scope.value === "path" && inspectedPage.pathname !== targetPage.pathname)) {
    for (const message of stepMessages) {
      message.textContent = "This page is outside where the recipe runs";
      message.dataset.state = "warning";
    }
    updateStepSummary();
    return;
  }
  diagnosticTimer = setTimeout(async () => {
    try {
      const targets = steps.map(({ selector, expectedCount, tag, all }) => ({ selector, expectedCount, tag, all }));
      const messages = await inspect("diagnose", JSON.stringify(targets));
      if (version !== diagnosticVersion) return;
      messages.forEach((message, index) => {
        const ready = message.startsWith("Ready");
        stepMessages[index].textContent = ready ? message.replace("Ready", "Found on this page") : `${message}. Open Advanced to fix it or change the element.`;
        stepMessages[index].dataset.state = ready ? "ready" : "warning";
      });
      updateStepSummary();
    } catch (error) {
      if (version === diagnosticVersion) report(error);
    }
  }, 180);
}

/* Picking an element by clicking it on the page. */

async function stopPicking() {
  if (!activePick) return;
  clearTimeout(activePick.timer);
  activePick = undefined;
  pick.textContent = "Pick on page";
  pick.setAttribute("aria-pressed", "false");
  await inspect("pick-stop");
}

// Lets the user click one element on the page and passes its description to use().
async function pickElement(prompt, use) {
  if (activePick) {
    await stopPicking();
    say("Picking cancelled.");
    return;
  }
  const picking = { timer: undefined };
  activePick = picking;
  try {
    await stopPreview();
    if (activePick !== picking) return;
    await inspect("pick-start");
    if (activePick !== picking) return;
    pick.textContent = "Cancel picking";
    pick.setAttribute("aria-pressed", "true");
    say(`${prompt} Press Escape there to cancel.`);
    async function poll() {
      if (activePick !== picking) return;
      try {
        const result = await inspect("pick-poll");
        if (activePick !== picking) return;
        if (!result) {
          picking.timer = setTimeout(poll, 200);
          return;
        }
        await stopPicking();
        if (result.cancelled) say("Picking cancelled.");
        else if (!result.selector || result.matches !== 1) say("Couldn’t use that element. Try another one.", "error");
        else use(result);
      } catch (error) {
        await stopPicking().catch(() => {});
        report(error);
      }
    }
    poll();
  } catch (error) {
    await stopPicking().catch(() => {});
    report(error);
  }
}

function pickReplacement(step) {
  if (!activePick && (!page || new URL(page).origin !== new URL(draftPage).origin)) {
    say("Open the recipe’s site to change this element.", "error");
    return Promise.resolve();
  }
  return pickElement("Click the new element on the page.", result => {
    if (!steps.includes(step)) return;
    Object.assign(step, {
      selector: result.selector, one: result.selector, group: result.group ?? undefined, plain: undefined, tag: result.tag, label: result.label,
      valid: true, all: false, expectedCount: 1
    });
    renderSteps();
    say("Element changed. Test it before saving.", "success");
  });
}

pick.addEventListener("click", () => pickElement("Click an element on the page to add it.", result => add(result)).catch(report));

/* Step cards. */

function validSelector(selector) {
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

function moveStep(step, to) {
  const from = steps.indexOf(step);
  if (from < 0) return;
  steps.splice(from, 1);
  steps.splice(to > from ? to - 1 : to, 0, step);
  renderSteps();
}

function renderStep(step, index) {
  const row = make("li", "step");
  const diagnostic = make("p", "target-status");
  diagnostic.setAttribute("role", "status");
  stepMessages.push(diagnostic);
  const result = make("p", "test-result");
  result.setAttribute("role", "status");
  stepResults.push(result);
  const problem = make("p", "step-problem", stepProblem({ action: step.action, value: step.values[step.action] }));

  const handle = make("span", "handle", "⠿");
  handle.draggable = true;
  handle.title = "Drag to reorder";
  handle.setAttribute("aria-hidden", "true");
  handle.addEventListener("dragstart", event => {
    dragged = { step };
    event.dataTransfer.setData("text/plain", step.selector);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setDragImage(row, 12, 12);
    row.classList.add("moving");
  });
  handle.addEventListener("dragend", clearDrag);
  const title = make("strong", "", `${index + 1}. ${stepLabel(step)}`);
  title.title = stepLabel(step);
  const up = button("↑", () => {
    moveStep(step, index - 1);
    /** @type {HTMLElement} */ (stepsList.children[index - 1].querySelector(".step-head button"))?.focus();
  });
  up.setAttribute("aria-label", `Move step ${index + 1} up`);
  up.disabled = index === 0;
  const down = button("↓", () => {
    moveStep(step, index + 2);
    /** @type {HTMLElement} */ (stepsList.children[index + 1].querySelectorAll(".step-head button")[1])?.focus();
  });
  down.setAttribute("aria-label", `Move step ${index + 1} down`);
  down.disabled = index === steps.length - 1;
  const remove = button("✕", () => {
    steps.splice(index, 1);
    if (!steps.length && !current) draftPage = "";
    renderSteps();
    if (steps.length) stepsList.children[Math.min(index, steps.length - 1)].querySelector("select")?.focus();
    else search.focus();
  });
  remove.setAttribute("aria-label", `Remove step ${index + 1}`);
  const head = make("div", "step-head", handle, title, up, down, remove);

  const choice = document.createElement("select");
  choice.setAttribute("aria-label", `Action for step ${index + 1}`);
  for (const [value, { title: text }] of Object.entries(actions)) choice.add(new Option(text, value));
  choice.value = step.action;
  const input = document.createElement("input");
  const unit = make("span", "");
  function updateValueField() {
    const field = actions[step.action].value;
    input.hidden = !field;
    unit.textContent = field?.unit ?? "";
    if (!field) return;
    input.type = field.type === "key" ? "text" : field.type;
    input.maxLength = field.type === "key" ? 1 : 200;
    input.min = "8";
    input.max = "96";
    input.placeholder = field.placeholder ?? "";
    input.setAttribute("aria-label", actions[step.action].title);
    input.value = step.values[step.action] ?? field.initial ?? "";
  }
  updateValueField();
  input.addEventListener("input", () => {
    step.values[step.action] = input.value;
    problem.textContent = stepProblem({ action: step.action, value: input.value });
    refreshPreview();
  });
  choice.addEventListener("change", () => {
    step.action = choice.value;
    updateValueField();
    problem.textContent = stepProblem({ action: step.action, value: step.values[step.action] });
    refreshPreview();
    if (!input.hidden) input.focus();
  });
  const action = make("div", "step-action", choice, input, unit);

  const target = make("div", "step-target", diagnostic);
  if (step.group && step.one) {
    // Repeated elements, such as each product's button, can be changed one at a time or all together.
    const which = document.createElement("select");
    which.setAttribute("aria-label", `Which elements step ${index + 1} changes`);
    which.add(new Option("Only this one", "one"));
    which.add(new Option(`All ${step.group.count} like this`, "group"));
    which.value = step.all && step.selector === step.group.selector ? "group" : "one";
    which.addEventListener("change", () => {
      const everyone = which.value === "group";
      Object.assign(step, {
        selector: everyone ? step.group.selector : step.one, all: everyone, expectedCount: everyone ? undefined : 1,
        valid: true
      });
      renderSteps();
    });
    target.prepend(which);
  }

  const selector = document.createElement("input");
  selector.value = step.selector;
  selector.spellcheck = false;
  selector.setAttribute("aria-invalid", String(!step.valid));
  const selectorMessage = make("span", "selector-message", step.valid ? "" : "This isn’t a valid CSS selector.");
  selector.addEventListener("input", () => {
    step.selector = selector.value.trim();
    step.valid = validSelector(step.selector);
    selector.setAttribute("aria-invalid", String(!step.valid));
    selectorMessage.textContent = step.valid ? "" : "This isn’t a valid CSS selector.";
    refreshPreview();
  });
  const all = document.createElement("input");
  all.type = "checkbox";
  all.checked = step.all;
  const count = document.createElement("input");
  count.type = "number";
  count.min = "1";
  count.placeholder = "Any number";
  count.value = step.expectedCount ?? "";
  all.addEventListener("change", () => {
    step.all = all.checked;
    if (all.checked) {
      count.value = "";
      step.expectedCount = undefined;
    }
    refreshPreview();
  });
  count.addEventListener("input", () => {
    step.expectedCount = Number.isInteger(count.valueAsNumber) && count.valueAsNumber > 0 ? count.valueAsNumber : undefined;
    refreshPreview();
  });
  const tag = document.createElement("input");
  tag.placeholder = "Any";
  tag.value = step.tag ?? "";
  tag.addEventListener("input", () => {
    step.tag = tag.value.trim().toLowerCase() || undefined;
    refreshPreview();
  });
  const advanced = document.createElement("details");
  advanced.open = Boolean(step.advancedOpen) || !step.valid;
  advanced.addEventListener("toggle", () => { step.advancedOpen = advanced.open; });
  advanced.append(make("summary", "", "Advanced"), make("div", "advanced",
    make("label", "target-field", "CSS selector", selector, selectorMessage),
    make("label", "", "Skip unless this many match", count),
    make("label", "", "Skip unless the element is a", tag),
    make("label", "check", all, "Change every match"),
    button("Change element…", () => pickReplacement(step).catch(report))));

  row.append(head, action, problem, target, result, advanced);
  row.addEventListener("mouseenter", () => { if (step.valid) highlightSoon(step.selector); });
  row.addEventListener("mouseleave", () => highlightSoon(null));
  return row;
}

function renderSteps() {
  issueCursor = -1;
  stepMessages.length = 0;
  stepResults.length = 0;
  stepsList.replaceChildren(...steps.map(renderStep));
  refreshPreview();
}

/* Drag and drop: elements onto an action or into the list, and steps within the list. */

function clearDrag() {
  dragged = null;
  workspace.classList.remove("dragging");
  for (const node of document.querySelectorAll(".drop-before, .drop-after, .moving, .over")) {
    node.classList.remove("drop-before", "drop-after", "moving", "over");
  }
}

// Where a drop at this height would land among the steps.
function dropIndex(y) {
  const rows = [...stepsList.children];
  const index = rows.findIndex(row => {
    const rect = row.getBoundingClientRect();
    return y < rect.top + rect.height / 2;
  });
  return index < 0 ? rows.length : index;
}

workspace.addEventListener("dragover", event => {
  if (!dragged) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = dragged.step ? "move" : "copy";
  for (const row of stepsList.children) row.classList.remove("drop-before", "drop-after");
  const index = dropIndex(event.clientY);
  if (stepsList.children[index]) stepsList.children[index].classList.add("drop-before");
  else stepsList.lastElementChild?.classList.add("drop-after");
});
workspace.addEventListener("drop", event => {
  if (!dragged) return;
  event.preventDefault();
  const index = dropIndex(event.clientY);
  if (dragged.step) moveStep(dragged.step, index);
  else add(dragged.item, { index });
  clearDrag();
});

for (const [action, { label, title }] of Object.entries(actions)) {
  const chip = button(label, () => {
    if (selectedItem) add(selectedItem, { action });
    else say("Select an element in the list first, or drag one onto an action.");
  });
  chip.title = title;
  chip.addEventListener("dragover", event => {
    if (!dragged?.item) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    chip.classList.add("over");
  });
  chip.addEventListener("dragleave", () => chip.classList.remove("over"));
  chip.addEventListener("drop", event => {
    if (!dragged?.item) return;
    event.preventDefault();
    event.stopPropagation();
    add(dragged.item, { action });
    clearDrag();
  });
  palette.append(chip);
}

for (const tab of document.querySelectorAll(".views button")) {
  tab.addEventListener("click", () => {
    workspaceContent.dataset.view = /** @type {HTMLElement} */ (tab).dataset.view;
    for (const other of document.querySelectorAll(".views button")) other.setAttribute("aria-pressed", String(other === tab));
  });
}

search.addEventListener("input", renderElements);
name.addEventListener("input", refreshPreview);
scope.addEventListener("change", refreshPreview);
watch.addEventListener("change", refreshPreview);

/* Scanning. */

async function scanPage() {
  const version = ++scanVersion;
  scan.disabled = selected.disabled = pick.disabled = true;
  say("Scanning the page…");
  try {
    const result = await inspect("scan");
    if (version !== scanVersion) return;
    const url = new URL(result.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Open an HTTP or HTTPS page to use the builder.");
    page = url.href;
    site.textContent = draftPage && new URL(draftPage).origin !== url.origin
      ? `${url.host} · recipe is for ${new URL(draftPage).host}` : url.host;
    items = result.items;
    selectedItem = undefined;
    say(`Found ${items.length} elements. Point at one to see it on the page.`
      + (result.limited ? " The page has more than the list shows: use Pick on page for anything missing." : ""));
  } catch (error) {
    if (version !== scanVersion) return;
    page = "";
    site.textContent = "";
    items = [];
    report(error);
  } finally {
    if (version === scanVersion) {
      scan.disabled = selected.disabled = pick.disabled = false;
      renderElements();
      refreshPreview();
    }
  }
}

scan.addEventListener("click", scanPage);
selected.addEventListener("click", () => {
  inspect("describe", "typeof $0 === \"undefined\" ? null : $0").then(item => {
    if (item) add(item);
    else say("Select an element in the Elements panel first.", "error");
  }, report);
});
copy.addEventListener("click", () => {
  navigator.clipboard.writeText(generated).then(() => say("Code copied.", "success"),
    () => say("Couldn’t copy. Select the code and use your copy shortcut.", "error"));
});

/* Saved recipes. */

async function refreshLibrary() {
  const scripts = await readScripts();
  library = scripts.filter(item => readRecipe(item.source));
  // A change made elsewhere, such as turning the script on, must not look like a conflicting edit when saving.
  const fresh = current && scripts.find(item => item.id === current.id);
  if (fresh && fresh.source === current.source) current = fresh;
  saved.replaceChildren(new Option("New recipe", ""), ...library.map(item => new Option(item.name, item.id)));
  saved.value = current?.id ?? "";
  enabled.checked = Boolean(current?.enabled);
}

function load(script, recovered) {
  const stored = script && readRecipe(script.source);
  const data = recovered ?? stored;
  current = script;
  draftPage = data?.page ?? "";
  name.value = data?.name ?? blankRecipe.name;
  scope.value = data?.scope ?? blankRecipe.scope;
  watch.checked = data?.watch ?? false;
  steps.splice(0, steps.length, ...(data?.steps ?? []).map(step => ({
    ...step, values: { [step.action]: step.value }, valid: validSelector(step.selector)
  })));
  baseline = recovered ? JSON.stringify(stored ?? blankRecipe) : JSON.stringify(recipe());
  renderSteps();
}

saved.addEventListener("change", () => {
  if (baseline !== JSON.stringify(recipe()) && !confirm("Discard unsaved recipe changes?")) {
    saved.value = current?.id ?? "";
    return;
  }
  if (baseline !== JSON.stringify(recipe())) storeDraft(recipe(), false);
  stopPicking().catch(() => {});
  stopPreview().catch(() => {});
  load(library.find(item => item.id === saved.value));
});

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? "Tailorscript’s worker did not respond.");
  return response;
}

save.addEventListener("click", async () => {
  const id = current?.id ?? crypto.randomUUID();
  const source = generated;
  const savedDraft = JSON.stringify(recipe());
  saving = true;
  saved.disabled = true;
  refreshPreview();
  try {
    await send({ type: "save", id, expected: current, script: { source, enabled: current?.enabled ?? false } });
    current = (await readScripts()).find(item => item.id === id);
    baseline = savedDraft;
    if (baseline === JSON.stringify(recipe())) storeDraft(recipe(), false);
    await refreshLibrary();
    say(current?.enabled ? "Saved. Reload the page to see it run." : "Saved, but not running yet. Turn it On to run it on this site.", "success");
  } catch (error) {
    report(error);
  } finally {
    saving = false;
    saved.disabled = false;
    refreshPreview();
  }
});

enabled.addEventListener("change", async () => {
  if (!current) return;
  const wanted = enabled.checked;
  try {
    if (wanted) {
      const { origins } = parseSource(current.source);
      // Chrome asks for site access here; where DevTools can't show that prompt, the manager can.
      if (!chrome.permissions?.request) {
        enabled.checked = false;
        say("Chrome can’t ask for site access from DevTools here. Choose Open in manager and turn it on there.", "error");
        return;
      }
      if (!await chrome.permissions.contains({ origins }) && !await chrome.permissions.request({ origins })) {
        enabled.checked = false;
        say("Site access was declined, so the script stays off.", "error");
        return;
      }
    }
    await send({ type: "toggle", id: current.id, enabled: wanted });
    await refreshLibrary();
    say(wanted ? "On. Reload the page to see it run." : "Off. It won’t run on new page loads.", "success");
  } catch (error) {
    enabled.checked = !wanted;
    report(error);
  }
});

openManager.addEventListener("click", () => {
  send({ type: "open-manager", id: current?.id }).catch(report);
});

/* Testing on the page. */

function stopPreview() {
  undo.disabled = true;
  for (const result of stepResults) result.textContent = "";
  return evaluate(`(${previewPage.toString()})(null, null)`);
}

test.addEventListener("click", async () => {
  const draft = recipe();
  const usable = draft.steps.map((step, index) => ({ step, index })).filter(({ step }) => !stepProblem(step));
  const url = new URL(draft.page);
  const path = draft.scope === "path" ? url.pathname : null;
  try {
    const args = [compile(usable.map(({ step }) => step)), url.origin, path].map(value => JSON.stringify(value)).join(", ");
    const messages = await evaluate(`(${previewPage.toString()})(${createRunner.toString()}, ${args})`);
    if (messages.length !== usable.length) {
      say(messages[0] ?? "Nothing was tested.", "error");
      return;
    }
    let skipped = 0;
    messages.forEach((message, position) => {
      const result = stepResults[usable[position].index];
      result.textContent = `Test: ${message}`;
      result.dataset.state = message.startsWith("Skipped") ? "skipped" : "done";
      if (message.startsWith("Skipped")) skipped++;
    });
    undo.disabled = false;
    say(skipped ? `Tested. ${skipped} of ${messages.length} steps were skipped; each step says why.`
      : `Tested ${messages.length} ${messages.length === 1 ? "step" : "steps"} on the page. The changes stay until you choose Undo test or leave this tab.`,
    skipped ? "error" : "success");
  } catch (error) {
    report(error);
  }
});

undo.addEventListener("click", () => stopPreview().then(() => say("Test undone."), report));

chrome.devtools.network.onNavigated.addListener(() => {
  stopPicking().catch(() => {});
  stopPreview().catch(() => {});
  scanPage().then(offerDraft).catch(report);
});
window.addEventListener("builder-hidden", () => {
  clearDrag();
  stopPicking().catch(() => {});
  stopPreview().catch(() => {});
  inspect("highlight").catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && !saving && Object.keys(changes).some(key => !key.startsWith(draftPrefix))) {
    refreshLibrary().catch(report);
  }
});
load(undefined);
refreshLibrary().catch(report);
scanPage().then(offerDraft).catch(report);

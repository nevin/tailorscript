import { createLocator } from "./locator.js";

// What a step can do. `value` describes the extra input a step needs, `kinds` the elements it is the default for.
export const actions = {
  hide: { label: "Hide", title: "Hide element" },
  click: { label: "Click", title: "Click it automatically", kinds: ["button"] },
  fill: { label: "Fill in", title: "Fill in text", value: { type: "text", placeholder: "Text to enter" }, kinds: ["field"] },
  check: { label: "Tick", title: "Tick the box or choose the option", roles: ["checkbox", "radio", "switch"] },
  uncheck: { label: "Untick", title: "Untick the box" },
  choose: { label: "Choose", title: "Choose an option from the list", value: { type: "text", placeholder: "Option as it appears" }, roles: ["combobox", "listbox"] },
  text: { label: "Replace text", title: "Replace text", value: { type: "text", placeholder: "Replacement text" } },
  color: { label: "Text colour", title: "Change text colour", value: { type: "color", initial: "#0f8f82" } },
  background: { label: "Background", title: "Change background colour", value: { type: "color", initial: "#0f8f82" } },
  font: { label: "Font size", title: "Change font size", value: { type: "number", initial: "18", unit: "px" } },
  highlight: { label: "Outline", title: "Outline element" },
  note: { label: "Add note", title: "Add note after element", value: { type: "text", placeholder: "Note text" } },
  shortcut: { label: "Shortcut", title: "Click it with a key", value: { type: "key", placeholder: "Key, such as k" } },
  menu: { label: "Popup button", title: "Click it from the Tailorscript popup", value: { type: "text", placeholder: "Button caption" } }
};

// The action a new step starts with: ticking checkboxes and radios, choosing from lists, clicking buttons, filling in
// fields, hiding everything else. role comes from the element's description, when there is one.
export function defaultAction(kind, role = "") {
  return Object.keys(actions).find(action => actions[action].roles?.includes(role)) ??
    Object.keys(actions).find(action => actions[action].kinds?.includes(kind)) ?? "hide";
}

const styles = {
  hide: ["display", "none"],
  highlight: ["outline", "3px solid #0f8f82"],
  color: ["color"],
  background: ["background-color"],
  font: ["font-size"]
};

// A step is complete when it has what its action needs; an incomplete one is left out of the script.
export function stepProblem({ action, value }) {
  if (action === "shortcut" && !String(value ?? "").trim()) return "Type the key to press.";
  if (action === "menu" && !String(value ?? "").trim()) return "Type a caption for the popup button.";
  if (action === "choose" && !String(value ?? "").trim()) return "Type the option to choose, as it appears in the list.";
  return "";
}

export function compile(steps) {
  return steps.map(({ selector, text, action, value, all, expectedCount, tag, find }) => {
    if (!Object.hasOwn(actions, action) || typeof selector !== "string" || !selector.trim()) {
      throw new Error("Every step needs a selector and a supported action.");
    }
    const target = { selector, ...(text ? { text } : {}), ...(all ? { all: true } : {}), expectedCount, tag, ...(find ? { find } : {}) };
    if (action === "click") return { ...target, click: true };
    if (action === "fill") return { ...target, fill: value ?? "" };
    if (action === "check" || action === "uncheck") return { ...target, check: action === "check" };
    if (action === "choose") return { ...target, choose: String(value ?? "").trim() };
    if (action === "shortcut") return { ...target, key: String(value ?? "").trim().slice(0, 20).toLowerCase() };
    if (action === "menu") return { ...target, menu: String(value ?? "").trim().slice(0, 80) };
    if (action === "text" || action === "note") return { ...target, [action]: value ?? "" };
    const [property, fixed] = styles[action];
    const color = /^#[\da-f]{6}$/i.test(value ?? "") ? value : "#0f8f82";
    const size = Math.min(96, Math.max(8, Number(value) || 18));
    return { ...target, style: [property, fixed ?? (action === "font" ? `${size}px` : color)] };
  });
}

// Serialized into generated scripts and the inspected page. Keep it self-contained. locator is createLocator().
export function createRunner(steps, preview = false, locator = null) {
  const applied = steps.map(() => new WeakSet());
  const notes = new WeakSet();
  const undo = [];
  const onDemand = step => "key" in step || "menu" in step;
  // Form steps set a state rather than doing something once, so they are applied again whenever the page has undone
  // them, for example when a framework resets a form after it loads. A field you're typing in is left alone.
  const keepsState = step => "fill" in step || "check" in step || "choose" in step;

  // The elements a step applies to and how they were found, or a sentence saying why it is skipped.
  function targetsOf(step) {
    const { elements, how, invalid } = locator.locate(step);
    const matches = elements.filter(element => !notes.has(element));
    if (!matches.length) return invalid ? "Skipped · invalid selector, and nothing on the page fits the description" : "Skipped · no matches";
    if (step.expectedCount != null && matches.length !== step.expectedCount && how === "selector") {
      return `Skipped · expected ${step.expectedCount} match(es), found ${matches.length}`;
    }
    const targets = step.all ? matches : matches.slice(0, 1);
    return { matches, targets, how };
  }

  // The real control behind a web component, such as the <input> inside Ionic's ion-input.
  function control(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element;
    return element.shadowRoot?.querySelector("input, textarea, select") ?? element;
  }
  const events = element => {
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };
  // Sets a value the way typing does, so pages built with React, Angular, Vue or Ionic notice the change.
  function setValue(field, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
    if (field.isContentEditable && !setter) field.textContent = value;
    else if (setter) setter.call(field, value);
    else field.value = value;
    events(field);
  }
  const valueOf = field => field.isContentEditable && !("value" in field) ? field.textContent : field.value;
  const checkedOf = element => typeof element.checked === "boolean" ? element.checked
    : element.getAttribute("aria-checked") === "true" || element.getAttribute("aria-pressed") === "true";
  const busy = element => {
    const active = document.activeElement;
    return Boolean(active && (active === element || element.contains(active) || active.shadowRoot?.activeElement === element));
  };

  // Brings a form control to the state a step asks for. Returns true when something changed.
  function setState(element, step) {
    if ("check" in step) {
      if (checkedOf(element) === step.check) return false;
      const before = checkedOf(element);
      element.click();
      // Some styled controls hide the real input from clicks; set it directly then.
      if (checkedOf(element) === before && typeof element.checked === "boolean") {
        element.checked = step.check;
        events(element);
      }
      if (preview) undo.push(() => { if (checkedOf(element) !== before) element.click(); });
      return true;
    }
    const field = control(element);
    if ("choose" in step) {
      if (!(field instanceof HTMLSelectElement)) return false;
      const wanted = step.choose.toLowerCase();
      const option = [...field.options].find(item => item.text.trim().toLowerCase() === wanted || item.value.toLowerCase() === wanted) ??
        [...field.options].find(item => item.text.trim().toLowerCase().includes(wanted));
      if (!option || field.value === option.value) return false;
      const before = field.value;
      setValue(field, option.value);
      if (preview) undo.push(() => setValue(field, before));
      return true;
    }
    if (field instanceof HTMLSelectElement) return setState(element, { choose: step.fill });
    if (valueOf(field) === step.fill || busy(field)) return false;
    const before = valueOf(field);
    setValue(field, step.fill);
    if (preview) undo.push(() => setValue(field, before));
    return true;
  }

  const foundNote = how => how === "description" ? " · found by its label and description, because the selector no longer fits" : "";

  function run() {
    return steps.map((step, index) => {
      const found = targetsOf(step);
      if (typeof found === "string") return found;
      const { matches, targets, how } = found;
      if (onDemand(step)) {
        return ("key" in step ? `Ready · clicks when you press ${step.key.toUpperCase()}` : `Ready · adds “${step.menu}” to the popup`) + foundNote(how);
      }
      if (preview && step.click) return `Would click ${targets.length} element(s) · not clicked in a preview` + foundNote(how);
      let changed = 0;
      for (const element of targets) {
        if (keepsState(step)) {
          if (setState(element, step)) changed++;
          continue;
        }
        if (applied[index].has(element)) continue;
        if (step.style && element.style) {
          const [property, value] = step.style;
          const previous = element.style.getPropertyValue(property);
          const priority = element.style.getPropertyPriority(property);
          element.style.setProperty(property, value, "important");
          const appliedValue = element.style.getPropertyValue(property);
          if (preview) undo.push(() => {
            if (element.style.getPropertyValue(property) !== appliedValue ||
                element.style.getPropertyPriority(property) !== "important") return;
            if (previous) element.style.setProperty(property, previous, priority);
            else element.style.removeProperty(property);
          });
        } else if ("text" in step) {
          const children = [...element.childNodes];
          element.textContent = step.text;
          if (preview) undo.push(() => element.replaceChildren(...children));
        } else if ("note" in step) {
          const note = document.createElement("span");
          note.textContent = step.note;
          note.style.marginInlineStart = ".4em";
          notes.add(note);
          element.after(note);
          if (preview) undo.push(() => note.remove());
        } else if (step.click) {
          element.click();
        } else continue;
        applied[index].add(element);
        changed++;
      }
      if (keepsState(step) && !changed) return `Already set on ${targets.length} element(s)` + foundNote(how);
      return `Changed ${changed} of ${matches.length} matching element(s)` + foundNote(how);
    });
  }

  // Shortcut and popup-button steps click their element when asked, not when the page loads.
  function trigger(index) {
    const found = targetsOf(steps[index]);
    if (typeof found !== "string") for (const element of found.targets) element.click();
  }

  function listen() {
    addEventListener("keydown", event => {
      if (event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]"))) return;
      steps.forEach((step, index) => {
        if ("key" in step && event.key.toLowerCase() === step.key) trigger(index);
      });
    });
  }

  return { run, trigger, listen, undo: () => {
    while (undo.length) undo.pop()();
  } };
}

// Identify the saved revision without sending source or selector text to the worker.
export function recipeRevision(marker) {
  let hash = 2166136261;
  for (let index = 0; index < marker.length; index++) {
    hash = Math.imul(hash ^ marker.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16);
}

// code is the runner and locator source to embed. Saved scripts are checked against the code they already contain,
// so recipes saved by an earlier builder still open (see readRecipe); null leaves the locator out, as older ones did.
const currentCode = () => ({ runner: createRunner.toString(), locator: createLocator.toString() });

export function generateRecipe(recipe, { reportRuns = true, code = currentCode() } = {}) {
  const { name, page, scope, watch, steps, namespace, scriptVersion } = recipe;
  if ([namespace, scriptVersion].some(value => /[\r\n\u2028\u2029]/.test(value ?? ""))) {
    throw new Error("Namespace and script version must each fit on one line.");
  }
  const url = new URL(page);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Open an HTTP or HTTPS page first.");
  const title = name.replace(/\s+/g, " ").trim() || "Page customizations";
  const path = scope === "path" ? url.pathname : null;
  const matchPath = path && !path.includes("*") ? path + "*" : "/*";
  const guards = [`location.origin === ${JSON.stringify(url.origin)}`];
  if (path) guards.push(`location.pathname === ${JSON.stringify(path)}`);
  const usable = steps.filter(step => !stepProblem(step));
  const compiled = compile(usable);
  const forms = compiled.some(step => "fill" in step || "check" in step || "choose" in step);
  const menus = compiled.flatMap((step, index) => "menu" in step ? [[index, step.menu]] : []);
  const keys = compiled.some(step => "key" in step);
  const canonical = { version: 2, name: title, page: url.origin + url.pathname, scope, watch, steps,
    ...(namespace ? { namespace } : {}), ...(scriptVersion ? { scriptVersion } : {}), ...(reportRuns ? { reportRuns: true } : {}) };
  const data = JSON.stringify(compiled, null, 2).replace(/\n/g, "\n  ");
  const marker = JSON.stringify(canonical).replace(/[\u2028\u2029]/g, char => char === "\u2028" ? "\\u2028" : "\\u2029");
  return `// ==UserScript==
// @name        ${title}${namespace ? `
// @namespace   ${namespace}` : ""}${scriptVersion ? `
// @version     ${scriptVersion}` : ""}
// @match       ${url.protocol}//${url.hostname}${matchPath}
// @run-at      document-idle
// @grant       ${menus.length ? "GM_registerMenuCommand" : "none"}
// ==/UserScript==

// Made with the Tailorscript visual builder. Open the page's developer tools and choose the Tailorscript tab to
// change it there. Editing the code below turns it into an ordinary script.
(() => {
  // What to change: each step names an element with a CSS selector, describes it so it can still be found if the
  // selector stops matching, and says what to do with it.
  const steps = ${data};
${code.locator ? `
  const createLocator = ${code.locator};` : ""}
  const createRunner = ${code.runner};
  const runner = createRunner(steps${code.locator ? ", false, createLocator()" : ""});
  const inScope = () => ${guards.join(" && ")};
${reportRuns ? `  let previous = [];
  function apply() {
    if (!inScope()) return;
    const results = runner.run().slice(0, 100).map((result, index) =>
      result.startsWith("Changed 0 ") && previous[index]?.startsWith("Changed ") ? previous[index] : result);
    if (results.every((result, index) => result === previous[index]) && results.length === previous.length) return;
    previous = results;
    globalThis[Symbol.for("tailorscript.recipeRun")]?.(${JSON.stringify(recipeRevision(marker))}, results);
  }` : `  function apply() {
    if (inScope()) runner.run();
  }`}

  apply();${forms && code.locator ? `
  // Pages built with frameworks often reset forms just after loading, so form steps are checked again a few times.
  for (const delay of [500, 1500, 3000, 6000]) setTimeout(apply, delay);` : ""}${keys ? `
  runner.listen();` : ""}${menus.map(([index, caption]) => `
  GM_registerMenuCommand(${JSON.stringify(caption)}, () => {
    if (inScope()) runner.trigger(${index});
  });`).join("")}${watch ? `
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true });` : ""}
})();

// Tailorscript recipe: ${marker}
`;
}

// The separator includes a statement boundary so a script ending without a semicolon can accept a visual block.
const visualSeparator = "\n;\n// Tailorscript visual steps (managed by the builder)\n";

export function separateVisualSteps(source) {
  const index = source.lastIndexOf(visualSeparator);
  return index < 0 ? { base: source, visual: "" }
    : { base: source.slice(0, index), visual: source.slice(index + visualSeparator.length) };
}

export function appendVisualSteps(base, visual) {
  return visual ? base + visualSeparator + visual : base;
}

// The recipe a script was generated from, or null once the script has been edited by hand. Recipes from the first
// builder (version 1) come back upgraded and marked, since that builder's output can't be regenerated to check them.
export function readRecipe(source) {
  const { visual } = separateVisualSteps(source);
  if (visual) source = visual;
  const marker = source.match(/^\/\/ Tailorscript recipe: (.+)$/m);
  if (!marker) return null;
  try {
    const recipe = JSON.parse(marker[1]);
    if (recipe?.version === 1 && typeof recipe.page === "string" && Array.isArray(recipe.steps)) {
      return {
        version: 2, name: String(recipe.name ?? ""), page: recipe.page, scope: recipe.scope === "site" ? "site" : "path",
        watch: Boolean(recipe.watch), steps: recipe.steps.filter(step => step && Object.hasOwn(actions, step.action)), upgraded: true
      };
    }
    if (recipe?.version !== 2) return null;
    const { reportRuns, ...data } = recipe;
    // Regenerate with the runner and locator the script already contains, so any other edit is noticed but a recipe
    // saved by an earlier version of the builder still opens. Saving it again brings it up to date.
    const runner = source.match(/\n {2}const createRunner = ([\s\S]*?);\n {2}const runner = createRunner\(steps(?:, false, createLocator\(\))?\);\n/)?.[1];
    if (!runner) return null;
    const locator = source.match(/\n {2}const createLocator = ([\s\S]*?);\n {2}const createRunner = /)?.[1] ?? null;
    if (generateRecipe(data, { reportRuns: Boolean(reportRuns), code: { runner, locator } }) !== source) return null;
    const current = currentCode();
    return reportRuns && runner === current.runner && locator === current.locator ? data : { ...data, upgraded: true };
  } catch {
    return null;
  }
}

// What a step's element is called: its label, or for a step that changes every element like it, the label they share.
export function stepLabel({ label, plain, all, group, selector }) {
  return all && group?.selector === selector ? `${plain ?? label} (all ${group.count})` : label;
}

// One plain sentence per step, for the panel's summary of what the script will do.
export function describeStep(step) {
  const { action, value, all } = step;
  const target = `${all ? "every " : ""}“${all && step.group?.selector === step.selector ? step.plain ?? step.label : step.label}”`;
  const text = JSON.stringify(String(value ?? ""));
  return {
    hide: `Hide ${target}`,
    click: `Click ${target} when it appears`,
    fill: `Type ${text} into ${target}`,
    check: `Tick ${target}`,
    uncheck: `Untick ${target}`,
    choose: `Choose ${text} in ${target}`,
    text: `Change the text of ${target} to ${text}`,
    color: `Colour the text of ${target}`,
    background: `Colour the background of ${target}`,
    font: `Set the font size of ${target} to ${Math.min(96, Math.max(8, Number(value) || 18))}px`,
    highlight: `Outline ${target}`,
    note: `Add the note ${text} after ${target}`,
    shortcut: `Click ${target} when you press ${String(value ?? "").trim().toUpperCase() || "a key"}`,
    menu: `Add a popup button ${text} that clicks ${target}`
  }[action];
}

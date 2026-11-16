// What a step can do. `value` describes the extra input a step needs, `kinds` the elements it is the default for.
export const actions = {
  hide: { label: "Hide", title: "Hide element" },
  click: { label: "Click", title: "Click it automatically", kinds: ["button"] },
  fill: { label: "Fill in", title: "Fill in text", value: { type: "text", placeholder: "Text to enter" }, kinds: ["field"] },
  text: { label: "Replace text", title: "Replace text", value: { type: "text", placeholder: "Replacement text" } },
  color: { label: "Text colour", title: "Change text colour", value: { type: "color", initial: "#0f8f82" } },
  background: { label: "Background", title: "Change background colour", value: { type: "color", initial: "#0f8f82" } },
  font: { label: "Font size", title: "Change font size", value: { type: "number", initial: "18", unit: "px" } },
  highlight: { label: "Outline", title: "Outline element" },
  note: { label: "Add note", title: "Add note after element", value: { type: "text", placeholder: "Note text" } },
  shortcut: { label: "Shortcut", title: "Click it with a key", value: { type: "key", placeholder: "Key, such as k" } },
  menu: { label: "Popup button", title: "Click it from the Tailorscript popup", value: { type: "text", placeholder: "Button caption" } }
};

// The action a new step starts with: clicking for buttons, filling in for fields, hiding for everything else.
export function defaultAction(kind) {
  return Object.keys(actions).find(action => actions[action].kinds?.includes(kind)) ?? "hide";
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
  return "";
}

export function compile(steps) {
  return steps.map(({ selector, text, action, value, all, expectedCount, tag }) => {
    if (!Object.hasOwn(actions, action) || typeof selector !== "string" || !selector.trim()) {
      throw new Error("Every step needs a selector and a supported action.");
    }
    const target = { selector, ...(text ? { text } : {}), ...(all ? { all: true } : {}), expectedCount, tag };
    if (action === "click") return { ...target, click: true };
    if (action === "fill") return { ...target, fill: value ?? "" };
    if (action === "shortcut") return { ...target, key: String(value ?? "").trim().slice(0, 20).toLowerCase() };
    if (action === "menu") return { ...target, menu: String(value ?? "").trim().slice(0, 80) };
    if (action === "text" || action === "note") return { ...target, [action]: value ?? "" };
    const [property, fixed] = styles[action];
    const color = /^#[\da-f]{6}$/i.test(value ?? "") ? value : "#0f8f82";
    const size = Math.min(96, Math.max(8, Number(value) || 18));
    return { ...target, style: [property, fixed ?? (action === "font" ? `${size}px` : color)] };
  });
}

// Serialized into generated scripts and the inspected page. Keep it self-contained.
export function createRunner(steps, preview = false) {
  const applied = steps.map(() => new WeakSet());
  const notes = new WeakSet();
  const undo = [];
  const onDemand = step => "key" in step || "menu" in step;

  // The elements a step applies to, or a sentence saying why it is skipped.
  function targetsOf(step) {
    let matches;
    try {
      matches = [...document.querySelectorAll(step.selector)].filter(element => !notes.has(element) &&
        (!step.text || (element.textContent ?? "").replace(/\s+/g, " ").trim() === step.text));
    } catch {
      return "Skipped · invalid selector";
    }
    if (!matches.length) return "Skipped · no matches";
    if (step.expectedCount != null && matches.length !== step.expectedCount) {
      return `Skipped · expected ${step.expectedCount} match(es), found ${matches.length}`;
    }
    const targets = step.all ? matches : matches.slice(0, 1);
    if (step.tag && targets.some(element => element.localName !== step.tag)) return `Skipped · expected <${step.tag}>`;
    return { matches, targets };
  }

  // Sets a field the way typing does, so pages built with frameworks notice the change.
  function fill(field, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
    if (setter) setter.call(field, value);
    else if (field.isContentEditable) field.textContent = value;
    else field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function run() {
    return steps.map((step, index) => {
      const found = targetsOf(step);
      if (typeof found === "string") return found;
      const { matches, targets } = found;
      if (onDemand(step)) {
        return "key" in step ? `Ready · clicks when you press ${step.key.toUpperCase()}` : `Ready · adds “${step.menu}” to the popup`;
      }
      if (preview && step.click) return `Would click ${targets.length} element(s) · not clicked in a preview`;
      let changed = 0;
      for (const element of targets) {
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
        } else if ("fill" in step) {
          const previous = element.isContentEditable ? element.textContent : element.value;
          fill(element, step.fill);
          if (preview) undo.push(() => fill(element, previous));
        } else if (step.click) {
          element.click();
        } else continue;
        applied[index].add(element);
        changed++;
      }
      return `Changed ${changed} of ${matches.length} matching element(s)`;
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

export function generateRecipe(recipe) {
  const { name, page, scope, watch, steps } = recipe;
  const url = new URL(page);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Open an HTTP or HTTPS page first.");
  const title = name.replace(/\s+/g, " ").trim() || "Page customizations";
  const path = scope === "path" ? url.pathname : null;
  const matchPath = path && !path.includes("*") ? path + "*" : "/*";
  const guards = [`location.origin === ${JSON.stringify(url.origin)}`];
  if (path) guards.push(`location.pathname === ${JSON.stringify(path)}`);
  const usable = steps.filter(step => !stepProblem(step));
  const compiled = compile(usable);
  const menus = compiled.flatMap((step, index) => "menu" in step ? [[index, step.menu]] : []);
  const keys = compiled.some(step => "key" in step);
  const canonical = { version: 2, name: title, page: url.origin + url.pathname, scope, watch, steps };
  const data = JSON.stringify(compiled, null, 2).replace(/\n/g, "\n  ");
  const marker = JSON.stringify(canonical).replace(/[\u2028\u2029]/g, char => char === "\u2028" ? "\\u2028" : "\\u2029");
  return `// ==UserScript==
// @name        ${title}
// @match       ${url.protocol}//${url.hostname}${matchPath}
// @run-at      document-idle
// @grant       ${menus.length ? "GM_registerMenuCommand" : "none"}
// ==/UserScript==

// Made with the Tailorscript visual builder. Open the page's developer tools and choose the Tailorscript tab to
// change it there. Editing the code below turns it into an ordinary script.
(() => {
  // What to change: each step names an element with a CSS selector and says what to do with it.
  const steps = ${data};

  const createRunner = ${createRunner.toString()};
  const runner = createRunner(steps);
  const inScope = () => ${guards.join(" && ")};
  function apply() {
    if (inScope()) runner.run();
  }

  apply();${keys ? `
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

// The recipe a script was generated from, or null once the script has been edited by hand. Recipes from the first
// builder (version 1) come back upgraded and marked, since that builder's output can't be regenerated to check them.
export function readRecipe(source) {
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
    return generateRecipe(recipe) === source ? recipe : null;
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

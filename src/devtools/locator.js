// Finds the element a builder step means without relying on a CSS selector alone. A step remembers a selector and a
// description of its element: tag, role, accessible name (its label), text and stable attributes. The selector is
// tried first and its match must fit the description; when the selector finds nothing, too much or the wrong kind of
// element, the description is used to search the page, including inside web components.
//
// Serialized into generated scripts and into the inspected page, so it must not reference anything outside its body.
export function createLocator() {
  const deep = " >>> ";
  const squeeze = text => String(text ?? "").replace(/\s+/g, " ").trim();
  const textOf = element => squeeze(element.textContent);
  // Attributes worth remembering: test ids and form names that frameworks keep stable across builds.
  const keyAttributes = ["data-testid", "data-test", "data-qa", "data-cy", "formcontrolname", "name", "placeholder", "type", "autocomplete", "href"];

  // Every element a selector finds, stepping into open shadow roots at each " >>> ". Throws for invalid CSS.
  function queryDeep(selector, start = document) {
    let roots = [start];
    const parts = selector.split(deep);
    for (const [index, part] of parts.entries()) {
      const found = roots.flatMap(root => [...root.querySelectorAll(part)]);
      if (index === parts.length - 1) return found;
      roots = found.map(host => host.shadowRoot).filter(Boolean);
    }
    return [];
  }

  // Every element on the page, including inside open shadow roots, up to a limit.
  function allElements(limit = 30000) {
    const found = [];
    const roots = /** @type {Node[]} */ ([document.documentElement]);
    while (roots.length && found.length < limit) {
      const walker = document.createTreeWalker(roots.shift(), NodeFilter.SHOW_ELEMENT);
      for (let node = walker.currentNode; node && found.length < limit; node = walker.nextNode()) {
        if (!(node instanceof Element)) continue;
        found.push(node);
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
    return found;
  }

  const implicitRoles = { a: "link", button: "button", select: "combobox", textarea: "textbox", summary: "button", img: "img", dialog: "dialog" };
  const inputRoles = { button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio", range: "slider", search: "searchbox" };
  function roleOf(element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = element.localName;
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") return inputRoles[element.type] ?? "textbox";
    if (tag === "a" && !element.hasAttribute("href")) return "";
    if (element.isContentEditable) return "textbox";
    return implicitRoles[tag] ?? "";
  }

  // What a screen reader would call the element, in the usual order of precedence, falling back to the label of the
  // web component it sits in.
  function accessibleName(element) {
    const root = element.getRootNode();
    const byId = id => root.getElementById?.(id) ?? document.getElementById(id);
    const labelledBy = squeeze((element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
      .map(id => byId(id)?.textContent ?? "").join(" "));
    const name = labelledBy || squeeze(element.getAttribute("aria-label")) ||
      squeeze([...(element.labels ?? [])].map(label => label.textContent).join(" ")) ||
      (/^(button|submit|reset)$/.test(element.type) && squeeze(element.value)) || squeeze(element.getAttribute("alt")) ||
      (["button", "link", "heading", "tab", "menuitem", "option", "checkbox", "radio", "switch"].includes(roleOf(element)) && textOf(element).slice(0, 120)) ||
      squeeze(element.getAttribute("placeholder")) || squeeze(element.getAttribute("title"));
    if (name) return name.slice(0, 120);
    if (root instanceof ShadowRoot) {
      const host = root.host;
      return squeeze(host.getAttribute("label")) || squeeze(host.getAttribute("aria-label")) || squeeze(host.getAttribute("placeholder")) || accessibleName(host);
    }
    return "";
  }

  // The description a step stores for its element.
  function describe(element) {
    const attributes = {};
    for (const name of keyAttributes) {
      const value = element.getAttribute(name);
      if (value && value.length <= 120) attributes[name] = value;
    }
    const text = textOf(element);
    return { tag: element.localName, role: roleOf(element), name: accessibleName(element), text: text.length <= 80 ? text : "", attributes };
  }

  // How well an element fits a description. Tag or role must agree; the name, test ids and form names count most.
  function score(element, target) {
    if (target.tag && element.localName !== target.tag && (!target.role || roleOf(element) !== target.role)) return 0;
    let points = 1;
    if (target.role && roleOf(element) === target.role) points += 2;
    if (target.name) {
      const name = accessibleName(element);
      if (name === target.name) points += 6;
      else if (name && name.toLowerCase().includes(target.name.toLowerCase())) points += 2;
    }
    for (const [name, value] of Object.entries(target.attributes ?? {})) {
      if (element.getAttribute(name) === value) points += /^data-|formcontrolname/.test(name) ? 6 : name === "type" ? 1 : 3;
    }
    if (target.text && textOf(element) === target.text) points += 4;
    return points;
  }

  // Signals strong enough to pick an element without the selector: a name, a text, or a non-trivial attribute.
  const describable = target => Boolean(target.name || target.text ||
    Object.keys(target.attributes ?? {}).some(name => name !== "type"));

  /**
   * The elements a step targets and how they were found: "selector", or "description" when the selector failed.
   * @param {{ selector?: string, text?: string, all?: boolean, expectedCount?: number, find?: object, tag?: string }} step
   */
  function locate(step) {
    const target = { tag: step.tag, ...step.find };
    let found = [];
    let invalid = false;
    if (step.selector) {
      try {
        found = queryDeep(step.selector);
        if (step.text) found = found.filter(element => textOf(element) === step.text);
      } catch {
        invalid = true;
      }
    }
    const fits = element => score(element, target) > 0;
    if (step.all) {
      const kept = found.filter(fits);
      if (kept.length || !describable(target)) return { elements: kept, how: "selector", invalid };
      // Every element like the one picked: same kind and name.
      const similar = allElements().filter(element => score(element, target) >= 1 + (target.role ? 2 : 0) + (target.name ? 6 : 0));
      return { elements: similar, how: "description", invalid };
    }
    const fitting = found.filter(fits);
    if (fitting.length === 1 && (step.expectedCount == null || step.expectedCount === 1)) {
      // A selector can still land on the wrong element after a redesign. When the name no longer agrees, a clearly
      // better fit elsewhere wins; a renamed element with no better fit keeps the selector's match.
      const [match] = fitting;
      if (!target.name || accessibleName(match) === target.name) return { elements: fitting, how: "selector", invalid };
      const own = score(match, target);
      const better = allElements().filter(element => score(element, target) >= own + 4);
      return better.length === 1 ? { elements: better, how: "description", invalid } : { elements: fitting, how: "selector", invalid };
    }
    if (step.expectedCount != null && step.expectedCount !== 1) return { elements: fitting, how: "selector", invalid };
    if (!describable(target)) return { elements: fitting, how: "selector", invalid };
    // The selector found nothing, too many, or the wrong kind of element: pick the single best fit on the page.
    const pool = fitting.length > 1 ? fitting : allElements();
    let best = null;
    let bestScore = 0;
    let tie = false;
    for (const element of pool) {
      const points = score(element, target);
      if (points > bestScore) {
        best = element;
        bestScore = points;
        tie = false;
      } else if (points === bestScore && points > 0) tie = true;
    }
    const strong = bestScore >= 7;
    return best && strong && !tie ? { elements: [best], how: "description", invalid } : { elements: fitting.length > 1 ? fitting : [], how: "selector", invalid };
  }

  return { queryDeep, allElements, roleOf, accessibleName, describe, score, locate, textOf };
}

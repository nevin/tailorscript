// Runs inside the inspected page through chrome.devtools.inspectedWindow.eval. It is serialized into the call, so like
// the userscript runtime it must not reference anything outside its own body, and everything it returns must be JSON.
//   scan                 the page's notable elements, grouped by kind
//   describe (element)   one element, such as the one selected in the Elements panel
//   count (selector)     how many elements a selector matches, or -1 when it isn't valid CSS
//   highlight (selector) outlines the matches on the page; null clears the outline
//   pick-start, pick-poll, pick-stop   let the user click an element on the page
export function probe(command, argument) {
  const key = Symbol.for("tailorscript.probe");
  const state = window[key] ?? (window[key] = { boxes: [], picked: null, stopPick: null });
  const limits = { overlay: 20, button: 80, field: 60, link: 80, heading: 40, media: 40, section: 40 };

  const visible = (element, rect = element.getBoundingClientRect(), style = getComputedStyle(element)) => {
    if (rect.width < 2 || rect.height < 2) return false;
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
  };
  const formFields = "input:not([type=hidden]), textarea, select, [role=textbox], [role=searchbox], [role=combobox], " +
    "[role=spinbutton], [role=slider], [role=listbox], [role=option], [role=checkbox], [role=radio], [role=switch], " +
    "[contenteditable]:not([contenteditable=false]), [aria-haspopup=listbox]";
  const choiceRoles = ["checkbox", "radio", "switch", "slider", "listbox", "option"];
  const inputActions = /^(button|submit|reset|image|checkbox|radio|range|file|color)$/;
  function fieldTarget(element) {
    const label = element.closest("label");
    if (label?.control?.matches(formFields)) return label.control;
    return element.closest(formFields) ?? element;
  }
  function visibleLabels(element) {
    return [...(element.labels ?? [])].filter(label => !label.closest("[inert], [aria-hidden=true]") && visible(label));
  }

  const squeeze = text => String(text ?? "").replace(/\s+/g, " ").trim();
  // Sections are named by what they are, since their text is everything inside them run together.
  const regions = { header: "Header", nav: "Navigation", main: "Main content", aside: "Sidebar", footer: "Footer", form: "Form",
    article: "Article", dialog: "Dialog", banner: "Header", navigation: "Navigation", search: "Search", complementary: "Sidebar",
    contentinfo: "Footer", alertdialog: "Dialog" };
  const label = (element, kind) => {
    if (kind === "section" || kind === "overlay") {
      const named = squeeze(referencedLabel(element)) || squeeze(element.getAttribute("aria-label"));
      const region = regions[element.getAttribute("role")] ?? regions[element.localName];
      const opening = squeeze(element.innerText?.slice(0, 200)).slice(0, 40);
      if (region) return named ? `${region}: ${named}`.slice(0, 70) : kind === "overlay" && opening ? `${region}: ${opening}…` : region;
      return named || (opening ? `${kind === "overlay" ? "Pinned" : "Section"}: ${opening}…` : element.localName);
    }
    const text = squeeze(referencedLabel(element)) || squeeze(element.getAttribute("aria-label")) || squeeze(element.getAttribute("alt")) ||
      (element.labels?.[0] && squeeze(element.labels[0].innerText)) || squeeze(element.getAttribute("placeholder")) ||
      (/^(button|submit|reset)$/.test(element.type) && squeeze(element.value)) || squeeze(element.innerText?.slice(0, 200)) ||
      squeeze(element.getAttribute("title")) || squeeze(element.getAttribute("name")) || element.id;
    return (text || element.tagName.toLowerCase()).slice(0, 70);
  };

  // Names that frameworks generate change between visits or builds, so selectors avoid them.
  const stable = name => Boolean(name) && name.length < 50 &&
    !/\d{3,}|^(css|sc|jss|jsx|svelte|ember|react|radix|headlessui|mui)[-_:]|^[a-zA-Z]{1,3}-?[a-zA-Z0-9]*\d[a-zA-Z0-9]*$|^[_:]|[A-Za-z]\d[A-Za-z]\d/.test(name);
  const referencedLabel = element => (element.getAttribute("aria-labelledby") ?? "").split(/\s+/)
    .filter(Boolean).map(id => document.getElementById(id)?.textContent ?? "").join(" ");
  const matches = selector => {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return -1;
    }
  };
  const quote = value => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

  const selectors = new Map();
  function resolve(selector) {
    if (!selectors.has(selector)) {
      try {
        const results = document.querySelectorAll(selector);
        selectors.set(selector, results.length === 1 ? results[0] : null);
      } catch {
        selectors.set(selector, null);
      }
    }
    return selectors.get(selector);
  }

  function candidates(element) {
    const tag = CSS.escape(element.localName);
    const options = [];
    if (stable(element.id)) options.push([`#${CSS.escape(element.id)}`, "ID"]);
    for (const attr of ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label", "aria-labelledby", "placeholder", "autocomplete", "type"]) {
      const value = element.getAttribute(attr);
      if (!value || value.length > 80 || [...value].some(char => char.charCodeAt(0) < 32)) continue;
      options.push([`${tag}[${attr}=${quote(value)}]`, attr.startsWith("data-") ? "Test attribute" : "Named attribute"]);
    }
    const href = element.localName === "a" && element.getAttribute("href");
    if (href && href.length < 100 && !/^(#|javascript:)/i.test(href) && ![...href].some(char => char.charCodeAt(0) < 32)) {
      options.push([`a[href=${quote(href)}]`, "Link address"]);
    }
    const role = element.getAttribute("role");
    if (role) options.push([`${tag}[role=${quote(role)}]`, "Role"]);
    for (const name of [...element.classList].filter(stable).slice(0, 4)) {
      options.push([`${tag}.${CSS.escape(name)}`, "Class"]);
    }
    options.push([tag, "Tag"]);
    return options;
  }

  const landmarks = ["body", "header", "nav", "main", "aside", "footer", "form"];

  // A selector for every element like this one, such as each card's button: its own class, or its tag inside the
  // nearest classed or landmark parent. Null when nothing else on the page is like it.
  function groupFor(element) {
    const tag = CSS.escape(element.localName);
    const options = [...element.classList].filter(stable).slice(0, 4).map(name => `${tag}.${CSS.escape(name)}`);
    for (let parent = element.parentElement, depth = 0; parent && depth < 4; parent = parent.parentElement, depth++) {
      for (const name of [...parent.classList].filter(stable).slice(0, 3)) options.push(`.${CSS.escape(name)} ${tag}`);
      if (landmarks.includes(parent.localName) && parent.localName !== "body") options.push(`${parent.localName} ${tag}`);
    }
    for (const selector of options) {
      const count = matches(selector);
      if (count > 1 && count <= 200 && element.matches(selector)) return { selector, count };
    }
    return null;
  }

  // Text as the runner compares it: all of it, with runs of space collapsed.
  const textOf = element => (element.textContent ?? "").replace(/\s+/g, " ").trim();
  // Elements matching a selector, narrowed to those with exactly this text when one is given.
  const find = (selector, text) => {
    try {
      const found = [...document.querySelectorAll(selector)];
      return text ? found.filter(element => textOf(element) === text) : found;
    } catch {
      return null;
    }
  };

  // Short, readable text such as "Accept all" can tell apart elements that have no name of their own, and keeps
  // working when the layout changes. Used before falling back to position.
  function textTarget(element) {
    const text = textOf(element);
    if (!text || text.length > 60) return null;
    const tag = CSS.escape(element.localName);
    // The nearest named parent first, so the text only has to be unique within it; the whole page last.
    const scopes = [];
    for (let parent = element.parentElement, depth = 0; parent && depth < 5; parent = parent.parentElement, depth++) {
      const anchor = candidates(parent).find(([selector, basis]) => (basis !== "Tag" || landmarks.includes(parent.localName)) && resolve(selector) === parent);
      if (anchor) scopes.push(`${anchor[0]} `);
    }
    scopes.push("");
    for (const scope of scopes) {
      const found = find(scope + tag, text);
      if (found?.length === 1 && found[0] === element) return { selector: scope + tag, text, basis: "Text" };
    }
    return null;
  }

  function selectorFor(element) {
    const options = candidates(element);
    for (const [selector, basis] of options) {
      if (resolve(selector) === element) return { selector, basis };
    }
    for (let parent = element.parentElement, depth = 0; parent && depth < 5; parent = parent.parentElement, depth++) {
      const anchor = candidates(parent).find(([selector, basis]) => basis !== "Tag" && resolve(selector) === parent);
      if (!anchor) continue;
      for (const [target] of options) {
        const selector = `${anchor[0]} ${target}`;
        if (resolve(selector) === element) return { selector, basis: "Scoped to parent" };
      }
    }
    const byText = textTarget(element);
    if (byText) return byText;
    // Last resort: the element's position among its siblings, starting from the nearest parent that can be named.
    // A path always includes at least one parent, so it can't match some unrelated element on another page.
    const parts = [];
    let unanchored = "";
    for (let node = element, depth = 0; node && node !== document.documentElement; node = node.parentElement, depth++) {
      if (node !== element) {
        const anchor = candidates(node).find(([selector, basis]) => (basis !== "Tag" || landmarks.includes(node.localName)) && resolve(selector) === node);
        if (anchor) {
          const selector = `${anchor[0]} > ${parts.join(" > ")}`;
          if (resolve(selector) === element) return { selector, basis: "Position-based" };
        }
      }
      let index = 1;
      let alone = true;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === node.localName) index++;
      }
      for (const sibling of node.parentElement?.children ?? []) if (sibling !== node && sibling.localName === node.localName) alone = false;
      parts.unshift(CSS.escape(node.localName) + (alone ? "" : `:nth-of-type(${index})`));
      if (!unanchored && parts.length > 1 && resolve(parts.join(" > ")) === element) unanchored = parts.join(" > ");
      if (unanchored && depth >= 6) break;
    }
    if (unanchored) return { selector: unanchored, basis: "Position-based" };
    return { selector: "", basis: "Unavailable" };
  }

  const kindOf = (element, rect = element.getBoundingClientRect(), position = getComputedStyle(element).position) => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    if (role === "dialog" || role === "alertdialog" || tag === "dialog") return "overlay";
    if (tag === "button" || tag === "summary" || ["button", "tab", "menuitem", ...choiceRoles].includes(role) || element.matches("[aria-haspopup=listbox]") || (tag === "input" && inputActions.test(element.type))) return "button";
    if (tag === "input" || tag === "textarea" || tag === "select" || element.matches(formFields)) return "field";
    if ((position === "fixed" || position === "sticky") && rect.width * rect.height > 6000 && !/^(html|body)$/.test(tag)) return "overlay";
    if (tag === "a" || role === "link") return "link";
    if (/^h[1-6]$/.test(tag) || role === "heading") return "heading";
    if (/^(img|video|audio|picture|svg|canvas|iframe)$/.test(tag)) return "media";
    return "section";
  };
  const own = element => element.closest?.("[data-tailorscript-probe]");
  const describe = (element, kind = kindOf(element)) => {
    const { selector, basis, text } = selectorFor(element);
    return { kind, label: label(element, kind), tag: element.localName, selector, text, basis, matches: selector ? 1 : 0, group: groupFor(element) };

  };

  const clearBoxes = () => {
    for (const box of state.boxes) box.remove();
    state.boxes = [];
  };
  const outline = elements => {
    clearBoxes();
    for (const element of elements.slice(0, 30)) {
      const rect = element.getBoundingClientRect();
      const box = document.createElement("div");
      box.dataset.tailorscriptProbe = "";
      box.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;left:${rect.left}px;top:${rect.top}px;` +
        `width:${rect.width}px;height:${rect.height}px;border:2px solid #0f8f82;background:rgba(15,143,130,.2);border-radius:3px;`;
      document.documentElement.append(box);
      state.boxes.push(box);
    }
  };

  if (command === "scan") {
    const notable = "button, a[href], h1, h2, h3, h4, h5, h6, " +
      "img, video, iframe, header, nav, main, aside, footer, form, dialog, summary, article, " +
      "section[aria-label], section[aria-labelledby], [contenteditable]:not([contenteditable=false]), " +
      "[role=button], [role=tab], [role=menuitem], [role=switch], [role=checkbox], [role=radio], [role=link], " +
      "[role=textbox], [role=searchbox], [role=combobox], [role=heading], [role=dialog], [role=alertdialog], " +
      "[role=banner], [role=navigation], [role=search], [role=complementary], [role=contentinfo]";
    const candidates = [];
    const inspected = new Set();
    function consider(node, isField = false) {
      if (inspected.has(node)) return;
      inspected.add(node);
      if (own(node) || node.closest("[inert], [aria-hidden=true]") || node.matches("input[type=hidden]")) return;
      const known = isField || node.matches(notable);
      const style = getComputedStyle(node);
      if (!known && style.position !== "fixed" && style.position !== "sticky") return;
      let rect = node.getBoundingClientRect();
      if (!visible(node, rect, style) ||
          (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) {
        // Styled checkboxes and radios can hide the native input while leaving a clickable label.
        if (!node.matches("input[type=checkbox], input[type=radio]")) return;
        const label = visibleLabels(node)[0];
        if (!label) return;
        rect = label.getBoundingClientRect();
      }
      const inView = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      if (!known && (!inView || rect.width * rect.height <= 6000)) return;
      const kind = kindOf(node, rect, style.position);
      if (kind === "media" && rect.width < 40) return;
      candidates.push({ node, kind, inView, isField });
    }

    // Discover controls throughout the document even when a large section uses the generic scan budget.
    const fields = document.querySelectorAll(formFields);
    for (let index = 0; index < Math.min(fields.length, 2000); index++) consider(fields[index], true);
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
    let checked = 0;
    let node;
    while ((node = walker.nextNode()) && checked++ < 6000) {
      if (node instanceof Element) consider(node);
    }
    candidates.sort((a, b) => Number(b.inView) - Number(a.inView) || Number(b.isField) - Number(a.isField));
    const counts = {};
    const items = [];
    let omitted = 0;
    for (const { node, kind, inView } of candidates) {
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (counts[kind] > limits[kind]) {
        omitted++;
        continue;
      }
      const item = describe(node, kind);
      if (item.selector) items.push({ ...item, inView, node });
    }
    // Elements that share a label are told apart by the heading they sit under, or failing that by number.
    const sameLabel = new Map();
    for (const item of items) {
      const group = sameLabel.get(`${item.kind}\n${item.label}`) ?? [];
      group.push(item);
      sameLabel.set(`${item.kind}\n${item.label}`, group);
    }
    for (const group of sameLabel.values()) {
      if (group.length < 2) continue;
      const contexts = group.map(({ node, label: own }) => {
        for (let parent = node.parentElement, depth = 0; parent && parent !== document.body && depth < 4; parent = parent.parentElement, depth++) {
          const heading = squeeze(parent.querySelector("h1, h2, h3, h4, h5, h6, [role=heading]")?.innerText).slice(0, 40);
          if (heading && heading !== own) return heading;
        }
        return "";
      });
      const distinct = new Set(contexts).size === group.length && contexts.every(Boolean);
      group.forEach((item, index) => {
        item.plain = item.label;
        item.label = `${item.label} (${distinct ? contexts[index] : `${index + 1} of ${group.length}`})`;
      });
    }
    for (const item of items) delete item.node;
    return { url: location.href, title: document.title, items, limited: Boolean(node) || fields.length > 2000 || omitted > 0 };
  }

  if (command === "describe") return argument instanceof Element && argument.getRootNode() === document ? describe(fieldTarget(argument)) : null;
  if (command === "count") return matches(argument);
  if (command === "diagnose" || command === "check-recipe") {
    const results = argument.map(({ selector, text, expectedCount, tag, all }) => {
      const elements = find(selector, text);
      if (!elements) return { count: null, message: "Invalid selector" };
      const count = elements.length;
      if (!count) return { count, message: "No match" };
      if (expectedCount != null && count !== expectedCount) {
        return { count, message: `Expected ${expectedCount}, found ${count}` };
      }
      const targets = all ? elements : [elements[0]];
      if (tag && targets.some(element => element.localName !== tag)) return { count, message: `Expected <${tag}>` };
      return { count, applied: targets.length, message: `Ready · ${count} match(es)` };
    });
    return command === "diagnose" ? results.map(result => result.message) : { url: location.href, results };
  }

  // The argument is a selector, or { selector, text } for an element found by its text.
  if (command === "highlight") {
    const target = typeof argument === "string" ? { selector: argument } : argument;
    const elements = target?.selector ? find(target.selector, target.text) ?? [] : [];
    if (!elements.length) {
      clearBoxes();
      return 0;
    }
    const targets = elements.slice(0, 30).map(element => visible(element) ? element : visibleLabels(element)[0] ?? element);
    const rect = targets[0].getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) targets[0].scrollIntoView({ block: "center" });
    outline(targets);
    return elements.length;
  }

  if (command === "pick-start") {
    state.stopPick?.();
    state.picked = null;
    const swallow = event => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const move = event => {
      if (event.target instanceof Element && !own(event.target)) outline([event.target]);
    };
    const choose = event => {
      swallow(event);
      if (event.target instanceof Element && event.target.getRootNode() === document) state.picked = describe(fieldTarget(event.target));
      state.stopPick();
    };
    const cancel = event => {
      if (event.key !== "Escape") return;
      swallow(event);
      state.picked = { cancelled: true };
      state.stopPick();
    };
    const blocked = ["mousedown", "mouseup", "pointerdown", "pointerup"];
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", choose, true);
    document.addEventListener("keydown", cancel, true);
    for (const name of blocked) document.addEventListener(name, swallow, true);
    const timeout = setTimeout(() => {
      state.picked = { cancelled: true };
      state.stopPick?.();
    }, 15000);
    state.stopPick = () => {
      clearTimeout(timeout);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", choose, true);
      document.removeEventListener("keydown", cancel, true);
      for (const name of blocked) document.removeEventListener(name, swallow, true);
      state.stopPick = null;
      clearBoxes();
    };
    return true;
  }
  if (command === "pick-poll") {
    const { picked } = state;
    state.picked = null;
    return picked;
  }
  if (command === "pick-stop") {
    state.stopPick?.();
    return true;
  }
  return null;
}

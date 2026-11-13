import { addMetadata, allows, grantFamilies, parseSource, supportedGrants, syncValueGrants } from "../shared/userscript.js";
import { tokenizer } from "../vendor/acorn/acorn.mjs";

const openers = ["(", "[", "{", "${"];
const closers = [")", "]", "}"];

function matchBracket(brackets, caret) {
  const before = brackets.findIndex(token => token.end === caret);
  const index = before !== -1 ? before : brackets.findIndex(token => token.start === caret);
  if (index === -1) return null;
  const stack = [];
  for (let position = 0; position < brackets.length; position++) {
    if (openers.includes(brackets[position].type.label)) {
      stack.push(position);
      continue;
    }
    const open = stack.pop();
    if (open === undefined) continue;
    if (open === index || position === index) return [brackets[open], brackets[position]];
  }
  return null;
}

function without(spans, overlay) {
  return spans.filter(span => !overlay.some(mark => mark.start < span.end && span.start < mark.end));
}

// Marks such as the current find match win over bracket and syntax colors that overlap them.
export function highlight(source, output, { caret = -1, marks = [] } = {}) {
  const spans = [];
  const brackets = [];
  const tokens = tokenizer(source, {
    ecmaVersion: "latest",
    onComment: (_block, _text, start, end) => spans.push({ start, end, kind: "comment" })
  });
  try {
    for (const token of tokens) {
      const label = token.type.label;
      if (openers.includes(label) || closers.includes(label)) brackets.push(token);
      const kind = token.type.keyword ? "keyword"
        : ["string", "template", "regexp"].includes(label) ? "string"
        : ["num", "bigint"].includes(label) ? "number" : "";
      if (kind) spans.push({ start: token.start, end: token.end, kind });
    }
  } catch {
    // Preserve the unrecognized text while the user is typing.
  }
  const pair = (matchBracket(brackets, caret) ?? []).map(({ start, end }) => ({ start, end, kind: "bracket" }));
  const overlay = [...marks, ...without(pair, marks)];
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const { start, end, kind } of [...without(spans, overlay), ...overlay].sort((a, b) => a.start - b.start)) {
    fragment.append(source.slice(offset, start));
    const span = document.createElement("span");
    span.className = kind;
    span.textContent = source.slice(start, end);
    fragment.append(span);
    offset = end;
  }
  fragment.append(source.slice(offset) + "\n");
  output.replaceChildren(fragment);
}

// Returns the replacement for the whole lines touched by the selection, so callers can keep native undo.
export function editLines(source, start, end, kind) {
  const from = source.lastIndexOf("\n", start - 1) + 1;
  const lastLine = end > start && source[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = source.indexOf("\n", lastLine);
  const to = lineEnd === -1 ? source.length : lineEnd;
  const lines = source.slice(from, to).split("\n");
  let next = lines;
  if (kind === "indent") next = lines.map(line => line ? "  " + line : line);
  else if (kind === "outdent") next = lines.map(line => line.replace(/^(\t| {1,2})/, ""));
  else {
    const filled = lines.filter(line => line.trim());
    if (filled.length) {
      const commented = filled.every(line => /^\s*\/\//.test(line));
      const indent = Math.min(...filled.map(line => line.match(/^\s*/)[0].length));
      next = lines.map(line => !line.trim() ? line
        : commented ? line.replace(/^(\s*)\/\/ ?/, "$1")
        : line.slice(0, indent) + "// " + line.slice(indent));
    }
  }
  const text = next.join("\n");
  const selectionStart = Math.max(from, start + next[0].length - lines[0].length);
  const selectionEnd = start === end ? selectionStart : Math.max(selectionStart, end + text.length - (to - from));
  return { from, to, text, selectionStart, selectionEnd };
}

export function findMatches(source, query, caseSensitive) {
  if (!query) return [];
  const haystack = caseSensitive ? source : source.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches = [];
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
    matches.push(index);
  }
  return matches;
}

const metadataKeys = [
  ["name", "Script name"], ["namespace", "Author or project, keeps names unique"], ["version", "Used to detect updates"],
  ["description", "What the script does"], ["author", "Who wrote it"], ["match", "Pages to run on, e.g. https://example.com/*"],
  ["include", "Glob or /regex/ of pages to run on"], ["exclude-match", "Pages to skip, as a match pattern"],
  ["exclude", "Glob or /regex/ of pages to skip"], ["grant", "An API the script uses"], ["connect", "A site GM_xmlhttpRequest may reach"],
  ["require", "Library URL loaded before the script"], ["resource", "name https://url of a bundled file"],
  ["run-at", "When to run: document-start, document-end, document-idle"], ["all-frames", "Also run inside frames"],
  ["noframes", "Only run in the top page"], ["inject-into", "page, to share the page’s variables"], ["updateURL", "Where to check for updates"],
  ["downloadURL", "Where to download updates"], ["homepageURL", "Project page"], ["tag", "Labels for filtering the library"]
];
const keywordValues = {
  grant: supportedGrants.map(label => ({ label })),
  "run-at": ["document-start", "document-end", "document-idle", "context-menu"].map(label => ({ label })),
  "inject-into": ["content", "page"].map(label => ({ label }))
};
const signatures = {
  GM_addStyle: "(css)", "GM.addStyle": "(css) → Promise", GM_getValue: "(key, fallback)", "GM.getValue": "(key, fallback) → Promise",
  GM_setValue: "(key, value)", "GM.setValue": "(key, value) → Promise", GM_deleteValue: "(key)", "GM.deleteValue": "(key) → Promise",
  GM_listValues: "()", "GM.listValues": "() → Promise", GM_xmlhttpRequest: "({ method, url, onload })",
  "GM.xmlHttpRequest": "({ method, url }) → Promise", GM_registerMenuCommand: "(caption, onClick)",
  "GM.registerMenuCommand": "(caption, onClick)", GM_unregisterMenuCommand: "(id)", "GM.unregisterMenuCommand": "(id)",
  GM_notification: "({ title, text, onclick })", "GM.notification": "({ title, text }) → Promise", GM_setClipboard: "(text)",
  "GM.setClipboard": "(text) → Promise", GM_openInTab: "(url, { active })", "GM.openInTab": "(url, { active }) → Promise",
  GM_getResourceText: "(name)", "GM.getResourceText": "(name) → Promise", GM_getResourceURL: "(name)",
  "GM.getResourceUrl": "(name) → Promise", GM_info: "script details", "GM.info": "script details", unsafeWindow: "the page’s window"
};
const apis = Object.entries(signatures).map(([label, detail]) => ({ label, detail }));

function suggest(items, prefix, caret) {
  const lower = prefix.toLowerCase();
  const found = items.filter(item => item.label.toLowerCase().startsWith(lower) && item.label !== prefix);
  return found.length ? { from: caret - prefix.length, to: caret, items: found.slice(0, 12) } : null;
}

// Suggestions for the word before the caret: metadata keys and values in the header, GM APIs in the code.
export function completions(source, caret, explicit = false) {
  const before = source.slice(source.lastIndexOf("\n", caret - 1) + 1, caret);
  const start = source.search(/^\s*\/\/\s*==UserScript==/m);
  const end = source.search(/^\s*\/\/\s*==\/UserScript==/m);
  if (start !== -1 && caret > start && (end === -1 || caret <= end)) {
    const value = before.match(/^\s*\/\/\s*@([\w-]+)\s+(\S*)$/);
    if (value) return keywordValues[value[1]] ? suggest(keywordValues[value[1]], value[2], caret) : null;
    const key = before.match(/^\s*\/\/\s*@([\w-]*)$/);
    if (!key) return null;
    return suggest(metadataKeys.map(([label, detail]) => ({ label, detail, insert: `${label.padEnd(11)} ` })), key[1], caret);
  }
  const word = before.match(/[A-Za-z_$][\w$]*(?:\.[\w$]*)?$/)?.[0] ?? "";
  if (!/^(GM|uns)/.test(word) && !(explicit && word)) return null;
  return suggest(apis, word, caret);
}

// APIs the code calls without the @grant that turns them on. GM_info is always available.
export function missingGrants(source) {
  let metadata;
  try {
    metadata = parseSource(source);
  } catch {
    return [];
  }
  const tokens = [];
  try {
    for (const token of tokenizer(source, { ecmaVersion: "latest" })) tokens.push(token);
  } catch {
    // Check the code before the first syntax error.
  }
  const used = new Set();
  tokens.forEach((token, index) => {
    if (token.type.label !== "name" || tokens[index - 1]?.type.label === ".") return;
    if (/^GM_\w+$/.test(token.value) || token.value === "unsafeWindow") used.add(token.value);
    if (token.value === "GM" && tokens[index + 1]?.type.label === "." && tokens[index + 2]?.type.label === "name") {
      used.add(`GM.${tokens[index + 2].value}`);
    }
  });
  return [...used].filter(name => {
    const family = Object.keys(grantFamilies).find(key => grantFamilies[key].includes(name));
    if (!family || family === "info" || metadata.grants.includes(name)) return false;
    return syncValueGrants.includes(name) || !allows(metadata.grants, family);
  });
}

export function addGrants(source, grants) {
  let next = source.replace(/^[ \t]*\/\/[ \t]*@grant[ \t]+none[ \t]*\n/m, "");
  for (const grant of grants) next = addMetadata(next, "grant", grant);
  return next;
}

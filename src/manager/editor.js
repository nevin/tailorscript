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

// Text helpers for the guide, kept apart from the page so they can be tested without a DOM.
import { topics } from "./content.js";

const keywords = "async|await|break|case|catch|class|const|continue|else|for|function|if|let|new|of|return|throw|try|while";
const tokens = new RegExp([
  "(\\/\\/[^\\n]*)",
  "(`(?:\\\\[\\s\\S]|[^`\\\\])*`|\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*')",
  "\\b(GM[_.]\\w+|unsafeWindow)\\b",
  `\\b(${keywords})\\b`,
  "\\b(\\d+(?:\\.\\d+)?)\\b"
].join("|"), "g");
const kinds = ["comment", "string", "api", "keyword", "number"];

// Splits example code into { text, kind } pieces for colouring. Header lines get their @key marked.
export function highlight(source) {
  const pieces = [];
  let last = 0;
  for (const match of source.matchAll(tokens)) {
    if (match.index > last) pieces.push({ text: source.slice(last, match.index) });
    const kind = kinds[match.slice(1).findIndex(group => group !== undefined)];
    const key = kind === "comment" && match[0].match(/^(\/\/\s*)(@[\w:.-]+|==\/?UserScript==)(.*)$/);
    if (key) pieces.push({ text: key[1], kind }, { text: key[2], kind: "meta" }, { text: key[3], kind });
    else pieces.push({ text: match[0], kind });
    last = match.index + match[0].length;
  }
  if (last < source.length) pieces.push({ text: source.slice(last) });
  return pieces.filter(piece => piece.text);
}

// Turns text with `backticks` into text and <code> nodes.
export function richText(text) {
  return text.split("`").map((part, index) => {
    if (index % 2 === 0) return part;
    const node = document.createElement("code");
    node.textContent = part;
    return node;
  }).filter(Boolean);
}

// The task that explains an API (GM_setValue), or the task with that id.
export function topicFor(name) {
  return topics.find(topic => topic.id === name || topic.apis.includes(name));
}

// Where the guide explains an API or a header key, for links from the editor.
export function guideAnchor(name) {
  if (name.startsWith("@")) return `#meta-${name.slice(1)}`;
  return topicFor(name) ? `#${name}` : "";
}

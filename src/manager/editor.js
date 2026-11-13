import { tokenizer } from "../vendor/acorn/acorn.mjs";

// Read-only syntax highlighting for code previews such as the install page.
export function highlight(source, output) {
  const spans = [];
  const tokens = tokenizer(source, {
    ecmaVersion: "latest",
    onComment: (_block, _text, start, end) => spans.push({ start, end, kind: "comment" })
  });
  try {
    for (const token of tokens) {
      const label = token.type.label;
      const kind = token.type.keyword ? "keyword"
        : ["string", "template", "regexp"].includes(label) ? "string"
        : ["num", "bigint"].includes(label) ? "number" : "";
      if (kind) spans.push({ start: token.start, end: token.end, kind });
    }
  } catch {
    // Show the rest as plain text after a syntax error.
  }
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const { start, end, kind } of spans.sort((a, b) => a.start - b.start)) {
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

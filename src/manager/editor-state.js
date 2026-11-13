// Editor state that updates incrementally, so typing in a long script doesn't re-read the whole text on every keystroke.
// Nothing here touches the DOM, so tests can run it on a plain EditorState.
import { StateField, syntaxTree } from "../vendor/codemirror/codemirror.js";
import { metadataLines, signatureFor } from "./intellisense.js";

// The metadata header, re-read only when an edit reaches it. Edits below the header leave its offsets unchanged.
export const metadataField = StateField.define({
  create: state => metadataLines(state.doc.toString()),
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    const end = value.block ? value.block.to + 1 : transaction.startState.doc.length;
    return transaction.changes.touchesRange(0, end) ? metadataLines(transaction.state.doc.toString()) : value;
  }
});

// Nodes that end the search for an enclosing call: inside them the hint would describe the wrong thing. While an
// object or array is still being typed, the parser reads it as a pattern.
const boundaries = new Set(["ObjectExpression", "ObjectPattern", "ArrayExpression", "ArrayPattern", "Block", "TemplateString", "String", "LineComment", "BlockComment"]);
const closers = new Set(["}", "]", "`", "\"", "'", "/"]);

// Whether the cursor is inside node. A cursor just after a finished node such as {...} is outside it.
function contains(state, node, pos) {
  if (pos <= node.from) return false;
  if (pos < node.to) return true;
  return node.to - node.from < 2 || !closers.has(state.sliceDoc(node.to - 1, node.to)) || node.name === "LineComment";
}

// The GM call whose argument list holds the cursor, from the syntax tree CodeMirror already keeps up to date.
export function callAt(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (boundaries.has(node.name) && contains(state, node, pos)) return null;
    if (node.name !== "ArgList" || node.parent?.name !== "CallExpression") continue;
    const closed = node.lastChild?.name === ")" && node.lastChild.from < node.lastChild.to;
    if (pos <= node.from || (closed && pos >= node.to)) return null;
    const callee = node.parent.firstChild;
    const name = state.sliceDoc(callee.from, callee.to).replace(/\s+/g, "");
    let argument = 0;
    for (let child = node.firstChild; child && child.from < pos; child = child.nextSibling) {
      if (child.name === ",") argument++;
    }
    return { name, argument };
  }
  return null;
}

export function signatureInState(state, pos) {
  const { block } = state.field(metadataField);
  if (block && pos > block.from && pos <= block.to) return null;
  const call = callAt(state, pos);
  return call && signatureFor(call.name, call.argument);
}

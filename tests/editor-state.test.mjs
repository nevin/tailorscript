import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState, javascript } from "../src/vendor/codemirror/codemirror.js";
import { callAt, metadataField, signatureInState } from "../src/manager/editor-state.js";
import { diagnose, metadataLines } from "../src/manager/intellisense.js";
import { userscript } from "./helpers/chrome.mjs";

const stateOf = doc => EditorState.create({ doc, extensions: [javascript(), metadataField] });
const end = text => text.length;

test("the header is re-read only when an edit reaches it", () => {
  const state = stateOf(userscript("let a = 1;"));
  const header = state.field(metadataField);
  const body = state.update({ changes: { from: state.doc.length, insert: "\nlet b = 2;" } }).state;
  assert.equal(body.field(metadataField), header, "body edits keep the same header object");
  const renamed = body.update({ changes: { from: body.doc.toString().indexOf("Test"), to: body.doc.toString().indexOf("Test") + 4, insert: "Renamed" } }).state;
  assert.notEqual(renamed.field(metadataField), header);
  assert.equal(renamed.field(metadataField).lines.find(line => line.key === "name").value, "Renamed");
  assert.deepEqual(renamed.field(metadataField), metadataLines(renamed.doc.toString()));
});

test("finds the GM call and argument at the cursor from the syntax tree", () => {
  const open = userscript('GM_setValue("a", { b: [1, 2], c: f(3, 4) }');
  assert.deepEqual(callAt(stateOf(open), end(open)), { name: "GM_setValue", argument: 1 });
  const member = userscript("GM.openInTab(");
  assert.equal(signatureInState(stateOf(member), end(member)).name, "GM.openInTab");
  const inner = userscript('GM_setValue("a", f(1, ');
  assert.equal(signatureInState(stateOf(inner), end(inner)), null, "the innermost call is f, not a GM API");
  const closed = userscript("GM_setValue(1, 2);");
  assert.equal(signatureInState(stateOf(closed), end(closed)), null);
  const object = userscript("GM_xmlhttpRequest({ url");
  assert.equal(callAt(stateOf(object), end(object)), null, "no hint inside the details object");
  const header = userscript("x;");
  assert.equal(signatureInState(stateOf(header), header.indexOf("@match")), null);
});

test("diagnosing a long script stays fast", () => {
  const body = Array.from({ length: 4000 }, (_, index) => `GM_setValue("k${index}", ${index}); GM_addStyle("a{}");`).join("\n");
  const source = userscript(body);
  const started = performance.now();
  const found = diagnose(source);
  const took = performance.now() - started;
  assert.equal(found.filter(item => item.message.startsWith("GM_setValue needs")).length, 4000);
  assert.equal(new Set(found.filter(item => item.actions).map(item => item.actions[0].change)).size, 2, "one fix per API, shared by every use");
  assert.ok(took < 1500, `diagnose took ${Math.round(took)} ms`);
});

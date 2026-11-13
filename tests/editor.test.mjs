import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines } from "../src/manager/diff.js";
import { addGrants, completions, editLines, findMatches, missingGrants } from "../src/manager/editor.js";
import { parseSource } from "../src/shared/userscript.js";
import { userscript } from "./helpers/chrome.mjs";

test("editLines indents, outdents and toggles comments on whole lines", () => {
  assert.equal(editLines("a\n  b\nc", 2, 5, "indent").text, "    b");
  assert.equal(editLines("a\nb\nc", 0, 3, "comment").text, "// a\n// b");
  assert.equal(editLines("// a\n// b", 0, 9, "comment").text, "a\nb");
  assert.equal(editLines("a\n\nb", 0, 4, "comment").text, "// a\n\n// b");
  const outdent = editLines("  x", 3, 3, "outdent");
  assert.deepEqual([outdent.text, outdent.selectionStart, outdent.selectionEnd], ["x", 1, 1]);
});

test("findMatches honours case sensitivity and skips overlaps", () => {
  assert.deepEqual(findMatches("aAaa", "a", false), [0, 1, 2, 3]);
  assert.deepEqual(findMatches("aAaa", "aa", true), [2]);
  assert.deepEqual(findMatches("abc", "", false), []);
});

test("diffLines marks added, removed and unchanged lines", () => {
  const rows = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne").map(row => row.kind[0] + row.text);
  assert.deepEqual(rows, ["sa", "rb", "aB", "sc", "sd", "ae"]);
  assert.ok(diffLines("same", "same").every(row => row.kind === "same"));
});

test("completions suggest metadata keys, values and GM APIs", () => {
  const header = "// ==UserScript==\n// @na";
  const keys = completions(header + "\n// ==/UserScript==\n", header.length);
  assert.deepEqual(keys.items.map(item => item.label), ["name", "namespace"]);
  assert.equal(keys.items[0].insert, "name        ");
  assert.equal(keys.from, header.length - 2);
  const grant = "// ==UserScript==\n// @grant GM_get";
  assert.deepEqual(completions(grant, grant.length).items.map(item => item.label), ["GM_getValue", "GM_getResourceText", "GM_getResourceURL"]);
  const runAt = "// ==UserScript==\n// @run-at document-e";
  assert.deepEqual(completions(runAt, runAt.length).items.map(item => item.label), ["document-end"]);
  const code = userscript("GM.xml");
  const api = completions(code, code.length);
  assert.deepEqual(api.items.map(item => item.label), ["GM.xmlHttpRequest"]);
  assert.equal(api.from, code.length - 6);
  assert.equal(completions(userscript("const value"), userscript("const value").length), null);
});

test("missingGrants finds APIs used without @grant and addGrants fixes them", () => {
  const source = userscript("GM_addStyle('a'); GM.getValue('k'); GM_getValue('k'); obj.GM_setValue(); GM_info.script; // GM_setClipboard", "// @grant none\n");
  assert.deepEqual(missingGrants(source), ["GM_addStyle", "GM.getValue", "GM_getValue"]);
  const fixed = addGrants(source, missingGrants(source));
  assert.deepEqual(parseSource(fixed).grants, ["GM_addStyle", "GM.getValue", "GM_getValue"]);
  assert.doesNotMatch(fixed, /@grant\s+none/);
  assert.deepEqual(missingGrants(fixed), []);
  assert.deepEqual(missingGrants(userscript("GM_getValue('k');", "// @grant GM.getValue\n")), ["GM_getValue"]);
  assert.deepEqual(missingGrants(userscript("GM.setValue('k', 1);", "// @grant GM_setValue\n")), []);
});

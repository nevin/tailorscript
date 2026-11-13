import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines } from "../src/manager/diff.js";
import { editLines, findMatches } from "../src/manager/editor.js";

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

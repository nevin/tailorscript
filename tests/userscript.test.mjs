import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesUrl, originsFor, parseSource, runsOn, updateTargets } from "../src/shared/userscript.js";
import { validate } from "../src/shared/validate.js";
import { userscript } from "./helpers/chrome.mjs";

test("parseSource reads names, matches, timing, frames and tags", () => {
  const metadata = parseSource(userscript("x;", "// @run-at document-start\n// @all-frames\n// @tag work, tools\n// @tag work\n"));
  assert.equal(metadata.name, "Test");
  assert.deepEqual(metadata.matches, ["https://a.com/*"]);
  assert.equal(metadata.runAt, "document_start");
  assert.equal(metadata.allFrames, true);
  assert.deepEqual(metadata.tags, ["work", "tools"]);
});

test("parseSource rejects unsupported metadata", () => {
  assert.throws(() => parseSource(userscript("x;", "// @grant GM_xmlhttpRequest\n")), /@grant/);
  assert.throws(() => parseSource(userscript("x;", "// @require https://cdn.example/x.js\n")), /@require is unsupported/);
  assert.throws(() => parseSource(userscript("x;", "// @noframes\n// @all-frames\n")), /either @all-frames or @noframes/);
  assert.throws(() => parseSource("// ==UserScript==\n// ==/UserScript==\nx;"), /@match/);
  assert.throws(() => parseSource(userscript("")), /JavaScript below/);
});

test("validate reports JavaScript syntax errors with their cause", () => {
  assert.throws(() => validate(userscript("let = ;")), error => error.message.startsWith("JavaScript:") && error.cause instanceof SyntaxError);
});

test("match helpers follow Chrome match pattern rules", () => {
  assert.ok(matchesUrl("https://*.ex.com/*", new URL("https://ex.com/a")));
  assert.ok(matchesUrl("*://ex.com/p?q", new URL("http://ex.com/p?q")));
  assert.ok(!matchesUrl("https://ex.com/a", new URL("https://ex.com/ab")));
  const source = "// ==UserScript==\n// @match https://*.ex.com/*\n// @exclude-match https://a.ex.com/*\n// ==/UserScript==\nx;";
  assert.ok(runsOn(source, new URL("https://b.ex.com/")));
  assert.ok(!runsOn(source, new URL("https://a.ex.com/")));
  assert.deepEqual(originsFor(["https://a.com/x/*", "https://a.com/y", "*://b.com/*"]), ["https://a.com/*", "*://b.com/*"]);
});

test("updateTargets rewrites name and matches but keeps other metadata and the body", () => {
  const next = updateTargets(userscript("body();", "// @grant none\n"), "Renamed", ["https://b.com/*"]);
  const metadata = parseSource(next);
  assert.equal(metadata.name, "Renamed");
  assert.deepEqual(metadata.matches, ["https://b.com/*"]);
  assert.deepEqual(metadata.grants, ["none"]);
  assert.ok(next.endsWith("body();"));
  assert.ok(parseSource(updateTargets("", "New", ["https://c.com/*"]) + "\n;"));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOverrides, decodeImportFile, headerValues, keepInPage } from "../src/manager/import-formats.js";
import { readZip } from "../src/shared/zip.js";
import { zip } from "./helpers/zip.mjs";

const script = (name, extra = "") => `// ==UserScript==\n// @name        ${name}\n// @namespace   ns\n// @match       https://a.com/*\n${extra}// ==/UserScript==\nvoid 0;\n`;

test("readZip reads stored and deflated files and skips folders", async () => {
  for (const deflate of [true, false]) {
    const files = await readZip(zip({ "dir/": "", "a.txt": "hello", "b/c.txt": "é".repeat(500) }, { deflate }));
    assert.deepEqual([...files.keys()], ["a.txt", "b/c.txt"]);
    assert.equal(new TextDecoder().decode(files.get("b/c.txt")), "é".repeat(500));
  }
  await assert.rejects(readZip(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])), /complete zip/);
});

test("Tampermonkey backups keep state, values, site rules and order", async () => {
  const bytes = zip({
    "Second.user.js": script("Second"),
    "Second.options.json": JSON.stringify({ settings: { enabled: false, position: 2 }, options: {} }),
    "First.user.js": script("First", "// @run-at      document-idle\n"),
    "First.options.json": JSON.stringify({
      settings: { enabled: true, position: 1 },
      options: { run_at: "document-start", override: { use_matches: ["https://b.com/*"], use_excludes: ["https://a.com/admin*"], merge_includes: true, noframes: true } }
    }),
    "First.storage.json": JSON.stringify({ ts: 1, data: { theme: "dark", count: 3 } })
  });
  const { manager, entries } = await decodeImportFile("tampermonkey-backup.zip", bytes);
  assert.equal(manager, "Tampermonkey");
  assert.deepEqual(entries.map(entry => headerValues(entry.source, "name")[0]), ["First", "Second"]);
  const [first, second] = entries;
  assert.equal(first.wasEnabled, true);
  assert.equal(second.wasEnabled, false);
  assert.deepEqual(first.values, { theme: "dark", count: 3 });
  assert.deepEqual(headerValues(first.source, "match"), ["https://a.com/*", "https://b.com/*"]);
  assert.deepEqual(headerValues(first.source, "exclude"), ["https://a.com/admin*"]);
  assert.deepEqual(headerValues(first.source, "run-at"), ["document-start"]);
  assert.equal(headerValues(first.source, "noframes").length, 1);
  assert.equal(first.notes.length, 4);
  // It asks for no APIs, so it runs in the page as it did in Tampermonkey.
  assert.deepEqual(headerValues(first.source, "inject-into"), ["page"]);
  assert.match(first.notes.at(-1), /Runs in the page itself/);
});

test("macOS archive copies are ignored", async () => {
  const finder = zip({
    "One.user.js": script("One"),
    "One.options.json": JSON.stringify({ settings: { enabled: true }, options: {} }),
    "__MACOSX/._One.user.js": "\u0000\u0005\u0016\u0007binary",
    "__MACOSX/._One.options.json": "\u0000\u0005\u0016\u0007binary",
    "folder/._Two.user.js": "\u0000binary"
  });
  const { manager, entries } = await decodeImportFile("re-zipped.zip", finder);
  assert.equal(manager, "Tampermonkey");
  assert.deepEqual(entries.map(entry => headerValues(entry.source, "name")[0]), ["One"]);
});

test("Violentmonkey backups decode typed values matched by namespace and name", async () => {
  const uri = "ns-0aFirst-20one-0a";
  const bytes = zip({
    "First one.user.js": script("First one"),
    violentmonkey: JSON.stringify({
      scripts: { "First one": { config: { enabled: 0 }, custom: { match: ["https://c.com/*"], origMatch: false }, position: 1 } },
      values: { [uri]: { s: "stext", n: "n42", b: "btrue", o: 'o{"x":[1]}' } }
    })
  });
  const { manager, entries: [entry] } = await decodeImportFile("violentmonkey.zip", bytes);
  assert.equal(manager, "Violentmonkey");
  assert.equal(entry.wasEnabled, false);
  assert.deepEqual(entry.values, { s: "text", n: 42, b: true, o: { x: [1] } });
  assert.deepEqual(headerValues(entry.source, "match"), ["https://c.com/*"], "its own @match lines were turned off in Violentmonkey");
  assert.match(entry.notes.join(" "), /ignore the script’s own @match/);
});

test("any zip of .user.js files, Tampermonkey text exports, backups and single scripts are read", async () => {
  const generic = await decodeImportFile("greasemonkey.zip", zip({ "a/One.user.js": script("One"), "readme.txt": "x" }));
  assert.equal(generic.entries.length, 1);
  assert.equal(generic.entries[0].wasEnabled, undefined);

  const encoded = Buffer.from(script("Encoded")).toString("base64");
  const text = JSON.stringify({ created_by: "Tampermonkey", version: "1", scripts: [{ name: "Encoded", enabled: true, source: encoded, storage: { data: { k: 1 } } }] });
  const tm = await decodeImportFile("tampermonkey.txt", new TextEncoder().encode(text));
  assert.equal(tm.manager, "Tampermonkey");
  assert.equal(headerValues(tm.entries[0].source, "name")[0], "Encoded");
  assert.deepEqual(tm.entries[0].values, { k: 1 });

  const backup = JSON.stringify({ version: 1, scripts: [{ source: script("Mine"), history: [{ source: "old", savedAt: 1, label: "v1" }, { bad: true }] }] });
  const ours = await decodeImportFile("tailorscript-backup.json", new TextEncoder().encode(backup));
  assert.equal(ours.manager, "Tailorscript");
  assert.deepEqual(ours.entries[0].history, [{ source: "old", savedAt: 1, label: "v1" }]);

  const single = await decodeImportFile("one.user.js", new TextEncoder().encode("﻿" + script("Single")));
  assert.equal(headerValues(single.entries[0].source, "name")[0], "Single");

  await assert.rejects(decodeImportFile("x.zip", zip({ "notes.txt": "x" })), /no \.user\.js/);

  const mixed = JSON.stringify({ created_by: "Tampermonkey", scripts: ["oops", null, { source: script("Real"), options: {} }] });
  const cleaned = await decodeImportFile("tampermonkey.txt", new TextEncoder().encode(mixed));
  assert.equal(cleaned.entries.length, 1);
  assert.equal(cleaned.skipped, 2);
  await assert.rejects(decodeImportFile("x.json", new TextEncoder().encode('{"hello":1}')), /isn’t a backup/);
});

test("only imported scripts that ask for no APIs are moved into the page", () => {
  const notes = [];
  assert.match(keepInPage(script("Plain"), "Tampermonkey", notes), /@inject-into page/);
  assert.match(keepInPage(script("None", "// @grant none\n"), "Tampermonkey", notes), /@inject-into page/);
  const withApi = script("Api", "// @grant GM_setValue\n");
  assert.equal(keepInPage(withApi, "Tampermonkey", notes), withApi);
  const chosen = script("Chosen", "// @inject-into content\n");
  assert.equal(keepInPage(chosen, "Tampermonkey", notes), chosen);
  assert.equal(notes.length, 2);
});

test("applyOverrides leaves scripts without a header and unchanged settings alone", () => {
  const notes = [];
  assert.equal(applyOverrides("void 0;", { match: ["https://b.com/*"] }, "Tampermonkey", notes), "void 0;");
  const source = script("Same", "// @run-at      document-start\n");
  assert.equal(applyOverrides(source, { match: ["https://a.com/*"], runAt: "document-start" }, "Tampermonkey", notes), source);
  assert.deepEqual(notes, []);
  const framed = applyOverrides(source, { noframes: 0 }, "Violentmonkey", notes);
  assert.match(framed, /^\/\/ @all-frames$/m);
});

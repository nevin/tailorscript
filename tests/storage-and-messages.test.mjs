import assert from "node:assert/strict";
import { test } from "node:test";
import { installChrome, storedScripts } from "./helpers/chrome.mjs";

installChrome();
const local = chrome.storage.local.data;
const { applyScriptChanges, migrate, readScripts, schemaVersion, writeScripts } = await import("../src/shared/storage.js");
const { checkMessage, pageMessages, scriptMessages } = await import("../src/shared/messages.js");
const { formatDiagnostics } = await import("../src/shared/diagnostics.js");

test("upgrades the single scripts array to one key per script", async () => {
  const legacy = [{ id: "a", name: "A", source: "1" }, { id: "b", name: "B", source: "2" }];
  Object.assign(local, { scripts: legacy, settings: { paused: true } });
  assert.deepEqual(await readScripts(), legacy, "pages read the old layout before the upgrade");
  assert.deepEqual(await migrate(), { from: 1, to: schemaVersion });
  assert.equal(local.schemaVersion, 2);
  assert.equal("scripts" in local, false);
  assert.deepEqual(local.scriptOrder, ["a", "b"]);
  assert.deepEqual(await readScripts(), legacy);
  assert.deepEqual(local.settings, { paused: true });
  assert.deepEqual(await migrate(), { from: 2, to: 2 }, "running again changes nothing");
});

test("refuses a library from a newer version", async () => {
  local.schemaVersion = 99;
  await assert.rejects(migrate(), /newer Tailorscript/);
  local.schemaVersion = 2;
});

test("writes only the scripts that changed and removes deleted ones", async () => {
  const scripts = await readScripts();
  const writes = [];
  const set = chrome.storage.local.set;
  chrome.storage.local.set = async items => {
    writes.push(Object.keys(items));
    return set(items);
  };
  scripts[1] = { ...scripts[1], source: "changed" };
  scripts.push({ id: "c", name: "C", source: "3" });
  scripts.shift();
  await writeScripts(scripts, { trash: [] });
  chrome.storage.local.set = set;
  assert.deepEqual(writes[0].sort(), ["schemaVersion", "script:b", "script:c", "scriptOrder", "trash"]);
  assert.equal("script:a" in local, false);
  assert.deepEqual(storedScripts().map(script => script.source), ["changed", "3"]);
});

test("applies storage change events to a page's copy of the library", () => {
  const scripts = [{ id: "a", source: "1" }, { id: "b", source: "2" }];
  assert.equal(applyScriptChanges(scripts, { settings: { newValue: {} } }), null);
  assert.deepEqual(applyScriptChanges(scripts, { "script:b": { newValue: { id: "b", source: "3" } } }),
    [{ id: "a", source: "1" }, { id: "b", source: "3" }]);
  assert.deepEqual(applyScriptChanges(scripts, { scriptOrder: { newValue: ["b"] } }), [{ id: "b", source: "2" }]);
  assert.deepEqual(applyScriptChanges(scripts, { scripts: { newValue: [{ id: "z" }] } }), [{ id: "z" }]);
  assert.equal(applyScriptChanges(scripts, { scripts: { oldValue: [] } }), null, "the upgrade removing the old key changes nothing");
});

test("checks message fields against their declared types", () => {
  assert.doesNotThrow(() => checkMessage(pageMessages, { type: "save", id: "a", script: { source: "x", enabled: true }, expected: null }));
  assert.throws(() => checkMessage(pageMessages, { type: "save", id: "a", script: { source: 1, enabled: true } }), /script\.source should be a string/);
  assert.throws(() => checkMessage(pageMessages, { type: "toggle", id: "a" }), /enabled is missing/);
  assert.throws(() => checkMessage(pageMessages, { type: "import", entries: [{ source: "x", history: "no" }] }), /entries\[0\]\.history should be a array/);
  assert.throws(() => checkMessage(pageMessages, { type: "toString" }), /Unknown message/);
  assert.throws(() => checkMessage(scriptMessages, { type: "xhr", requestId: "r", request: { url: 5 } }), /request\.url/);
  assert.doesNotThrow(() => checkMessage(scriptMessages, { type: "value", op: "list" }));
});

test("formats diagnostics without script sources", () => {
  const text = formatDiagnostics({
    version: "0.5.0", browser: "Chrome/142", schemaVersion: 2, userScripts: "available", paused: false,
    scripts: { total: 2, enabled: 1, registered: 1 }, siteAccess: ["https://a.com/*"],
    issues: [{ script: "A", issue: "Grant site access." }],
    recentErrors: [{ script: "B", message: "x is not defined", line: 4, at: 0 }]
  });
  assert.match(text, /Tailorscript 0\.5\.0/);
  assert.match(text, /2 saved, 1 enabled, 1 registered/);
  assert.match(text, /- A: Grant site access\./);
  assert.match(text, /- B \(line 4\): x is not defined \[1970-01-01T00:00:00\.000Z\]/);
});

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { installChrome, userscript } from "./helpers/chrome.mjs";

const managerUrl = "chrome-extension://test/manager/index.html";
const popupUrl = "chrome-extension://test/popup/popup.html";
let listeners;
let local;

before(async () => {
  ({ listeners } = installChrome());
  local = chrome.storage.local.data;
  await import("../src/background/service-worker.js");
});

const call = (message, url = managerUrl) => new Promise(resolve => {
  assert.equal(listeners.message(message, { url }, resolve), true);
});
const fromScript = (message, sender) => new Promise(resolve => {
  if (!listeners.userScriptMessage(message, sender, resolve)) setTimeout(resolve, 20);
});
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const find = id => local.scripts.find(script => script.id === id);

test("saves scripts, keeps history and rejects stale edits", async () => {
  const saved = await call({ type: "save", id: "s1", script: { source: userscript("1;"), enabled: true } });
  assert.ok(saved.ok, saved.error);
  assert.deepEqual(saved.state.active, ["s1"]);
  const first = find("s1");
  await call({ type: "save", id: "s1", script: { source: userscript("2;"), enabled: true }, expected: first });
  assert.equal(find("s1").history.length, 1);
  const stale = await call({ type: "save", id: "s1", script: { source: userscript("3;"), enabled: true }, expected: first });
  assert.match(stale.error, /changed in another editor/);
});

test("ignores messages from other origins and lets the popup toggle", async () => {
  assert.equal(listeners.message({ type: "sync" }, { url: "https://example.com/" }, () => {}), false);
  const toggled = await call({ type: "toggle", id: "s1", enabled: false }, popupUrl);
  assert.equal(find("s1").enabled, false);
  assert.deepEqual(toggled.state.active, []);
  await call({ type: "toggle", id: "s1", enabled: true });
});

test("settings accept known keys only and pausing unregisters", async () => {
  await call({ type: "settings", patch: { paused: true, reloadAfterSave: "yes", unknown: 1 } });
  assert.deepEqual(local.settings, { paused: true });
  assert.deepEqual((await call({ type: "sync" })).state.active, []);
  await call({ type: "settings", patch: { paused: false } });
});

test("moves scripts to change run order", async () => {
  await call({ type: "save", id: "s2", script: { source: userscript("x;", "// @grant GM.getValue\n// @grant GM.setValue\n// @grant GM.listValues\n"), enabled: true } });
  await call({ type: "move", id: "s2", offset: -1 });
  assert.deepEqual(local.scripts.map(({ id }) => id), ["s2", "s1"]);
});

test("serves GM values only for granted operations", async () => {
  const sender = { userScriptWorldId: "s2" };
  assert.deepEqual(await fromScript({ type: "value", op: "set", key: "k", value: { a: 1 } }, sender), { value: undefined });
  assert.deepEqual((await fromScript({ type: "value", op: "get", key: "k" }, sender)).value, { a: 1 });
  assert.deepEqual((await fromScript({ type: "value", op: "list" }, sender)).value, ["k"]);
  assert.match((await fromScript({ type: "value", op: "delete", key: "k" }, sender)).error, /GM.deleteValue/);
  assert.match((await fromScript({ type: "value", op: "get", key: "k" }, { userScriptWorldId: "s1" })).error, /@grant/);
  assert.match((await fromScript({ type: "value", op: "set", key: "big", value: "x".repeat(1_100_000) }, sender)).error, /1 MB/);
});

test("records runs and errors per tab and resets on a new document", async () => {
  const sender = (id, documentId) => ({ userScriptWorldId: id, url: "https://a.com/", tab: { id: 7 }, frameId: 0, documentId });
  await fromScript({ type: "run" }, sender("s1", "d1"));
  await fromScript({ type: "error", message: "boom", line: 3, column: 1 }, sender("s1", "d1"));
  await settle();
  const session = chrome.storage.session.data;
  assert.equal(session.runs.s1.error.line, 3);
  assert.equal(session.tabRuns[7].scripts.s1.error.message, "boom");
  await fromScript({ type: "run" }, sender("s2", "d2"));
  await settle();
  assert.deepEqual(Object.keys(session.tabRuns[7].scripts), ["s2"]);
  listeners.tabRemoved(7);
  await settle();
  assert.equal(session.tabRuns[7], undefined);
});

test("trash keeps deleted scripts, restores them disabled and expires them", async () => {
  await call({ type: "delete", id: "s2", expected: find("s2") });
  assert.equal(local.trash.length, 1);
  await call({ type: "restore", id: "s2" });
  assert.equal(local.trash.length, 0);
  assert.equal(find("s2").enabled, false);
  assert.equal(find("s2").deletedAt, undefined);
  await call({ type: "delete", id: "s2", expected: find("s2") });
  local["values:s2"] = { a: 1 };
  local.trash[0].deletedAt = Date.now() - 31 * 86_400_000;
  await call({ type: "sync" });
  assert.equal(local.trash.length, 0);
  assert.equal(local["values:s2"], undefined);
});

test("labels versions and imports copies or disabled replacements", async () => {
  const { savedAt } = find("s1").history[0];
  await call({ type: "label", id: "s1", savedAt, label: "  works " });
  assert.equal(find("s1").history[0].label, "works");
  await call({ type: "import", entries: [{ source: userscript("new;"), history: [] }, { source: userscript("replaced;"), history: [], replace: "s1" }] });
  assert.equal(local.scripts.length, 2);
  assert.equal(find("s1").enabled, false);
  assert.ok(find("s1").source.includes("replaced;"));
  assert.equal(find("s1").history.length, 2);
});

test("backs up to Chrome sync when enabled", async () => {
  await call({ type: "settings", patch: { syncBackup: true } });
  assert.ok(local.syncState.at && !local.syncState.error);
  assert.equal(chrome.storage.sync.data.syncBackup.count, 2);
});

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { installChrome, installFetch, userscript } from "./helpers/chrome.mjs";

const managerUrl = "chrome-extension://test/manager/index.html";
const popupUrl = "chrome-extension://test/popup/popup.html";
const installUrl = "chrome-extension://test/install/install.html#https://x.org/s.user.js";
let listeners;
let calls;
let local;
let network;

before(async () => {
  ({ listeners, calls } = installChrome());
  local = chrome.storage.local.data;
  network = installFetch({
    "https://cdn.example/lib.js": "window.lib = 1;",
    "https://cdn.example/logo.png": { body: new Uint8Array([1, 2, 3]), headers: { "content-type": "image/png" } }
  });
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
const versioned = (version, extra = "") => userscript("run();", `// @version     ${version}\n// @namespace   x.org\n${extra}`);

test("saving downloads @require and @resource files once", async () => {
  const source = userscript("x;", "// @require https://cdn.example/lib.js\n// @resource logo https://cdn.example/logo.png\n");
  const saved = await call({ type: "save", id: "d1", script: { source, enabled: true } });
  assert.ok(saved.ok, saved.error);
  assert.deepEqual(saved.state.active, ["d1"]);
  assert.equal(local["deps:d1"].requires[0].code, "window.lib = 1;");
  assert.equal(local["deps:d1"].resources[0].dataUrl, "data:image/png;base64,AQID");
  const fetched = network.requests.length;
  await call({ type: "save", id: "d1", script: { source: source + "\ny;", enabled: true }, expected: find("d1") });
  assert.equal(network.requests.length, fetched);
  const failed = await call({ type: "save", id: "d1", script: { source: userscript("x;", "// @require https://cdn.example/missing.js\n"), enabled: true }, expected: find("d1") });
  assert.match(failed.error, /Couldn’t download https:\/\/cdn\.example\/missing\.js/);
});

test("installs from a URL, then replaces the same script on reinstall", async () => {
  const installed = await call({ type: "install", source: versioned("1.0"), url: "https://x.org/s.user.js", enabled: true }, installUrl);
  assert.ok(installed.ok, installed.error);
  const id = installed.state.installedId;
  assert.equal(find(id).installUrl, "https://x.org/s.user.js");
  assert.equal(find(id).autoUpdate, true);
  assert.match(find(id).installedHash, /^[a-f\d]{64}$/);
  const again = await call({ type: "install", id, source: versioned("1.1"), url: "https://x.org/s.user.js", enabled: true }, installUrl);
  assert.equal(again.state.installedId, id);
  assert.equal(find(id).history.length, 1);
  const rejected = await call({ type: "install", source: versioned("1"), url: "file:///x.user.js" }, installUrl);
  assert.match(rejected.error, /http or https/);
});

test("updates apply automatically unless they need review", async () => {
  const id = local.scripts.find(script => script.installUrl).id;
  network.routes["https://x.org/s.user.js"] = versioned("1.2");
  let result = await call({ type: "check-updates" });
  assert.deepEqual(result.state.updateSummary.updated, ["Test"]);
  assert.match(find(id).source, /@version {5}1\.2/);
  assert.equal(find(id).updateCheck.latest, "1.2");

  network.routes["https://x.org/s.user.js"] = versioned("1.3", "// @grant GM_xmlhttpRequest\n// @connect api.x.org\n");
  result = await call({ type: "check-updates", id });
  assert.equal(result.state.updateSummary.waiting.length, 1);
  const { pendingUpdate } = find(id);
  assert.equal(pendingUpdate.version, "1.3");
  assert.ok(pendingUpdate.reasons.some(reason => reason.includes("GM_xmlhttpRequest")));
  assert.ok(pendingUpdate.reasons.some(reason => reason.includes("api.x.org")));
  assert.match(find(id).source, /1\.2/);

  await call({ type: "dismiss-update", id });
  assert.equal(find(id).pendingUpdate, undefined);
  result = await call({ type: "check-updates", id });
  assert.equal(result.state.updateSummary.waiting.length, 0);

  network.routes["https://x.org/s.user.js"] = versioned("1.4", "// @grant GM_xmlhttpRequest\n");
  await call({ type: "check-updates", id });
  assert.ok(find(id).pendingUpdate);
  const applied = await call({ type: "apply-update", id });
  assert.ok(applied.ok, applied.error);
  assert.match(find(id).source, /1\.4/);

  await call({ type: "save", id, script: { source: find(id).source + "\n// mine", enabled: true }, expected: find(id) });
  network.routes["https://x.org/s.user.js"] = versioned("1.5", "// @grant GM_xmlhttpRequest\n");
  await call({ type: "check-updates", id });
  assert.ok(find(id).pendingUpdate.reasons.some(reason => reason.includes("edited")));

  delete network.routes["https://x.org/s.user.js"];
  await call({ type: "check-updates", id });
  assert.match(find(id).updateCheck.error, /Couldn’t download/);
  assert.ok(find(id).pendingUpdate, "a failed check keeps the waiting update");
});

test("GM_xmlhttpRequest only reaches the page's site and @connect hosts", async () => {
  await call({ type: "save", id: "x1", script: { source: userscript("x;", "// @grant GM_xmlhttpRequest\n// @connect example.org\n"), enabled: true } });
  network.routes["https://api.example.org/data"] = { body: "hello", status: 201, headers: { "content-type": "text/plain" } };
  const sender = { userScriptWorldId: "x1", url: "https://a.com/page" };
  const ok = await fromScript({ type: "xhr", requestId: "r1", request: { url: "https://api.example.org/data", method: "POST", body: { text: "q" }, headers: { "X-Test": "1" } } }, sender);
  assert.equal(ok.value.status, 201);
  assert.equal(Buffer.from(ok.value.body, "base64").toString(), "hello");
  const request = network.requests.at(-1);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("x-test"), "1");
  const blocked = await fromScript({ type: "xhr", requestId: "r2", request: { url: "https://evil.test/" } }, sender);
  assert.match(blocked.error, /@connect evil\.test/);
  const ungranted = await fromScript({ type: "xhr", requestId: "r3", request: { url: "https://a.com/" } }, { userScriptWorldId: "d1", url: "https://a.com/" });
  assert.match(ungranted.error, /@grant GM_xmlhttpRequest/);
});

test("records menu commands, runs them in the page and counts runs on the badge", async () => {
  const sender = { userScriptWorldId: "x1", url: "https://a.com/", tab: { id: 9 }, frameId: 0, documentId: "doc9" };
  await fromScript({ type: "run" }, sender);
  await fromScript({ type: "menu", op: "add", commandId: "1", caption: "Say hi" }, sender);
  await settle();
  assert.deepEqual(chrome.storage.session.data.tabRuns[9].menus.x1.map(item => item.caption), ["Say hi"]);
  assert.deepEqual(calls.findLast(([name, details]) => name === "badge" && details.tabId === 9)[1], { tabId: 9, text: "1" });
  const ran = await call({ type: "menu-run", tabId: 9, id: "x1", commandId: "1" }, popupUrl);
  assert.ok(ran.ok, ran.error);
  const [, injection] = calls.findLast(([name]) => name === "execute");
  assert.deepEqual(injection.target, { tabId: 9, documentIds: ["doc9"] });
  assert.equal(injection.worldId, "x1");
  assert.match(injection.js[0].code, /"menu", "1"/);
  await fromScript({ type: "menu", op: "remove", commandId: "1" }, sender);
  await settle();
  assert.deepEqual(chrome.storage.session.data.tabRuns[9].menus.x1, []);
});

test("Run now injects a script once, even when it is turned off", async () => {
  await call({ type: "toggle", id: "x1", enabled: false });
  const ran = await call({ type: "run-now", id: "x1", tabId: 4 }, popupUrl);
  assert.ok(ran.ok, ran.error);
  const [, injection] = calls.findLast(([name]) => name === "execute");
  assert.deepEqual(injection.target, { tabId: 4, allFrames: false });
  assert.equal(injection.world, "USER_SCRIPT");
  assert.equal(injection.js.at(-1).code, find("x1").source);
});

test("excludes a site from the popup without touching the rest of the script", async () => {
  const before = find("x1").source;
  await call({ type: "exclude-site", id: "x1", host: "a.com" }, popupUrl);
  assert.match(find("x1").source, /\/\/ @exclude-match \*:\/\/a\.com\/\*\n/);
  assert.equal(find("x1").history[0].source, before);
  assert.match((await call({ type: "exclude-site", id: "x1", host: "a.com/*" }, popupUrl)).error, /isn’t a site/);
});

test("opens and closes only tabs a script opened, and shows notifications", async () => {
  await call({ type: "save", id: "t1", script: { source: userscript("x;", "// @grant GM_openInTab\n// @grant GM_notification\n"), enabled: true } });
  const sender = { userScriptWorldId: "t1", tab: { id: 2, index: 0, windowId: 1 } };
  const opened = await fromScript({ type: "open-tab", url: "https://b.com/", active: false }, sender);
  assert.equal(typeof opened.value, "number");
  assert.deepEqual(calls.findLast(([name]) => name === "tabCreate")[1], { url: "https://b.com/", active: false, openerTabId: 2, index: 1, windowId: 1 });
  assert.match((await fromScript({ type: "open-tab", url: "javascript:alert(1)" }, sender)).error, /http and https/);
  assert.match((await fromScript({ type: "close-tab", tabId: 2 }, sender)).error, /only close tabs they opened/);
  await fromScript({ type: "close-tab", tabId: opened.value }, sender);
  assert.deepEqual(calls.at(-1), ["tabRemove", opened.value]);
  await fromScript({ type: "notify", callbackId: "c1", notification: { title: "Hi", text: "There" } }, sender);
  const [, , options] = calls.findLast(([name]) => name === "notify");
  assert.equal(options.message, "There");
});

test("the pause shortcut toggles every script and the install redirect is registered", async () => {
  listeners.command("toggle-pause");
  await settle();
  assert.equal(local.settings.paused, true);
  assert.deepEqual(calls.findLast(([name, details]) => name === "badge" && details.tabId === undefined)[1], { text: "off" });
  listeners.command("toggle-pause");
  await settle();
  assert.equal(local.settings.paused, false);
  listeners.installed();
  await settle();
  const [, rules] = calls.findLast(([name]) => name === "dnr");
  assert.equal(rules.addRules[0].action.redirect.regexSubstitution, "chrome-extension://test/install/install.html#\\0");
});

test("security: @connect is checked after redirects", async () => {
  network.routes["https://api.example.org/hop"] = { body: "secret", redirectedTo: "https://evil.test/landing" };
  const reply = await fromScript({ type: "xhr", requestId: "r9", request: { url: "https://api.example.org/hop" } }, { userScriptWorldId: "x1", url: "https://a.com/" });
  assert.match(reply.error, /redirected to evil\.test/);
  assert.equal(reply.value, undefined);
});

test("security: scripts are identified only by the world ID Chrome sets", async () => {
  assert.equal(listeners.userScriptMessage({ type: "value", op: "list", id: "x1" }, {}, () => {}), false);
});

test("security: resource data URLs keep only a plain media type", async () => {
  network.routes["https://cdn.example/odd.bin"] = { body: "x", headers: { "content-type": "text/html,<script>alert(1)</script>" } };
  const saved = await call({ type: "save", id: "r1", script: { source: userscript("x;", "// @resource odd https://cdn.example/odd.bin\n"), enabled: false } });
  assert.ok(saved.ok, saved.error);
  assert.match(local["deps:r1"].resources[0].dataUrl, /^data:application\/octet-stream;base64,/);
});

test("security: updates fetched over http wait for review", async () => {
  const insecure = (version, extra = "") => userscript("run();", `// @version     ${version}\n// @namespace   plain.org\n${extra}`);
  const installed = await call({ type: "install", source: insecure("1.0"), url: "http://plain.org/s.user.js", enabled: false }, installUrl);
  const id = installed.state.installedId;
  network.routes["http://plain.org/s.user.js"] = insecure("1.1");
  await call({ type: "check-updates", id });
  assert.match(find(id).source, /1\.0/);
  assert.ok(find(id).pendingUpdate.reasons.some(reason => reason.includes("unencrypted http")));
});

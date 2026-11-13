import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import vm from "node:vm";
import { tokenFor } from "../src/background/bridge-token.js";
import { syncScripts } from "../src/background/registration.js";
import { installChrome, userscript } from "./helpers/chrome.mjs";

let mock;
beforeEach(() => { mock = installChrome(); });

const script = (id, extra = "") => ({ id, name: id, enabled: true, source: userscript('"use strict";\nwindow.x = 1;', extra) });

test("registers enabled scripts with a prelude and the untouched source", async () => {
  const library = [script("A", "// @grant GM_addStyle\n"), script("B", "// @all-frames\n"), { ...script("C"), enabled: false }];
  const state = await syncScripts(library);
  assert.deepEqual(state.active, ["A", "B"]);
  assert.equal(mock.registered[0].js[1].code, library[0].source);
  assert.equal(mock.registered[1].allFrames, true);
  assert.ok(mock.calls.some(([name, config]) => name === "configureWorld" && config.messaging));
});

test("keeps registrations in library order", async () => {
  const [a, b, c] = [script("A"), script("B"), script("C")];
  await syncScripts([a, b]);
  await syncScripts([b, a]);
  assert.deepEqual(mock.registered.map(({ id }) => id), ["B", "A"]);
  mock.calls.length = 0;
  await syncScripts([b, a, c]);
  assert.deepEqual(mock.calls.filter(([name]) => name !== "configureWorld").map(call => call.join(":")),
    ["update:B", "update:A", "register:C"]);
});

test("pausing unregisters everything and missing access is reported", async () => {
  await syncScripts([script("A")]);
  assert.deepEqual((await syncScripts([script("A")], { paused: true })).active, []);
  assert.equal(mock.registered.length, 0);
  chrome.permissions.contains = async () => false;
  assert.match((await syncScripts([script("A")])).issues.A, /Site access/);
});

test("the prelude reports runs and exposes only granted APIs", async () => {
  await syncScripts([script("A", "// @grant GM_addStyle\n"), script("B", "// @grant GM.getValue\n")]);
  const sent = [];
  const context = (extra = {}) => {
    const sandbox = {
      chrome: { runtime: { sendMessage: async message => { sent.push(message); return { value: 41 }; } } },
      addEventListener() {},
      document: { createElement: () => ({}), head: { append() {} } },
      ...extra
    };
    sandbox.globalThis = sandbox;
    return vm.createContext(sandbox);
  };
  const b = context();
  vm.runInContext(mock.registered[1].js[0].code, b);
  assert.deepEqual({ ...sent[0] }, { id: "B", token: await tokenFor("B"), type: "run" });
  assert.equal(await b.GM.getValue("k", 0), 41);
  assert.equal(b.GM.setValue, undefined);
  assert.equal(b.GM_addStyle, undefined);
  const a = context();
  vm.runInContext(mock.registered[0].js[0].code, a);
  assert.equal(typeof a.GM_addStyle, "function");
  vm.runInContext("let report = 1; const send = 2; const value = 3;", a);
});

function sandbox(extra = {}) {
  const sent = [];
  const context = {
    chrome: { runtime: { sendMessage: async message => { sent.push(message); return context.reply?.(message) ?? {}; } } },
    addEventListener() {},
    document: { createElement: () => ({}), head: { append() {} } },
    location: { href: "https://a.com/page" },
    console, crypto, atob, btoa, TextDecoder, TextEncoder, Uint8Array, Response, Blob, URL,
    ...extra
  };
  context.globalThis = context;
  context.window = context;
  return { context: vm.createContext(context), sent };
}

test("registers @require files before the script, globs, page scripts and manual scripts", async () => {
  const withLib = { ...script("A", "// @require https://cdn.example/lib.js\n// @include https://b.com/*\n") };
  const page = script("P", "// @inject-into page\n// @grant unsafeWindow\n");
  const manual = script("M", "// @run-at context-menu\n");
  await chrome.storage.local.set({ "deps:A": { requires: [{ url: "https://cdn.example/lib.js", code: "lib();" }], resources: [] } });
  const state = await syncScripts([withLib, page, manual]);
  assert.deepEqual(state.active, ["A", "P"]);
  assert.deepEqual(state.manual, ["M"]);
  const [a, p] = mock.registered;
  assert.deepEqual(a.js.slice(1).map(({ code }) => code), ["lib();", withLib.source]);
  assert.deepEqual(a.includeGlobs, ["https://a.com/*", "https://b.com/*"]);
  assert.equal(p.world, "MAIN");
  assert.equal(p.worldId, undefined);
});

test("reports scripts whose dependencies weren't downloaded", async () => {
  const state = await syncScripts([script("A", "// @require https://cdn.example/lib.js\n")]);
  assert.match(state.issues.A, /Save the script again/);
  await chrome.storage.local.set({ "deps:B": { error: "Couldn’t download it." } });
  assert.match((await syncScripts([script("B")])).issues.B, /Couldn’t download/);
});

test("reports when Chrome blocks userscripts", async () => {
  chrome.userScripts.configureWorld = async () => { throw new Error("off"); };
  const state = await syncScripts([script("A")]);
  assert.equal(state.setupNeeded, true);
  assert.match(state.error, /Allow User Scripts/);
});

test("re-registers everything when a kept script drops its globs", async () => {
  await syncScripts([script("A", "// @include https://b.com/*\n")]);
  mock.calls.length = 0;
  await syncScripts([script("A")]);
  assert.deepEqual(mock.calls.filter(([name]) => name !== "configureWorld").map(call => call.join(":")), ["unregister:A", "register:A"]);
  assert.equal(mock.registered[0].includeGlobs, undefined);
});

test("regular expression includes wrap the body without moving line numbers", async () => {
  const original = script("A", "// @include /^https:\\/\\/a\\.com\\/yes/\n");
  await syncScripts([original]);
  const body = mock.registered[0].js.at(-1).code;
  const lines = original.source.split("\n");
  assert.equal(body.split("\n").indexOf(lines.at(-1)), lines.length - 1);
  for (const [href, ran] of [["https://a.com/yes", 1], ["https://b.com/yes", undefined]]) {
    const { context } = sandbox({ location: { href } });
    vm.runInContext(body.replace("window.x = 1;", "globalThis.ran = 1;"), context);
    assert.equal(context.ran, ran);
  }
  assert.match(body, /^\(function \(\) \{ "use strict"; if/);
});

test("the runtime provides GM_info, synchronous values, menus and resources", async () => {
  const source = userscript("x;", "// @version 2.1\n// @grant GM_getValue\n// @grant GM_setValue\n// @grant GM_registerMenuCommand\n// @grant GM_getResourceText\n// @resource note data:text/plain,hi%2C%20there\n");
  await chrome.storage.local.set({
    "values:A": { count: 3 },
    "deps:A": { requires: [], resources: [{ name: "note", url: "data:text/plain,hi%2C%20there", dataUrl: "data:text/plain,hi%2C%20there" }] }
  });
  await syncScripts([{ id: "A", name: "A", enabled: true, source }]);
  const { context, sent } = sandbox();
  vm.runInContext(mock.registered[0].js[0].code, context);
  assert.equal(context.GM_info.script.version, "2.1");
  assert.equal(context.GM_info.scriptHandler, "Tailorscript");
  assert.equal(context.GM_getValue("count"), 3);
  assert.equal(context.GM_getValue("missing", "fallback"), "fallback");
  context.GM_setValue("count", 4);
  assert.equal(context.GM_getValue("count"), 4);
  assert.deepEqual({ ...sent.at(-1) }, { id: "A", token: await tokenFor("A"), type: "value", op: "set", key: "count", value: 4 });
  assert.equal(context.GM_getResourceText("note"), "hi, there");
  let clicked = 0;
  const id = context.GM_registerMenuCommand("Do it", () => clicked++);
  assert.equal(sent.at(-1).caption, "Do it");
  context[Symbol.for("tailorscript.callback")]("menu", id);
  assert.equal(clicked, 1);
  assert.equal(context.GM_xmlhttpRequest, undefined);
});

test("GM.xmlHttpRequest decodes responses and calls handlers", async () => {
  await syncScripts([script("A", "// @grant GM.xmlHttpRequest\n// @grant GM_xmlhttpRequest\n")]);
  const { context, sent } = sandbox();
  context.reply = message => message.type === "xhr" ? { value: {
    status: 200, statusText: "OK", finalUrl: message.request.url, responseHeaders: "content-type: application/json",
    contentType: "application/json; charset=utf-8", body: Buffer.from('{"ok":true,"name":"é"}').toString("base64")
  } } : {};
  vm.runInContext(mock.registered[0].js[0].code, context);
  const response = await context.GM.xmlHttpRequest({ url: "/api", method: "post", data: "a=1", responseType: "json" });
  const request = sent.find(message => message.type === "xhr").request;
  assert.equal(request.url, "https://a.com/api");
  assert.equal(request.method, "POST");
  assert.deepEqual({ ...request.body }, { text: "a=1" });
  assert.deepEqual({ ...response.response }, { ok: true, name: "é" });
  const loaded = await new Promise(resolve => context.GM_xmlhttpRequest({ url: "https://a.com/x", onload: resolve }));
  assert.equal(loaded.responseText, '{"ok":true,"name":"é"}');
  context.reply = () => ({ error: "Add // @connect b.com to request this site." });
  const failed = await new Promise(resolve => context.GM_xmlhttpRequest({ url: "https://b.com/", onerror: resolve }));
  assert.match(failed.error, /@connect b\.com/);
});

test("gives each script's world messaging and forgets worlds that are no longer used", async () => {
  const page = script("P", "// @inject-into page\n");
  await syncScripts([script("A"), script("B"), page]);
  assert.deepEqual([...mock.worlds.keys()].sort(), ["", "A", "B"], "page-world scripts have no world of their own");
  assert.ok([...mock.worlds.values()].every(config => config.messaging));
  await syncScripts([script("B")]);
  assert.deepEqual([...mock.worlds.keys()].sort(), ["", "B"]);
  assert.ok(mock.calls.some(call => call.join(":") === "resetWorld:A"));
});

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import vm from "node:vm";
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
  assert.deepEqual({ ...sent[0] }, { id: "B", type: "run" });
  assert.equal(await b.GM.getValue("k", 0), 41);
  assert.equal(b.GM.setValue, undefined);
  assert.equal(b.GM_addStyle, undefined);
  const a = context();
  vm.runInContext(mock.registered[0].js[0].code, a);
  assert.equal(typeof a.GM_addStyle, "function");
  vm.runInContext("let report = 1; const send = 2; const value = 3;", a);
});

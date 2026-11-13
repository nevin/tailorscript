import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines } from "../src/manager/diff.js";
import { gmApis } from "../src/manager/gm-api.js";
import { addGrants, completeAt, diagnose, hoverAt, minimalChange, missingGrants, signatureAt } from "../src/manager/intellisense.js";
import { grantFamilies, parseSource } from "../src/shared/userscript.js";
import { userscript } from "./helpers/chrome.mjs";

const apply = (source, { from, to, insert }) => source.slice(0, from) + insert + source.slice(to);

test("diffLines marks added, removed and unchanged lines", () => {
  const rows = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne").map(row => row.kind[0] + row.text);
  assert.deepEqual(rows, ["sa", "rb", "aB", "sc", "sd", "ae"]);
  assert.ok(diffLines("same", "same").every(row => row.kind === "same"));
});

test("every grantable API has documentation", () => {
  for (const name of Object.values(grantFamilies).flat().filter(name => !name.startsWith("window."))) {
    assert.ok(gmApis[name]?.doc, name);
  }
});

test("completeAt suggests metadata keys, values and GM APIs", () => {
  const header = "// ==UserScript==\n// @name        T\n// @na";
  const keys = completeAt(header + "\n// ==/UserScript==\n", header.length);
  assert.equal(keys.kind, "metadata");
  assert.equal(keys.from, header.length - 2);
  assert.equal(keys.options.find(option => option.label === "namespace").apply, "namespace   ");
  const grant = "// ==UserScript==\n// @grant GM_get";
  const grants = completeAt(grant, grant.length);
  assert.equal(grants.from, grant.length - 6);
  assert.ok(grants.options.find(option => option.label === "GM_getValue").info.includes("Reads a value"));
  const runAt = "// ==UserScript==\n// @run-at doc";
  assert.ok(completeAt(runAt, runAt.length).options.some(option => option.label === "document-end"));
  const code = userscript("GM.xml");
  const api = completeAt(code, code.length);
  assert.equal(api.kind, "api");
  assert.equal(api.from, code.length - 6);
  assert.match(api.options.find(option => option.label === "GM.xmlHttpRequest").info, /@connect/);
  assert.equal(completeAt(userscript("const value"), userscript("const value").length), null);
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

test("diagnose reports problems with ranges and quick fixes", () => {
  const source = userscript('GM.getValue("k");\nGM_xmlhttpRequest({ url: "https://api.b.com/x" });\nlet = ;',
    "// @grant GM_addStyle\n// @grant GM_xmlhttpRequest\n// @grant GM_cookie\n// @matchs x\n");
  const found = diagnose(source, { runError: { line: 9, message: "boom" } });
  const by = text => found.find(item => item.message.includes(text));
  assert.equal(by("Unexpected token").severity, "error");
  assert.equal(source.slice(by("@matchs").from, by("@matchs").to), "matchs");
  assert.equal(by("GM_cookie").severity, "warning");
  assert.equal(by("granted but").severity, "hint");
  assert.equal(by("Last run failed").from, source.split("\n").slice(0, 8).join("\n").length + 1);

  const grant = by("needs @grant GM.getValue");
  assert.equal(source.slice(grant.from, grant.to), "GM.getValue");
  assert.deepEqual(parseSource(apply(source.replace("let = ;", ""), diagnose(source.replace("let = ;", "")).find(item => item.message.includes("GM.getValue")).actions[0].change)).grants,
    ["GM_addStyle", "GM_xmlhttpRequest", "GM_cookie", "GM.getValue"]);

  const connect = by("@connect api.b.com");
  assert.equal(source.slice(connect.from, connect.to), '"https://api.b.com/x"');
  assert.deepEqual(parseSource(apply(source.replace("let = ;", ""), connect.actions[0].change)).connects, ["api.b.com"]);
  assert.match(apply(source, by("granted but").actions[0].change), /^(?![\s\S]*GM_addStyle)/);

  assert.equal(diagnose(userscript('GM_xmlhttpRequest({ url: "https://a.com/api" });', "// @grant GM_xmlhttpRequest\n")).length, 0);
  const broken = diagnose("// ==UserScript==\n// @name T\n// @match nope\n// ==/UserScript==\nx;");
  assert.match(broken[0].message, /Invalid HTTP\(S\) match pattern/);
});

test("hoverAt documents metadata keys, grants and GM calls", () => {
  const source = userscript("GM.getValue('k'); GM_addStyle('a');", "// @grant GM_addStyle\n");
  assert.match(hoverAt(source, source.indexOf("@match") + 2).doc, /match pattern/);
  assert.match(hoverAt(source, source.indexOf("GM_addStyle") + 3).title, /^GM_addStyle\(css: string\)/);
  const call = hoverAt(source, source.indexOf("GM.getValue") + 5);
  assert.equal(source.slice(call.from, call.to), "GM.getValue");
  assert.equal(hoverAt(source, source.indexOf("('k')") + 2), null);
});

test("signatureAt tracks the active argument of GM calls", () => {
  const source = userscript('GM_setValue("a", { b: [1, 2], c: f(3, 4) }');
  const help = signatureAt(source, source.length);
  assert.equal(help.name, "GM_setValue");
  assert.equal(help.active, 1);
  const first = userscript("GM.openInTab(");
  assert.equal(signatureAt(first, first.length).active, 0);
  assert.equal(signatureAt(userscript("console.log("), userscript("console.log(").length), null);
  assert.equal(signatureAt(userscript("GM_setValue(1, 2);"), userscript("GM_setValue(1, 2);").length), null);
});

test("minimalChange describes the smallest edit", () => {
  assert.deepEqual(minimalChange("abcdef", "abXYef"), { from: 2, to: 4, insert: "XY" });
  assert.deepEqual(minimalChange("same", "same"), { from: 4, to: 4, insert: "" });
});

test("diagnose flags http downloads with a Use https fix", () => {
  const source = userscript("x;", "// @require     http://cdn.example/lib.js\n");
  const warning = diagnose(source).find(item => item.message.includes("unencrypted http"));
  assert.equal(source.slice(warning.from, warning.to), "http://cdn.example/lib.js");
  assert.match(apply(source, warning.actions[0].change), /@require {5}https:\/\/cdn\.example\/lib\.js/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { addMetadata, compareVersions, connectOrigins, matchesUrl, originsFor, parseSource, runsOn, updateTargets } from "../src/shared/userscript.js";
import { validate } from "../src/shared/validate.js";
import { userscript } from "./helpers/chrome.mjs";

const header = lines => `// ==UserScript==\n// @name T\n${lines.map(line => `// ${line}\n`).join("")}// ==/UserScript==\nx;`;

test("parseSource reads names, matches, timing, frames and tags", () => {
  const metadata = parseSource(userscript("x;", "// @run-at document-start\n// @all-frames\n// @tag work, tools\n// @tag work\n"));
  assert.equal(metadata.name, "Test");
  assert.deepEqual(metadata.matches, ["https://a.com/*"]);
  assert.equal(metadata.runAt, "document_start");
  assert.equal(metadata.allFrames, true);
  assert.deepEqual(metadata.tags, ["work", "tools"]);
  assert.equal(metadata.injectInto, "content");
});

test("parseSource reports unsupported grants instead of rejecting the script", () => {
  const metadata = parseSource(userscript("x;", "// @grant none\n// @grant GM_cookie\n// @grant GM_xmlhttpRequest\n"));
  assert.deepEqual(metadata.grants, ["GM_cookie", "GM_xmlhttpRequest"]);
  assert.deepEqual(metadata.unsupportedGrants, ["GM_cookie"]);
});

test("parseSource rejects metadata it can't honour", () => {
  assert.throws(() => parseSource(userscript("x;", "// @require ftp://cdn.example/x.js\n")), /@require needs an http/);
  assert.throws(() => parseSource(userscript("x;", "// @resource logo\n")), /@resource name/);
  assert.throws(() => parseSource(userscript("x;", "// @noframes\n// @all-frames\n")), /either @all-frames or @noframes/);
  assert.throws(() => parseSource(userscript("x;", "// @inject-into page\n// @grant GM.getValue\n")), /injected into the page/);
  assert.throws(() => parseSource(userscript("x;", "// @include /[/\n")), /Invalid regular expression/);
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

test("@include globs register as globs with the narrowest site access", () => {
  const metadata = parseSource(header(["@include https://*.example.com/docs/*", "@include http*://shop.example.tld/*"]));
  assert.deepEqual(metadata.targets.matches, ["https://*.example.com/*", "*://*/*"]);
  assert.deepEqual(metadata.targets.includeGlobs, ["https://*.example.com/docs/*", "http*://shop.example.*/*"]);
  assert.equal(metadata.targets.guard, null);
  const source = header(["@include https://*.example.com/docs/*", "@exclude *private*"]);
  assert.ok(runsOn(source, new URL("https://www.example.com/docs/a")));
  assert.ok(!runsOn(source, new URL("https://www.example.com/blog")));
  assert.ok(!runsOn(source, new URL("https://www.example.com/docs/private")));
  assert.deepEqual(parseSource(header(["@include *"])).targets.matches, ["*://*/*"]);
  assert.deepEqual(parseSource(header(["@match <all_urls>"])).origins, ["*://*/*"]);
});

test("@match and @include together run on either", () => {
  const source = header(["@match https://a.com/*", "@include https://b.com/x*"]);
  const { targets } = parseSource(source);
  assert.deepEqual(targets.includeGlobs, ["https://a.com/*", "https://b.com/x*"]);
  assert.ok(runsOn(source, new URL("https://a.com/anything")));
  assert.ok(runsOn(source, new URL("https://b.com/xyz")));
  assert.ok(!runsOn(source, new URL("https://b.com/y")));
});

test("regular expression rules fall back to a runtime check", () => {
  const source = header(["@include /^https:\\/\\/a\\.com\\/(x|y)/i", "@exclude /secret/"]);
  const { targets } = parseSource(source);
  assert.deepEqual(targets.matches, ["*://*/*"]);
  assert.equal(targets.guard.include.length, 1);
  assert.ok(runsOn(source, new URL("https://A.com/X")));
  assert.ok(!runsOn(source, new URL("https://a.com/z")));
  assert.ok(!runsOn(source, new URL("https://a.com/x/secret")));
  const excludeOnly = header(["@match https://a.com/*", "@exclude /\\?debug/"]);
  assert.equal(parseSource(excludeOnly).targets.guard.include, null);
  assert.ok(!runsOn(excludeOnly, new URL("https://a.com/?debug")));
});

test("reads dependencies, connections, update URLs and page injection", () => {
  const metadata = parseSource(header([
    "@match https://a.com/*", "@version 1.2.0", "@require https://cdn.example/lib.js", "@resource css https://cdn.example/a.css",
    "@connect api.example.com", "@connect self", "@connect localhost", "@downloadURL https://x.org/s.user.js", "@updateURL https://x.org/s.meta.js",
    "@sandbox raw", "@grant unsafeWindow"
  ]));
  assert.deepEqual(metadata.requires, ["https://cdn.example/lib.js"]);
  assert.deepEqual(metadata.resources, [{ name: "css", url: "https://cdn.example/a.css" }]);
  assert.deepEqual(metadata.origins, ["https://a.com/*", "*://api.example.com/*", "*://*.api.example.com/*", "*://localhost/*"]);
  assert.equal(metadata.updateUrl, "https://x.org/s.meta.js");
  assert.equal(metadata.downloadUrl, "https://x.org/s.user.js");
  assert.equal(metadata.injectInto, "page");
  assert.deepEqual(connectOrigins(["*"]), ["*://*/*"]);
  assert.equal(parseSource(header(["@match https://a.com/*", "@run-at context-menu"])).runAt, "manual");
});

test("compareVersions orders numeric parts numerically", () => {
  assert.equal(compareVersions("1.10", "1.9"), 1);
  assert.equal(compareVersions("2.0", "2"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("1.0b", "1.0a"), 1);
});

test("updateTargets and addMetadata keep the rest of the script", () => {
  const next = updateTargets(userscript("body();", "// @grant none\n"), "Renamed", ["https://b.com/*"]);
  const metadata = parseSource(next);
  assert.equal(metadata.name, "Renamed");
  assert.deepEqual(metadata.matches, ["https://b.com/*"]);
  assert.deepEqual(metadata.grants, ["none"]);
  assert.ok(next.endsWith("body();"));
  assert.ok(parseSource(updateTargets("", "New", ["https://c.com/*"]) + "\n;"));
  const excluded = addMetadata(addMetadata(userscript(), "exclude-match", "*://x.com/*"), "match", "https://b.com/*");
  assert.deepEqual(parseSource(excluded).excludeMatches, ["*://x.com/*"]);
  assert.match(excluded, /@match {7}https:\/\/a\.com\/\*\n\/\/ @match {7}https:\/\/b\.com\/\*\n/);
});

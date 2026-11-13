import assert from "node:assert/strict";
import { test } from "node:test";
import { mistakes, topics } from "../src/guide/content.js";
import { guideAnchor, highlight, topicFor } from "../src/guide/render.js";
import { gmApis } from "../src/manager/gm-api.js";
import { diagnose, hoverAt } from "../src/manager/intellisense.js";
import { grantFamilies } from "../src/shared/userscript.js";
import { validate } from "../src/shared/validate.js";

test("the guide explains every API a script can grant", () => {
  const covered = topics.flatMap(topic => topic.apis);
  for (const name of Object.values(grantFamilies).flat().filter(name => !name.startsWith("window."))) {
    assert.ok(covered.includes(name), `${name} is missing from the guide`);
  }
  for (const name of covered) assert.ok(gmApis[name], `${name} has no reference entry`);
  assert.equal(new Set(topics.map(topic => topic.id)).size, topics.length);
});

test("every guide example is a valid script the editor finds no problems in", () => {
  for (const topic of topics) {
    assert.doesNotThrow(() => validate(topic.example), topic.id);
    assert.deepEqual(diagnose(topic.example).map(problem => problem.message), [], topic.id);
    assert.ok(topic.apis.some(name => topic.example.includes(name)), `${topic.id} example uses none of its APIs`);
    assert.ok(topic.lead && topic.notes.length, topic.id);
  }
  for (const { problem, fix } of mistakes) assert.ok(problem && fix);
});

test("highlight keeps the source intact and marks header keys, APIs and strings", () => {
  const { example } = topicFor("values");
  const pieces = highlight(example);
  assert.equal(pieces.map(piece => piece.text).join(""), example);
  assert.ok(pieces.some(piece => piece.kind === "meta" && piece.text === "@grant"));
  assert.ok(pieces.some(piece => piece.kind === "api" && piece.text === "GM.getValue"));
  assert.ok(pieces.some(piece => piece.kind === "string" && piece.text === '"visits"'));
  assert.ok(pieces.some(piece => piece.kind === "keyword" && piece.text === "await"));
  assert.deepEqual(highlight('"https://a.com" // note'), [
    { text: '"https://a.com"', kind: "string" }, { text: " " }, { text: "// note", kind: "comment" }
  ]);
});

test("the editor's hover docs link to the guide", () => {
  assert.equal(topicFor("GM_setValue").id, "values");
  assert.equal(guideAnchor("GM.xmlHttpRequest"), "#GM.xmlHttpRequest");
  assert.equal(guideAnchor("@match"), "#meta-match");
  assert.equal(guideAnchor("document"), "");
  const source = "// ==UserScript==\n// @name T\n// @match https://a.com/*\n// @grant GM_addStyle\n// ==/UserScript==\nGM_addStyle('');";
  assert.equal(hoverAt(source, source.indexOf("GM_addStyle('") + 3).guide, "#GM_addStyle");
  assert.equal(hoverAt(source, source.indexOf("@match") + 2).guide, "#meta-match");
});

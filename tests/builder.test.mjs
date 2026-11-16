import assert from "node:assert/strict";
import { test } from "node:test";
import { actions, compile, defaultAction, describeStep, generateRecipe, readRecipe, stepProblem } from "../src/devtools/generator.js";
import { diagnose } from "../src/manager/intellisense.js";
import { parseSource } from "../src/shared/userscript.js";
import { validate } from "../src/shared/validate.js";

const step = (action, value, extra = {}) => ({ selector: "#cart", label: "Cart", action, value, all: false, expectedCount: 1, tag: "button", ...extra });
const recipe = (steps, extra = {}) => ({ version: 2, name: "Shop tweaks", page: "https://shop.example/sale", scope: "site", watch: false, steps, ...extra });

test("new steps start with the action that suits the element", () => {
  assert.equal(defaultAction("button"), "click");
  assert.equal(defaultAction("field"), "fill");
  assert.equal(defaultAction("overlay"), "hide");
  assert.equal(defaultAction("heading"), "hide");
});

test("compile turns each action into what the runner needs", () => {
  const [hide, click, fill, font, color, key, menu] = compile([
    step("hide"), step("click"), step("fill", "hello"), step("font", "500"), step("color", "red"), step("shortcut", " K "), step("menu", "Open cart")
  ]);
  assert.deepEqual(hide.style, ["display", "none"]);
  assert.equal(click.click, true);
  assert.equal(fill.fill, "hello");
  assert.deepEqual(font.style, ["font-size", "96px"]);
  assert.deepEqual(color.style, ["color", "#0f8f82"]);
  assert.equal(key.key, "k");
  assert.equal(menu.menu, "Open cart");
  assert.throws(() => compile([step("explode")]), /supported action/);
  assert.throws(() => compile([{ ...step("hide"), selector: " " }]), /selector/);
});

test("every action generates a valid script that reads back as the same recipe", () => {
  for (const action of Object.keys(actions)) {
    const value = { color: "#112233", background: "#112233", font: "20", shortcut: "k" }[action] ?? "Some text";
    const data = recipe([step(action, value)]);
    const source = generateRecipe(data);
    assert.doesNotThrow(() => validate(source), action);
    assert.deepEqual(diagnose(source).map(problem => problem.message), [], action);
    assert.deepEqual(readRecipe(source), data, action);
    assert.ok(describeStep(data.steps[0]).includes("Cart"), action);
  }
});

test("the script asks only for what its steps need", () => {
  const plain = generateRecipe(recipe([step("hide")]));
  assert.deepEqual(parseSource(plain).grants, ["none"]);
  assert.deepEqual(parseSource(plain).matches, ["https://shop.example/*"]);
  assert.ok(!plain.includes("runner.listen()") && !plain.includes("MutationObserver"));
  const rich = generateRecipe(recipe([step("menu", "Open cart"), step("shortcut", "c")], { scope: "path", watch: true }));
  assert.deepEqual(parseSource(rich).grants, ["GM_registerMenuCommand"]);
  assert.deepEqual(parseSource(rich).matches, ["https://shop.example/sale*"]);
  assert.match(rich, /GM_registerMenuCommand\("Open cart", \(\) => \{\n\s+if \(inScope\(\)\) runner\.trigger\(0\);/);
  assert.ok(rich.includes("runner.listen()") && rich.includes("MutationObserver"));
  assert.match(rich, /location\.pathname === "\/sale"/);
});

test("unfinished steps are left out but kept in the recipe", () => {
  assert.match(stepProblem(step("shortcut", " ")), /key/);
  assert.match(stepProblem(step("menu", "")), /caption/);
  assert.equal(stepProblem(step("fill", "")), "");
  const data = recipe([step("hide"), step("shortcut", "")]);
  const source = generateRecipe(data);
  assert.ok(!source.includes("runner.listen()"));
  assert.equal(readRecipe(source).steps.length, 2);
});

test("a hand-edited script is no longer a recipe", () => {
  const source = generateRecipe(recipe([step("hide")]));
  assert.equal(readRecipe(source.replace("display", "visibility")), null);
  assert.equal(readRecipe("// ==UserScript==\n// @name A\n// ==/UserScript=="), null);
  assert.throws(() => generateRecipe(recipe([step("hide")], { page: "chrome://extensions" })), /HTTP or HTTPS/);
});

test("recipes from the first builder open upgraded", () => {
  const old = { version: 1, name: "Old", page: "https://shop.example/sale", scope: "path", watch: false,
    steps: [{ selector: "h1", label: "Heading", action: "font", value: "20", all: false, expectedCount: 1, tag: "h1" }, { selector: "p", action: "explode" }] };
  const source = `// ==UserScript==\n// @name Old\n// ==/UserScript==\n// Tailorscript recipe: ${JSON.stringify(old)}\n(() => {})();\n`;
  const upgraded = readRecipe(source);
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgraded.scope, "path");
  assert.deepEqual(upgraded.steps.map(step => step.action), ["font"]);
  assert.match(generateRecipe(upgraded), /"font-size",\n\s+"20px"/);
});

test("steps found by their text keep the text in the script", () => {
  const data = recipe([step("click", undefined, { selector: "#cookie button", text: "Accept all" })]);
  const [compiled] = compile(data.steps);
  assert.equal(compiled.text, "Accept all");
  const source = generateRecipe(data);
  assert.match(source, /"text": "Accept all"/);
  assert.equal(readRecipe(source).steps[0].text, "Accept all");
  assert.ok(!("text" in compile([step("hide")])[0]));
});

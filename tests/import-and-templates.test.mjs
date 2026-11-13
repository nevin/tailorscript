import assert from "node:assert/strict";
import { test } from "node:test";
import { updateTargets } from "../src/shared/userscript.js";
import { validate } from "../src/shared/validate.js";
import { decodeImport } from "../src/manager/backup-file.js";
import { templates } from "../src/manager/templates.js";
import { userscript } from "./helpers/chrome.mjs";

test("every template is a valid userscript", () => {
  for (const template of templates) {
    const source = template.source || updateTargets("", "Blank", ["https://example.com/*"]) + "\n;";
    assert.ok(validate(source).matches.length, template.name);
  }
});

test("decodeImport accepts backups and single .user.js files", () => {
  const backup = JSON.stringify({ version: 1, scripts: [{ source: userscript(), history: [{ source: "old", savedAt: 1, label: "L" }, { bad: 1 }] }] });
  const [entry] = decodeImport(backup, true);
  assert.equal(entry.name, "Test");
  assert.deepEqual(entry.history, [{ source: "old", savedAt: 1, label: "L" }]);
  assert.equal(decodeImport(userscript(), false).length, 1);
  assert.throws(() => decodeImport(JSON.stringify({ version: 2, scripts: [] }), true), /version 1/);
});

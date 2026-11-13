import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateExtension } from "../scripts/lib/manifest.mjs";
import { srcDir } from "../scripts/lib/project.mjs";
import { createZip } from "../scripts/lib/zip.mjs";

const hasUnzip = (() => {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("createZip is deterministic and readable by unzip", { skip: !hasUnzip && "unzip is not installed" }, async () => {
  const entries = [
    { name: "b/data.txt", data: Buffer.from("hello ".repeat(200)) },
    { name: "a.json", data: Buffer.from('{"é":1}') },
    { name: "tiny", data: Buffer.from("x") }
  ];
  const archive = createZip(entries);
  assert.ok(createZip([...entries].reverse()).equals(archive));
  const dir = await mkdtemp(path.join(tmpdir(), "zip-test-"));
  try {
    const file = path.join(dir, "test.zip");
    await writeFile(file, archive);
    execFileSync("unzip", ["-tq", file]);
    assert.equal(execFileSync("unzip", ["-p", file, "b/data.txt"]).toString(), "hello ".repeat(200));
    assert.equal(execFileSync("unzip", ["-p", file, "a.json"]).toString(), '{"é":1}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateExtension accepts src and reports broken extensions", async () => {
  assert.deepEqual((await validateExtension(srcDir)).errors, []);
  const dir = await mkdtemp(path.join(tmpdir(), "extension-test-"));
  try {
    await cp(srcDir, dir, { recursive: true });
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: "1.02", short_name: "A very long short name" }));
    await rm(path.join(dir, "popup/popup.css"));
    await writeFile(path.join(dir, "shared/remote.js"), 'import "https://cdn.example.com/lib.js";');
    const { errors } = await validateExtension(dir, { version: "9.9.9" });
    const expected = [/version "1.02"/, /short_name/, /does not match package.json/, /popup\.css/, /remote code/];
    for (const pattern of expected) assert.ok(errors.some(error => pattern.test(error)), `${pattern} in ${errors.join(" | ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

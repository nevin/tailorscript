import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { listFiles, srcDir } from "../scripts/lib/project.mjs";

test("every message the extension asks for exists, and every message is used", async () => {
  const messages = JSON.parse(await readFile(path.join(srcDir, "_locales/en/messages.json"), "utf8"));
  const used = new Set();
  for (const file of await listFiles(srcDir)) {
    if (!/\.(html|js|json)$/.test(file) || file.includes("_locales") || file.includes("vendor")) continue;
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/data-i18n(?:-[\w-]+)?="(\w+)"|\bt\("(\w+)"|__MSG_(\w+)__/g)) used.add(match[1] ?? match[2] ?? match[3]);
  }
  for (const key of used) assert.ok(messages[key]?.message, `${key} is used but missing from messages.json`);
  for (const key of Object.keys(messages)) assert.ok(used.has(key), `${key} is in messages.json but never used`);
  for (const [key, { message, placeholders = {} }] of Object.entries(messages)) {
    for (const [, name] of message.matchAll(/\$(\w+)\$/g)) assert.ok(placeholders[name.toLowerCase()], `${key} uses $${name}$ without a placeholder`);
  }
});

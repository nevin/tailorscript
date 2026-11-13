import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const srcDir = path.join(root, "src");
export const distDir = path.join(root, "dist");
export const releaseDir = path.join(root, "release");

// Files that never belong in the shipped extension.
const ignored = [/^\./, /\.map$/, /^Thumbs\.db$/];

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function packageInfo() {
  return readJson(path.join(root, "package.json"));
}

export async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.some(pattern => pattern.test(entry.name))) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

export function relative(file, from = root) {
  return path.relative(from, file).split(path.sep).join("/");
}

export function fail(message) {
  console.error(`\u001b[31m✖\u001b[0m ${message}`);
  process.exitCode = 1;
}

export function done(message) {
  console.log(`\u001b[32m✔\u001b[0m ${message}`);
}

// Builds dist/ and zips it into release/ for the Chrome Web Store, with a SHA-256 checksum alongside.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "./build.mjs";
import { createZip } from "./lib/zip.mjs";
import { distDir, done, fail, packageInfo, relative, releaseDir } from "./lib/project.mjs";

export async function packageExtension() {
  const { name } = await packageInfo();
  const { version, files } = await build();
  const entries = await Promise.all(files.map(async file => ({ name: relative(file, distDir), data: await readFile(file) })));
  const archive = createZip(entries);
  await mkdir(releaseDir, { recursive: true });
  const zipPath = path.join(releaseDir, `${name}-${version}.zip`);
  const checksum = createHash("sha256").update(archive).digest("hex");
  await writeFile(zipPath, archive);
  await writeFile(`${zipPath}.sha256`, `${checksum}  ${path.basename(zipPath)}\n`);
  return { zipPath, checksum, bytes: archive.length, count: entries.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { zipPath, checksum, bytes, count } = await packageExtension();
    done(`Packaged ${count} files into ${relative(zipPath)} (${(bytes / 1024).toFixed(1)} KB)`);
    console.log(`  sha256 ${checksum}`);
  } catch (error) {
    fail(error.message);
  }
}

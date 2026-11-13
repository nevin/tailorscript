// Copies src/ into a clean dist/, stamps the package.json version and validates the result.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateExtension } from "./lib/manifest.mjs";
import { distDir, done, fail, listFiles, packageInfo, readJson, relative, srcDir } from "./lib/project.mjs";

export async function build() {
  const { version } = await packageInfo();
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  for (const file of await listFiles(srcDir)) {
    const target = path.join(distDir, relative(file, srcDir));
    await mkdir(path.dirname(target), { recursive: true });
    await cp(file, target);
  }
  const manifest = await readJson(path.join(distDir, "manifest.json"));
  manifest.version = version;
  await writeFile(path.join(distDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const { errors } = await validateExtension(distDir, { version });
  if (errors.length) throw new Error(`Build output is invalid:\n  ${errors.join("\n  ")}`);
  return { version, files: await listFiles(distDir) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { version, files } = await build();
    done(`Built ${files.length} files for version ${version} into ${relative(distDir)}/`);
  } catch (error) {
    fail(error.message);
  }
}

// Copies src/ into a clean dist/, stamps the package.json version and validates the result.
import { appendFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateExtension } from "./lib/manifest.mjs";
import { distDir, done, fail, listFiles, packageInfo, readJson, relative, srcDir } from "./lib/project.mjs";

// Runs inside the extension's service worker in dev builds. Polling also keeps the worker awake while developing.
/* global chrome */
function watchForRebuilds(port) {
  let seen;
  setInterval(async () => {
    try {
      const stamp = await (await fetch(`http://localhost:${port}/stamp`, { cache: "no-store" })).text();
      if (seen && stamp !== seen) chrome.runtime.reload();
      seen = stamp;
    } catch {
      // The dev server isn't running; keep the current build.
    }
  }, 1000);
}

// devReloadPort is for npm run dev only: it adds a watcher to dist/ that reloads the extension after each rebuild.
// Packaging never passes it, so the watcher can't reach a release.
export async function build({ devReloadPort } = {}) {
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
  if (devReloadPort) {
    const worker = path.join(distDir, manifest.background.service_worker);
    await appendFile(worker, `\n// Added by npm run dev: reload when the dev server reports a new build.\n(${watchForRebuilds})(${devReloadPort});\n`);
  }
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

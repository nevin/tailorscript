// Runs from `npm version`: copies the new package.json version into src/manifest.json.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { done, packageInfo, readJson, srcDir } from "./lib/project.mjs";

const { version } = await packageInfo();
const file = path.join(srcDir, "manifest.json");
const manifest = await readJson(file);
manifest.version = version;
await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
done(`src/manifest.json is now version ${version}.`);

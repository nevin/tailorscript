// Development loop: builds dist/, rebuilds whenever src/ changes, and reloads the unpacked extension in Chrome.
//   npm run dev   then load dist/ once from chrome://extensions (Developer mode → Load unpacked)
// The reload watcher exists only in this dev build. Run npm run build before sharing dist/.
import { watch } from "node:fs";
import { createServer } from "node:http";
import { build } from "./build.mjs";
import { done, fail, relative, distDir, srcDir } from "./lib/project.mjs";

const port = Number(process.env.PORT) || 8768;
let stamp = "";
let building = false;
let queued = false;

async function rebuild() {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  try {
    const { files } = await build({ devReloadPort: port });
    stamp = String(Date.now());
    done(`Built ${files.length} files into ${relative(distDir)}/ at ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    // Keep the last good build loaded and wait for the next save.
    fail(error.message);
    process.exitCode = 0;
  }
  building = false;
  if (queued) {
    queued = false;
    await rebuild();
  }
}

createServer((request, response) => {
  response.writeHead(200, { "access-control-allow-origin": "*", "cache-control": "no-store" });
  response.end(stamp);
}).listen(port);

await rebuild();
let timer;
watch(srcDir, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(rebuild, 150);
});
console.log(`Watching ${relative(srcDir)}/ — the extension reloads after each rebuild.`);

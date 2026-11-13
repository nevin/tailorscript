// Serves src/ with a mocked chrome API so the extension's pages can be opened and debugged in any browser:
//   npm run harness   then open http://localhost:8767/manager/index.html
// Pages are rewritten as they're served, so edits in src/ show on reload. Nothing here ships in the extension.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { root, srcDir } from "./lib/project.mjs";

const port = Number(process.env.PORT) || 8767;
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml" };
const pages = {
  "/manager/index.html": "./manager.js",
  "/install/install.html": "./install.js",
  "/popup/popup.html": "./popup.js",
  "/guide/guide.html": "./guide.js"
};
// The popup asks for the active tab; the harness reports the URL after # (or a default) as that tab.
const popupTab = `<script>chrome.tabs.query = async q => q.active ? [{ id: 1, url: location.hash.slice(1) || "https://example.com/" }] : [];</script>`;
const sample = `// ==UserScript==
// @name         Harness sample
// @namespace    https://example.org/scripts
// @version      1.0.0
// @description  A script to try the install page with.
// @match        https://example.com/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @updateURL    http://localhost:${port}/sample.user.js
// ==/UserScript==

GM_addStyle("h1 { color: rebeccapurple; }");
GM_registerMenuCommand("Say hello", () => alert("Hello"));
`;

async function respond(pathname) {
  if (pathname === "/mock.js") return { type: types[".js"], body: await readFile(path.join(root, "scripts/harness/mock.js")) };
  if (pathname === "/sample.user.js") return { type: types[".js"], body: sample };
  const file = path.join(srcDir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(srcDir)) return null;
  let body = await readFile(file);
  if (pages[pathname]) {
    const entry = pages[pathname];
    body = String(body).replace(`<script type="module" src="${entry.slice(2)}"></script>`,
      `<script src="/mock.js"></script>${pathname.startsWith("/popup") ? popupTab : ""}` +
      `<script type="module">import "../background/service-worker.js"; await import("${entry}");</script>`);
  }
  return { type: types[path.extname(file)] ?? "application/octet-stream", body };
}

createServer(async (request, response) => {
  const { pathname } = new URL(request.url, "http://localhost");
  if (pathname === "/") {
    response.writeHead(302, { location: "/manager/index.html" }).end();
    return;
  }
  try {
    const result = await respond(pathname);
    if (!result) throw new Error("outside src");
    response.writeHead(200, { "content-type": result.type, "cache-control": "no-store" });
    response.end(result.body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, () => console.log(`Harness on http://localhost:${port}/manager/index.html (popup: /popup/popup.html, install: /install/install.html#http://localhost:${port}/sample.user.js)`));

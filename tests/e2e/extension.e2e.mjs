// Loads the built extension in a real Chrome and checks the paths the mocked tests can't reach:
// registration and injection, the GM bridge, Run now, menu commands, the .user.js install redirect and the editor.
//   npm run test:e2e      (once: npx puppeteer browsers install chrome)
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import puppeteer from "puppeteer";
import { build } from "../../scripts/build.mjs";
import { distDir } from "../../scripts/lib/project.mjs";

let browser;
let server;
let port;
let extensionDir;
let extensionId;
let manager;

const header = (name, lines) => `// ==UserScript==\n// @name ${name}\n${lines.map(line => `// @${line}`).join("\n")}\n// ==/UserScript==\n`;
const site = () => `http://localhost:${port}`;

// Sends a message the way the manager page does and returns the registration state.
async function send(message) {
  const response = await manager.evaluate(body => chrome.runtime.sendMessage(body), message);
  assert.ok(response?.ok, response?.error);
  return response.state;
}

async function openPage(pathname = "/page.html") {
  const page = await browser.newPage();
  await page.goto(site() + pathname, { waitUntil: "load" });
  return page;
}

const attribute = (page, name) => page.waitForFunction(key => document.documentElement.getAttribute(key), { timeout: 5000 }, name)
  .then(handle => handle.jsonValue());

before(async () => {
  await build();
  // The real extension asks for site access when a script is saved. A test can't answer Chrome's prompt,
  // so this copy is granted the two local test hosts up front; nothing else differs from dist/.
  extensionDir = await mkdtemp(path.join(tmpdir(), "tailorscript-e2e-"));
  await cp(distDir, extensionDir, { recursive: true });
  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://localhost/*", "http://127.0.0.1/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));

  server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    if (pathname === "/api") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ host: request.headers.host }));
    } else if (pathname === "/hello.user.js") {
      response.writeHead(200, { "content-type": "text/javascript" })
        .end(header("Hello install", ["match http://localhost/*", "version 1.2.0", "grant none"]) + 'document.documentElement.setAttribute("data-installed", "yes");');
    } else {
      response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Test page</title><h1>Test page</h1>");
    }
  });
  await new Promise(resolve => server.listen(0, resolve));
  port = server.address().port;

  browser = await puppeteer.launch({
    headless: true,
    enableExtensions: [extensionDir],
    // GitHub's Linux runners don't allow Chrome's sandbox for unprivileged users.
    args: process.env.CI ? ["--no-sandbox"] : []
  });
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("background/service-worker.js"));
  extensionId = new URL(worker.url()).host;

  // Chrome keeps userScripts off until the user turns on Allow User Scripts for the extension.
  const settings = await browser.newPage();
  await settings.goto("chrome://extensions");
  await settings.evaluate(id => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true }), extensionId);
  await settings.close();

  manager = await browser.newPage();
  await manager.goto(`chrome-extension://${extensionId}/manager/index.html`);
  await manager.waitForSelector(".cm-content");
});

after(async () => {
  await browser?.close();
  server?.close();
  if (extensionDir) await rm(extensionDir, { recursive: true, force: true });
});

test("a saved script is registered and runs on matching pages with its GM APIs", async () => {
  const source = header("Bridge", [
    "match http://localhost/*", "grant GM_addStyle", "grant GM.setValue", "grant GM.getValue", "grant GM.xmlHttpRequest",
    "grant GM_registerMenuCommand", "connect 127.0.0.1"
  ]) + `
GM_addStyle("h1 { color: rgb(1, 2, 3); }");
GM_registerMenuCommand("Mark", () => document.documentElement.setAttribute("data-menu", "clicked"));
(async () => {
  await GM.setValue("visits", (await GM.getValue("visits", 0)) + 1);
  const response = await GM.xmlHttpRequest({ url: "http://127.0.0.1:${port}/api", responseType: "json" });
  document.documentElement.setAttribute("data-bridge", JSON.stringify({ visits: await GM.getValue("visits"), host: response.response.host }));
})().catch(error => document.documentElement.setAttribute("data-bridge", JSON.stringify({ error: error.message })));`;
  const state = await send({ type: "save", id: "bridge", script: { source, enabled: true }, expected: null });
  assert.deepEqual(state.issues, {});
  assert.deepEqual(state.active, ["bridge"]);

  const page = await openPage();
  assert.deepEqual(JSON.parse(await attribute(page, "data-bridge")), { visits: 1, host: `127.0.0.1:${port}` });
  assert.equal(await page.$eval("h1", heading => getComputedStyle(heading).color), "rgb(1, 2, 3)");
  assert.equal(await page.evaluate(() => typeof GM_addStyle), "undefined", "GM APIs stay out of the page's own world");

  // The popup's menu command button reaches back into the script's world.
  const tabId = await manager.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, "http://localhost/*");
  const { tabRuns } = await manager.evaluate(() => chrome.storage.session.get("tabRuns"));
  const [command] = tabRuns[tabId].menus.bridge;
  assert.equal(command.caption, "Mark");
  await send({ type: "menu-run", id: "bridge", tabId, commandId: command.commandId });
  assert.equal(await attribute(page, "data-menu"), "clicked");
  await page.close();
});

test("requests to hosts without @connect are refused", async () => {
  const source = header("Blocked", ["match http://localhost/*", "grant GM.xmlHttpRequest"]) + `
GM.xmlHttpRequest({ url: "http://127.0.0.1:${port}/api" })
  .then(() => "allowed", error => error.message)
  .then(result => document.documentElement.setAttribute("data-blocked", result));`;
  await send({ type: "save", id: "blocked", script: { source, enabled: true }, expected: null });
  const page = await openPage();
  assert.match(await attribute(page, "data-blocked"), /@connect 127\.0\.0\.1/);
  await page.close();
});

test("Run now injects a script that isn't enabled", async () => {
  const source = header("Manual", ["match http://localhost/*", "run-at context-menu", "grant none"]) +
    'document.documentElement.setAttribute("data-manual", "ran");';
  await send({ type: "save", id: "manual", script: { source, enabled: false }, expected: null });
  const page = await openPage();
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-manual")), null);
  const tabId = await manager.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, "http://localhost/*");
  await send({ type: "run-now", id: "manual", tabId });
  assert.equal(await attribute(page, "data-manual"), "ran");
  await page.close();
});

test(".user.js links open the install page, and installing adds the script", async () => {
  const page = await browser.newPage();
  await page.goto(`${site()}/hello.user.js`);
  assert.equal(page.url(), `chrome-extension://${extensionId}/install/install.html#${site()}/hello.user.js`);
  await page.waitForFunction(() => document.title.includes("Hello install"));
  await page.click("#enable");
  await page.click("#install");
  await page.waitForFunction(() => document.querySelector("#done-text")?.textContent.includes("Installed"));
  const scripts = await manager.evaluate(async () => {
    const { scriptOrder } = await chrome.storage.local.get("scriptOrder");
    return Object.values(await chrome.storage.local.get(scriptOrder.map(id => `script:${id}`)));
  });
  const installed = scripts.find(script => script.name === "Hello install");
  assert.equal(installed.installUrl, `${site()}/hello.user.js`);
  assert.equal(installed.enabled, true);
  await page.close();

  const target = await openPage();
  assert.equal(await attribute(target, "data-installed"), "yes");
  await target.close();
});

test("the editor closes brackets, completes GM APIs and shows parameter hints", async () => {
  await manager.bringToFront();
  await manager.click("#new");
  await manager.waitForSelector("#review[open] .template-list button");
  await manager.click("#review .template-list button");
  await manager.click(".cm-content");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await manager.keyboard.down(modifier);
  await manager.keyboard.press("End");
  await manager.keyboard.up(modifier);
  await manager.keyboard.press("Enter");
  await manager.keyboard.type("console.log(");
  const text = () => manager.evaluate(() => [...document.querySelectorAll(".cm-line")].map(line => line.textContent).join("\n"));
  assert.match((await text()).trimEnd(), /console\.log\(\)$/, "typing ( adds the closing bracket");

  await manager.keyboard.press("ArrowRight");
  await manager.keyboard.press("Enter");
  await manager.keyboard.type("GM_addSt");
  await manager.waitForSelector(".cm-tooltip-autocomplete [aria-selected]");
  // CodeMirror ignores Enter for a moment after the list opens, so a stray keypress can't pick an option.
  await new Promise(resolve => setTimeout(resolve, 200));
  await manager.keyboard.press("Enter");
  assert.match((await text()).trimEnd(), /GM_addStyle$/);
  await manager.keyboard.type("(");
  await manager.waitForSelector(".cm-signature", { timeout: 5000 });
  assert.match(await manager.$eval(".cm-signature .cm-active-param", node => node.textContent), /^css/);
});

test("the scripting guide opens and hands an example to the manager", async () => {
  // Discard the unsaved script from the editor test, so the manager can load the example without asking.
  manager.once("dialog", dialog => dialog.accept());
  await manager.reload();
  await manager.waitForSelector(".cm-content");
  const guide = await browser.newPage();
  await guide.goto(`chrome-extension://${extensionId}/guide/guide.html#GM_setValue`);
  await guide.waitForSelector("#values.found");
  assert.equal(await guide.$$eval(".topic", topics => topics.length), 10);
  await guide.click("#values .example-actions .primary");
  await manager.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Example loaded"));
  const text = await manager.evaluate(() => [...document.querySelectorAll(".cm-line")].map(line => line.textContent).join("\n"));
  assert.match(text, /@name\s+Count my visits/);
  assert.match(text, /GM\.setValue\("visits"/);
  await guide.close();
});

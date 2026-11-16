// Opens the visual builder inside a real DevTools window, which the other end-to-end tests stand in for with a fake
// chrome.devtools. Covers what only real DevTools has: the panel tab itself, the DevTools theme and $0.
// DevTools needs a visible browser window, so on Linux run it under a virtual display:
//   npm run test:devtools        (CI: xvfb-run -a npm run test:devtools)
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
let extensionDir;

before(async () => {
  await build();
  extensionDir = await mkdtemp(path.join(tmpdir(), "tailorscript-devtools-"));
  await cp(distDir, extensionDir, { recursive: true });
  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://localhost/*", "http://127.0.0.1/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><title>Shop</title><h1>Autumn sale</h1><div id=\"cookie\">Cookies <button>Accept all</button></div>");
  });
  await new Promise(resolve => server.listen(0, resolve));
  browser = await puppeteer.launch({
    headless: false,
    devtools: true,
    enableExtensions: [extensionDir],
    defaultViewport: null,
    args: ["--window-size=1400,1000", ...(process.env.CI ? ["--no-sandbox"] : [])]
  });
  // Chrome keeps userScripts off until Allow User Scripts is turned on for the extension.
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("background/service-worker.js"));
  const settings = await browser.newPage();
  await settings.goto("chrome://extensions");
  await settings.evaluate(id => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true }), new URL(worker.url()).host);
  await settings.close();
});

after(async () => {
  await browser?.close();
  server?.close();
  if (extensionDir) await rm(extensionDir, { recursive: true, force: true });
});

test("the builder runs as a DevTools tab with the page's real selection", async () => {
  // One tab, so there is one DevTools window and it belongs to the test page (installing opens a welcome tab).
  await new Promise(resolve => setTimeout(resolve, 1000));
  for (const open of await browser.pages()) await open.close();
  // DevTools windows of the closed tabs can linger for a moment, so only a window opened after this point counts.
  const earlier = new Set(browser.targets().filter(target => target.url().startsWith("devtools://")));
  const page = await browser.newPage();
  await page.goto(`http://localhost:${server.address().port}/sale`);
  const devtoolsTarget = await browser.waitForTarget(target => target.url().startsWith("devtools://") && !earlier.has(target), { timeout: 15000 });
  const devtools = await devtoolsTarget.asPage();
  // The panel's tab can sit in DevTools' overflow menu, so it is opened through DevTools' own views instead of a
  // click. This uses DevTools internals, which may change between Chrome versions. DevTools may still be starting,
  // so this retries until its views are ready.
  const showPanel = async () => {
    const ui = await import("./ui/legacy/legacy.js");
    const id = [...ui.ViewManager.ViewManager.instance().views.keys()].find(key => key.endsWith("Tailorscript"));
    if (!id) return false;
    await ui.InspectorView.InspectorView.instance().showPanel(id);
    return true;
  };
  const opening = Date.now() + 20000;
  let shown = false;
  while (!shown && Date.now() < opening) {
    shown = await devtools.evaluate(showPanel).catch(() => false);
    if (!shown) await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.ok(shown, "the Tailorscript tab exists in DevTools");
  const deadline = Date.now() + 15000;
  let panel;
  while (!panel && Date.now() < deadline) {
    panel = devtools.frames().find(frame => frame.url().endsWith("/devtools/panel.html"));
    if (!panel) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(panel, "the Tailorscript panel loaded inside DevTools");
  await panel.waitForSelector("#elements .item", { timeout: 15000 });

  const scheme = await panel.evaluate(() => document.documentElement.style.colorScheme);
  const theme = await panel.evaluate(() => chrome.devtools.panels.themeName);
  assert.equal(scheme, theme === "dark" ? "dark" : "light", "the panel follows the DevTools theme");

  // inspect() is part of DevTools' console API, which inspectedWindow.eval shares; it sets $0 like a click in Elements.
  await panel.evaluate(() => new Promise(resolve => chrome.devtools.inspectedWindow.eval("inspect(document.querySelector('h1'))", resolve)));
  await panel.$eval("#selected", button => button.click());
  await panel.waitForSelector("#steps .step", { timeout: 5000, polling: 100 });
  assert.match(await panel.$eval("#steps .step strong", node => node.textContent), /Autumn sale/);
  await panel.$eval("#test", button => button.click());
  await panel.waitForFunction(() => document.querySelector(".test-result")?.textContent.includes("Changed 1"), { timeout: 5000, polling: 100 });
  assert.equal(await page.$eval("h1", node => getComputedStyle(node).display), "none");
  await panel.$eval("#undo", button => button.click());

  // Saving and turning the recipe on from the panel. This copy already has access to the test site, so Chrome
  // shows no permission prompt; a test can't answer one.
  assert.ok(await panel.evaluate(() => typeof chrome.permissions?.request === "function"), "DevTools panels can ask for site access");
  await panel.$eval("#save-recipe", button => button.click());
  await panel.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Saved"), { timeout: 5000, polling: 100 });
  await panel.$eval("#enabled", input => input.click());
  await panel.waitForFunction(() => document.querySelector("#status").textContent.startsWith("On."), { timeout: 5000, polling: 100 });
  // DevTools and the page share a window, so whichever is hidden doesn't paint; waits poll on a timer instead.
  await page.reload();
  await page.waitForFunction(() => getComputedStyle(document.querySelector("h1")).display === "none", { timeout: 5000, polling: 100 });
});

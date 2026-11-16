// Loads the built extension in a real Chrome and checks the paths the mocked tests can't reach:
// registration and injection, the GM bridge, Run now, menu commands, the .user.js install redirect and the editor.
//   npm run test:e2e      (once: npx puppeteer browsers install chrome)
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import puppeteer from "puppeteer";
import { build } from "../../scripts/build.mjs";
import { distDir } from "../../scripts/lib/project.mjs";
import { zip } from "../helpers/zip.mjs";
import { topics } from "../../src/guide/content.js";

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
  assert.equal(await guide.$$eval(".topic", nodes => nodes.length), topics.length);
  await guide.click("#values .example-actions .primary");
  await manager.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Example loaded"));
  const text = await manager.evaluate(() => [...document.querySelectorAll(".cm-line")].map(line => line.textContent).join("\n"));
  assert.match(text, /@name\s+Count my visits/);
  assert.match(text, /GM\.setValue\("visits"/);
  await guide.close();
});

test("toolbar popup can change settings through the worker", async () => {
  const page = await openPage();
  await page.bringToFront();
  await manager.evaluate(() => chrome.action.openPopup());
  const target = await browser.waitForTarget(item => item.url().endsWith("/popup/popup.html"), { timeout: 5000 });
  const popup = await target.asPage();
  try {
    await popup.waitForFunction(() => document.querySelector("#page").textContent.startsWith("localhost:"));
    await popup.click("#paused");
    await popup.waitForFunction(() => document.querySelector("#notice").textContent.startsWith("Scripts are paused."));
    await popup.click("#paused");
    await popup.waitForFunction(() => document.querySelector("#notice").textContent.startsWith("Scripts resumed."));
  } finally {
    await popup.close();
    await page.close();
  }
});

test("visual recipe can be previewed, saved, reopened and applied after reload", async () => {
  const page = await openPage();
  const panel = await browser.newPage();
  const session = await page.createCDPSession();
  // Drive the panel in Chrome and relay inspectedWindow.eval into the fixture tab.
  await panel.exposeFunction("inspectFixture", async expression => {
    const result = await session.send("Runtime.evaluate", { expression, returnByValue: true });
    return { value: result.result.value, error: Boolean(result.exceptionDetails) };
  });
  await panel.evaluateOnNewDocument(() => {
    chrome.devtools = {
      inspectedWindow: {
        eval(expression, callback) {
          globalThis.inspectFixture(expression).then(({ value, error }) => callback(value, error));
        }
      },
      network: { onNavigated: { addListener() {} } }
    };
  });
  try {
    await panel.goto(`chrome-extension://${extensionId}/devtools/panel.html`);
    await panel.type("#search", "Test page");
    await panel.waitForFunction(() => [...document.querySelectorAll("#elements .item-label")]
      .some(element => element.textContent === "Test page"));
    assert.match(await panel.$eval("#elements h3", heading => heading.textContent), /^Headings · 1$/);
    await panel.evaluate(() => {
      const heading = [...document.querySelectorAll("#elements .item")]
        .find(row => row.querySelector(".item-label").textContent === "Test page");
      heading.querySelector(".add").click();
    });
    await panel.waitForFunction(async () => {
      const key = "builderDraft:" + [...document.querySelectorAll("#site")].map(element => "http://" + element.textContent)[0];
      return Boolean((await chrome.storage.local.get(key))[key]);
    });
    await panel.reload();
    await panel.waitForSelector("#resume-draft", { visible: true });
    await panel.click("#resume-draft");
    await panel.waitForSelector("#steps .step", { visible: true });
    assert.equal(await panel.$eval("#steps .step-action select", select => select.value), "hide");
    await panel.click("#test");
    await panel.waitForFunction(() => document.querySelector("#steps .test-result").textContent.includes("Changed 1"));
    assert.equal(await page.$eval("h1", element => getComputedStyle(element).display), "none");
    await panel.click("#undo");
    await panel.waitForFunction(() => document.querySelector("#status").textContent === "Test undone.");
    assert.equal(await page.$eval("h1", element => getComputedStyle(element).display), "block");

    await page.evaluate(() => document.body.append(document.createElement("h1")));
    await panel.click("#test");
    await panel.waitForFunction(() => document.querySelector("#steps .test-result").textContent.includes("expected 1 match(es), found 2"));
    assert.equal(await page.$eval("h1", element => getComputedStyle(element).display), "block");
    await panel.click("#undo");

    await panel.click("#save-recipe");
    await panel.waitForFunction(() => document.querySelector("#saved").value !== "");
    const id = await panel.$eval("#saved", select => select.value);
    await panel.reload();
    await panel.waitForFunction(id => [...document.querySelector("#saved").options].some(option => option.value === id), {}, id);
    await panel.select("#saved", id);
    await panel.waitForFunction(() => document.querySelector(".target-status").textContent.includes("found 2"));
    await panel.$eval("#steps .advanced button", button => button.click());
    await panel.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Click the new element"));
    await page.evaluate(() => {
      const heading = document.querySelector("h1");
      heading.dataset.testid = "main-heading";
      heading.click();
    });
    await panel.waitForFunction(() => document.querySelector("#steps .target-field input").value.includes("main-heading"));
    await panel.waitForFunction(() => document.querySelector(".target-status").textContent.startsWith("Found on this page"));
    // Use the original stable selector for the reload assertion: the fixture changes above were in-memory only.
    await panel.$eval("#steps .target-field input", input => {
      input.value = "h1";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await panel.select("#steps select", "font");
    await panel.click("#save-recipe");
    await panel.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Saved"));
    await send({ type: "toggle", id, enabled: true });
    await page.reload();
    await page.waitForFunction(() => getComputedStyle(document.querySelector("h1")).fontSize === "18px");
  } finally {
    await panel.close();
    await page.close();
  }
});

test("popup actions wrap and Escape returns focus to More actions", async () => {
  const source = header("Popup layout", ["match http://localhost/*"]) + "void 0;";
  await send({ type: "save", id: "popup-layout", script: { source, enabled: false }, expected: null });
  const page = await openPage();
  await page.bringToFront();
  await manager.evaluate(() => chrome.action.openPopup());
  const target = await browser.waitForTarget(item => item.url().endsWith("/popup/popup.html"), { timeout: 5000 });
  const popup = await target.asPage();
  try {
    await popup.waitForSelector(".more");
    await popup.click(".more");
    const action = "#scripts > li:first-child .actions button:last-child";
    await popup.$eval(action, button => {
      button.textContent = "Don’t run on " + "long-subdomain".repeat(15) + ".example.com";
    });
    assert.ok(await popup.$eval(action, button => button.scrollWidth <= button.clientWidth + 1));
    await popup.focus(action);
    await popup.keyboard.press("Escape");
    assert.equal(await popup.$eval(".more", button => button.getAttribute("aria-expanded")), "false");
    assert.ok(await popup.$eval(".more", button => document.activeElement === button));
  } finally {
    await popup.close();
    await page.close();
  }
});

test("native toolbar popup keeps its width and aligns the pause control", async () => {
  for (const restricted of [false, true]) {
    const page = restricted ? await browser.newPage() : await openPage();
    if (restricted) await page.goto("chrome://version");
    await page.bringToFront();
    await manager.evaluate(() => chrome.action.openPopup());
    const target = await browser.waitForTarget(item => item.url().endsWith("/popup/popup.html"), { timeout: 5000 });
    const popup = await target.asPage();
    try {
      await popup.waitForFunction(restricted => {
        const title = document.querySelector("#page").textContent;
        return restricted ? title.includes("can’t run") : title.startsWith("localhost:");
      }, {}, restricted);
      const layout = await popup.evaluate(() => {
        const header = document.querySelector("header").getBoundingClientRect();
        const title = document.querySelector("h1").getBoundingClientRect();
        const pause = document.querySelector("#pause-label").getBoundingClientRect();
        return {
          width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
          aligned: Math.abs(title.top + title.bottom - pause.top - pause.bottom) < 2,
          padding: header.right - pause.right,
          reloadHidden: document.querySelector("#reload").hidden, checkHidden: document.querySelector("#check").hidden
        };
      });
      assert.ok(layout.width >= 280 && !layout.overflow && layout.aligned && layout.padding >= 10, JSON.stringify(layout));
      assert.equal(layout.reloadHidden, restricted);
      assert.equal(layout.checkHidden, restricted);
    } finally {
      await popup.close();
      await page.close();
    }
  }
});

test("extension pages have no accessibility violations axe can find", async () => {
  const axe = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  const pages = ["manager/index.html", "popup/popup.html", `install/install.html#${site()}/hello.user.js`, "guide/guide.html", "welcome/welcome.html"];
  const found = [];
  for (const path of pages) {
    const page = await browser.newPage();
    try {
      await page.goto(`chrome-extension://${extensionId}/${path}`, { waitUntil: "networkidle0" });
      await new Promise(resolve => setTimeout(resolve, 500));
      // Runtime evaluation isn't subject to the extension's content security policy, so axe can be loaded this way.
      await page.evaluate(axe);
      // The code editor scrolls as its cursor moves, so its scroller needs no focus of its own.
      const violations = await page.evaluate(async () => (await globalThis.axe.run({ exclude: [[".cm-scroller"]] }, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }
      })).violations.map(({ id, help, nodes }) => `${id}: ${help} (${nodes.slice(0, 3).map(node => node.target.join(" ")).join(", ")})`));
      found.push(...violations.map(violation => `${path.split("#")[0]} · ${violation}`));
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(found, []);
});

test("a Tampermonkey backup with an explicit HTTP port imports its values and runs", async () => {
  const source = header("From Tampermonkey", [`match http://localhost:${port}/*`, "grant GM_getValue", "grant GM_addElement"]) +
    'GM_addElement(document.body, "p", { id: "imported", textContent: GM_getValue("greeting", "missing") });';
  const backup = zip({
    "From Tampermonkey.user.js": source,
    "From Tampermonkey.options.json": JSON.stringify({ settings: { enabled: true, position: 1 }, options: {} }),
    "From Tampermonkey.storage.json": JSON.stringify({ ts: 1, data: { greeting: "hello from Tampermonkey" } })
  });
  const file = path.join(extensionDir, "..", `tampermonkey-backup-${Date.now()}.zip`);
  await writeFile(file, backup);
  try {
    await manager.bringToFront();
    const input = await manager.$("#import-file");
    await input.uploadFile(file);
    await manager.waitForSelector("#review[open] .import-turn-on input:checked");
    assert.match(await manager.$eval("#review-title", node => node.textContent), /tampermonkey-backup/);
    assert.match(await manager.$eval("#review-content", node => node.textContent), /Brings 1 stored value/);
    await manager.evaluate(() => [...document.querySelectorAll("#review-content button")].find(button => button.textContent === "Import selected").click());
    await manager.waitForFunction(() => document.querySelector("#status").textContent.includes("1 turned on"));
  } finally {
    await rm(file, { force: true });
  }
  const page = await openPage();
  await page.waitForSelector("#imported", { timeout: 5000 });
  assert.equal(await page.$eval("#imported", node => node.textContent), "hello from Tampermonkey");
  await page.close();
});

test("new script from the popup uses a valid match for HTTP sites on custom ports", async () => {
  const page = await openPage();
  await page.bringToFront();
  await manager.evaluate(() => chrome.action.openPopup());
  const target = await browser.waitForTarget(item => item.url().endsWith("/popup/popup.html"), { timeout: 5000 });
  const popup = await target.asPage();
  try {
    await manager.evaluate(() => {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "session" && changes.newScriptSite?.newValue) {
          document.documentElement.dataset.testSitePattern = changes.newScriptSite.newValue;
        }
      });
    });
    await popup.waitForSelector("#create", { visible: true, timeout: 5000 });
    await popup.$eval("#create", button => button.click());
    const pattern = await attribute(manager, "data-test-site-pattern");
    assert.equal(pattern, "http://localhost/*");
  } finally {
    await page.close();
  }
});

test("editor toolbar opens navigation and applies undoable editing commands", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/manager/index.html`);
    await page.waitForSelector(".cm-content");
    await page.click("#editor-wrap");
    assert.ok(await page.$(".cm-content.cm-lineWrapping"));
    await page.click("#editor-jump");
    await page.waitForSelector(".cm-panel input");
    await page.keyboard.press("Escape");
    await page.click("#editor-find");
    await page.waitForSelector(".cm-search input");
    await page.keyboard.press("Escape");
    const text = await page.$eval(".cm-content", node => node.innerText);
    await page.click("#editor-edits summary");
    await page.click('[data-edit="indent"]');
    assert.notEqual(await page.$eval(".cm-content", node => node.innerText), text);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    await page.keyboard.press("z");
    await page.keyboard.up(modifier);
    assert.equal(await page.$eval(".cm-content", node => node.innerText), text);
  } finally {
    await page.close();
  }
});

test("manager adds tags through setup, groups scripts, and validates the draft", async () => {
  const source = header("Grouped toolbar script", ["match http://localhost/*", "tag work"]) + "void 0;";
  await send({ type: "save", id: "grouped-toolbar", script: { source, enabled: false }, expected: null });
  const page = await browser.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/manager/index.html`);
    await page.waitForFunction(() => document.querySelector("#scripts").textContent.includes("Grouped toolbar script"));
    await page.select("#group-scripts", "tag");
    await page.waitForFunction(() => [...document.querySelectorAll(".script-group-title")].some(heading => heading.firstChild?.textContent === "work"));
    await page.evaluate(() => {
      [...document.querySelectorAll("#scripts button")].find(button => button.textContent.includes("Grouped toolbar script")).click();
    });
    await page.click("#setup summary");
    await page.type("#setup-tags", ", layout");
    await page.click("#apply-setup");
    await page.waitForFunction(() => document.querySelector(".cm-content").textContent.includes("layout"));
    await page.click("#editor-validate");
    await page.waitForFunction(() => document.querySelector("#status").textContent.includes("are valid"));
    await page.focus(".cm-content");
    await page.keyboard.down("Control");
    await page.keyboard.press("End");
    await page.keyboard.up("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.type("const =");
    await page.click("#editor-validate");
    await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("JavaScript:"), { timeout: 4000 });
  } finally {
    page.on("dialog", dialog => dialog.accept());
    await page.close();
  }
});

test("manager dashboard counts scripts and clears filters", async () => {
  const source = header("Dashboard example", ["match http://localhost/*", "tag work"]) + "void 0;";
  await send({ type: "save", id: "dashboard-example", script: { source, enabled: false }, expected: null });
  const dashboard = await browser.newPage();
  try {
    await dashboard.goto(`chrome-extension://${extensionId}/manager/index.html`);
    await dashboard.waitForFunction(() => document.querySelector("#scripts").textContent.includes("Dashboard example"));
    for (const width of [360, 1200]) {
      await dashboard.setViewport({ width, height: 900 });
      assert.ok(await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await dashboard.select("#group-scripts", "tag");
    await dashboard.waitForSelector(".group-count");
    await dashboard.type("#search", "no dashboard results");
    await dashboard.waitForFunction(() => document.querySelector("#result-count").textContent.startsWith("0 of"));
    assert.ok(await dashboard.$eval("#scripts", list => list.hidden));
    await dashboard.click("#clear-filters");
    assert.ok(await dashboard.$eval("#search", input => !input.value && document.activeElement === input));
    assert.ok(await dashboard.$eval("#scripts", list => !list.hidden));
    assert.equal(await dashboard.$eval("#group-scripts", select => select.value), "tag");
  } finally {
    await dashboard.close();
  }
});

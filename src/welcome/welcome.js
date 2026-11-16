// Opened once, when Tailorscript is installed: walks through Chrome's Allow User Scripts switch and offers ways to start.
import { $ } from "../shared/dom.js";
import { localize, t } from "../shared/i18n.js";

localize();
document.title = t("welcomePageTitle");

const setup = $("#setup");
const state = $("#setup-state");
const managerUrl = chrome.runtime.getURL("manager/index.html");

// Asks the worker to register scripts, which tells us whether Chrome lets userscripts run yet.
async function check() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "sync" });
    const ready = response?.ok && !response.state?.setupNeeded;
    setup.dataset.state = state.dataset.state = ready ? "done" : "";
    state.textContent = ready ? t("setupReady") : t("setupNotYet");
    $("#open-details", HTMLButtonElement).hidden = ready;
    $("#setup-title").textContent = ready ? t("setupDone") : t("setupTitle");
  } catch {
    state.textContent = t("setupCheckFailed");
  }
}

async function openManager(context = {}) {
  await chrome.storage.session.set(context);
  await chrome.tabs.update({ url: managerUrl });
}

$("#open-details", HTMLButtonElement).addEventListener("click", () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
$("#start-template", HTMLButtonElement).addEventListener("click", () => openManager({ newScriptSite: "https://example.com/*" }));
$("#start-builder", HTMLButtonElement).addEventListener("click", () => openManager({ showBuilderHelp: true }));
$("#start-guide", HTMLButtonElement).addEventListener("click", () => chrome.tabs.update({ url: chrome.runtime.getURL("guide/guide.html") }));
addEventListener("focus", check);
check();

import { timeAgo } from "../shared/format.js";
import { readScripts, readSettings } from "../shared/storage.js";
import { originsFor, parseSource, runsOn } from "../shared/userscript.js";

const managerUrl = chrome.runtime.getURL("manager/index.html");
const list = document.querySelector("#scripts");
const empty = document.querySelector("#empty");
const notice = document.querySelector("#notice");
const paused = document.querySelector("#paused");
const reload = document.querySelector("#reload");
const check = document.querySelector("#check");

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const url = /^https?:/.test(tab?.url ?? "") ? new URL(tab.url) : null;
document.querySelector("#page").textContent = url?.host ?? "This page can’t run userscripts";
reload.disabled = !url;
check.disabled = !url;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? "The script manager did not respond.");
  return response.state;
}

async function openManager(context = {}) {
  await chrome.storage.session.set(context);
  const [existing] = await chrome.tabs.query({ url: managerUrl, currentWindow: true });
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url: managerUrl });
  window.close();
}

function runText(script, run, state, settings) {
  if (settings.paused) return ["All scripts are paused", "warning"];
  if (!script.enabled) return ["Disabled", ""];
  if (state?.issues?.[script.id]) return [state.issues[script.id], "warning"];
  if (run?.error) return [`Error${run.error.line ? ` on line ${run.error.line}` : ""}: ${run.error.message}`, "error"];
  if (run) return [`Ran ${timeAgo(run.at)}`, "ran"];
  return ["Hasn’t run on this page yet. Reload to apply.", "warning"];
}

async function render() {
  const [scripts, settings, session] = await Promise.all([
    readScripts(), readSettings(), chrome.storage.session.get(["registrationState", "tabRuns"])
  ]);
  paused.checked = Boolean(settings.paused);
  const runs = session.tabRuns?.[tab?.id]?.scripts ?? {};
  const matching = url ? scripts.filter(script => runsOn(script.source, url)) : [];
  empty.textContent = !url ? "Userscripts run only on HTTP and HTTPS pages."
    : matching.length ? "" : "No scripts match this page.";
  list.replaceChildren(...matching.map(script => {
    const item = document.createElement("li");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = script.enabled;
    toggle.setAttribute("aria-label", `Enable ${script.name}`);
    toggle.addEventListener("change", () => setEnabled(script, toggle));
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = script.name;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openManager({ focusScript: script.id }));
    const run = document.createElement("span");
    const [text, state] = runText(script, runs[script.id], session.registrationState, settings);
    run.className = "run";
    run.textContent = text;
    run.dataset.state = state;
    item.append(toggle, name, edit, run);
    return item;
  }));
}

async function setEnabled(script, toggle) {
  notice.textContent = "";
  try {
    if (toggle.checked && !await chrome.permissions.contains({ origins: originsFor(parseSource(script.source).matches) })) {
      toggle.checked = false;
      await openManager({ focusScript: script.id, focusMessage: "Check Enable on matching pages and save to grant site access." });
      return;
    }
    await send({ type: "toggle", id: script.id, enabled: toggle.checked });
    notice.textContent = "Reload the tab to apply this change.";
    reload.dataset.suggested = "true";
  } catch (error) {
    toggle.checked = !toggle.checked;
    notice.textContent = error.message;
  }
}

paused.addEventListener("change", async () => {
  try {
    await send({ type: "settings", patch: { paused: paused.checked } });
    notice.textContent = paused.checked ? "Scripts are paused. Reload tabs to stop running ones." : "Scripts resumed. Reload to apply.";
    reload.dataset.suggested = "true";
  } catch (error) {
    paused.checked = !paused.checked;
    notice.textContent = error.message;
  }
});
reload.addEventListener("click", async () => {
  await chrome.tabs.reload(tab.id);
  window.close();
});
check.addEventListener("click", () => openManager({ diagnosticUrl: url.href, showDiagnostics: Date.now() }));
document.querySelector("#manager").addEventListener("click", () => openManager());
chrome.storage.onChanged.addListener(render);

await render();

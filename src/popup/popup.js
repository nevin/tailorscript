import { timeAgo } from "../shared/format.js";
import { readScripts, readSettings } from "../shared/storage.js";
import { originsFor, parseSource, runsOn } from "../shared/userscript.js";

const managerUrl = chrome.runtime.getURL("manager/index.html");
const list = document.querySelector("#scripts");
const empty = document.querySelector("#empty");
const emptyText = document.querySelector("#empty-text");
const count = document.querySelector("#count");
const create = document.querySelector("#create");
const notice = document.querySelector("#notice");
const paused = document.querySelector("#paused");
const reload = document.querySelector("#reload");
const check = document.querySelector("#check");

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const url = /^https?:/.test(tab?.url ?? "") ? new URL(tab.url) : null;
document.querySelector("#page").textContent = url?.host ?? "This page can’t run userscripts";
reload.disabled = !url;
check.disabled = !url;
create.hidden = !url;

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
  if (!script.enabled) return ["Off", "off"];
  if (settings.paused) return ["Paused", "off"];
  if (state?.issues?.[script.id]) return ["Needs site access. Edit to grant it.", "warning"];
  if (run?.error) return [`Error${run.error.line ? ` on line ${run.error.line}` : ""}: ${run.error.message}`, "error"];
  if (run) return [`Ran ${timeAgo(run.at)}`, "ran"];
  return ["Not run on this page yet. Reload to apply.", "warning"];
}

async function render() {
  const [scripts, settings, session] = await Promise.all([
    readScripts(), readSettings(), chrome.storage.session.get(["registrationState", "tabRuns"])
  ]);
  paused.checked = Boolean(settings.paused);
  const runs = session.tabRuns?.[tab?.id]?.scripts ?? {};
  const matching = url ? scripts.filter(script => runsOn(script.source, url)) : [];
  const active = matching.filter(script => script.enabled).length;
  count.textContent = !url ? "" : !matching.length ? "No scripts for this site"
    : `${matching.length} script${matching.length === 1 ? "" : "s"} for this site · ${active} on`;
  empty.hidden = Boolean(url && matching.length);
  emptyText.textContent = !url ? "Userscripts run only on HTTP and HTTPS pages."
    : `Nothing runs on ${url.host} yet. Start one from a template below.`;
  list.replaceChildren(...matching.map(script => {
    const item = document.createElement("li");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "switch";
    toggle.setAttribute("role", "switch");
    toggle.checked = script.enabled;
    toggle.setAttribute("aria-label", `Enable ${script.name}`);
    toggle.addEventListener("change", () => setEnabled(script, toggle));
    const details = document.createElement("div");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = script.name;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "edit";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", `Edit ${script.name}`);
    edit.addEventListener("click", () => openManager({ focusScript: script.id }));
    const run = document.createElement("span");
    const [text, state] = runText(script, runs[script.id], session.registrationState, settings);
    run.className = "run";
    run.textContent = text;
    run.dataset.state = state;
    details.append(name, run);
    item.append(details, edit, toggle);
    return item;
  }));
}

async function setEnabled(script, toggle) {
  notice.textContent = "";
  try {
    if (toggle.checked && !await chrome.permissions.contains({ origins: originsFor(parseSource(script.source).matches) })) {
      toggle.checked = false;
      await openManager({ focusScript: script.id, focusMessage: "Turn on Enabled and save to grant site access." });
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
create.addEventListener("click", () => openManager({ newScriptSite: `${url.origin}/*` }));
document.querySelector("#manager").addEventListener("click", () => openManager());
chrome.storage.onChanged.addListener(render);

await render();

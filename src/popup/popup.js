import { timeAgo } from "../shared/format.js";
import { findScriptsUrl, installPageUrl, isUserscriptUrl } from "../shared/install.js";
import { readScripts, readSettings } from "../shared/storage.js";
import { parseSource, runsOn } from "../shared/userscript.js";

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
const find = document.querySelector("#find");
const setup = document.querySelector("#setup");

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const url = /^https?:/.test(tab?.url ?? "") ? new URL(tab.url) : null;
document.querySelector("#page").textContent = url?.host ?? "This page can’t run userscripts";
reload.disabled = !url;
check.disabled = !url;
create.hidden = !url;
find.hidden = !url;
document.querySelector("#install-banner").hidden = !isUserscriptUrl(tab?.url);
let expanded;

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
  if (state?.manual?.includes(script.id) || (!script.enabled && run)) {
    return run ? [`Ran ${timeAgo(run.at)}`, "ran"] : ["Runs when you choose Run now", "off"];
  }
  if (!script.enabled) return ["Off", "off"];
  if (settings.paused) return ["Paused", "off"];
  if (state?.issues?.[script.id]) return [state.issues[script.id], "warning"];
  if (run?.error) return [`Error${run.error.line ? ` on line ${run.error.line}` : ""}: ${run.error.message}`, "error"];
  if (run) return [`Ran ${timeAgo(run.at)}`, "ran"];
  if (script.pendingUpdate) return [`Update to v${script.pendingUpdate.version} is waiting for review`, "warning"];
  return ["Not run on this page yet. Reload to apply.", "warning"];
}

function button(label, action, className) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (className) element.className = className;
  element.addEventListener("click", action);
  return element;
}

function act(operation, done) {
  notice.textContent = "";
  operation().then(result => {
    if (done && result !== false) notice.textContent = done;
  }, error => {
    notice.textContent = error.message;
  });
}

function renderScript(script, runs, menus, session, settings) {
  const item = document.createElement("li");
  const row = document.createElement("div");
  row.className = "row";
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
  const run = document.createElement("span");
  const [text, state] = runText(script, runs[script.id], session.registrationState, settings);
  run.className = "run";
  run.textContent = text;
  run.dataset.state = state;
  details.append(name, run);

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.id = `actions-${script.id}`;
  actions.hidden = expanded !== script.id;
  actions.append(
    button("Run now", () => act(async () => {
      await send({ type: "run-now", id: script.id, tabId: tab.id });
    }, `Ran “${script.name}” on this page.`)),
    button("Edit", () => openManager({ focusScript: script.id })),
    button(`Don’t run on ${url.hostname}`, () => act(async () => {
      if (!confirm(`Stop “${script.name}” from running on ${url.hostname}? This adds an @exclude-match line you can remove in the editor.`)) return false;
      await send({ type: "exclude-site", id: script.id, host: url.hostname });
      reload.dataset.suggested = "true";
    }, `“${script.name}” won’t run on ${url.hostname}. Reload to apply.`)));
  const more = button("⋯", () => {
    expanded = actions.hidden ? script.id : undefined;
    for (const other of list.querySelectorAll(".actions")) other.hidden = other !== actions || !actions.hidden;
    for (const other of list.querySelectorAll(".more")) other.setAttribute("aria-expanded", String(other === more && !actions.hidden));
  }, "more");
  more.setAttribute("aria-label", `More actions for ${script.name}`);
  more.setAttribute("aria-expanded", String(!actions.hidden));
  more.setAttribute("aria-controls", actions.id);
  row.append(details, more, toggle);
  item.append(row, actions);

  const commands = menus[script.id] ?? [];
  if (commands.length) {
    const menu = document.createElement("ul");
    menu.className = "commands";
    menu.setAttribute("aria-label", `${script.name} commands`);
    for (const command of commands) {
      const entry = document.createElement("li");
      entry.append(button(command.caption, () => act(async () => {
        await send({ type: "menu-run", tabId: tab.id, id: script.id, commandId: command.commandId });
        window.close();
      })));
      menu.append(entry);
    }
    item.append(menu);
  }
  return item;
}

async function render() {
  const [scripts, settings, session] = await Promise.all([
    readScripts(), readSettings(), chrome.storage.session.get(["registrationState", "tabRuns"])
  ]);
  paused.checked = Boolean(settings.paused);
  setup.hidden = !session.registrationState?.setupNeeded;
  const tabState = session.tabRuns?.[tab?.id] ?? {};
  const runs = tabState.scripts ?? {};
  const menus = tabState.menus ?? {};
  const matching = url ? scripts.filter(script => runsOn(script.source, url) || runs[script.id] || menus[script.id]?.length) : [];
  const active = matching.filter(script => script.enabled).length;
  count.textContent = !url ? "" : !matching.length ? "No scripts for this site"
    : `${matching.length} script${matching.length === 1 ? "" : "s"} for this site · ${active} on`;
  empty.hidden = Boolean(url && matching.length);
  emptyText.textContent = !url ? "Userscripts run only on HTTP and HTTPS pages."
    : `Nothing runs on ${url.host} yet. Write one, or find scripts others have shared.`;
  list.replaceChildren(...matching.map(script => renderScript(script, runs, menus, session, settings)));
}

async function setEnabled(script, toggle) {
  notice.textContent = "";
  try {
    if (toggle.checked && !await chrome.permissions.contains({ origins: parseSource(script.source).origins })) {
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
chrome.commands?.getAll().then(commands => {
  const shortcut = commands.find(command => command.name === "toggle-pause")?.shortcut;
  if (shortcut) document.querySelector("#pause-label").title = `Shortcut: ${shortcut}`;
});
reload.addEventListener("click", async () => {
  await chrome.tabs.reload(tab.id);
  window.close();
});
document.querySelector("#open-settings").addEventListener("click", async () => {
  await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  window.close();
});
document.querySelector("#install-page").addEventListener("click", async () => {
  await chrome.tabs.update(tab.id, { url: installPageUrl(tab.url) });
  window.close();
});
find.addEventListener("click", async () => {
  await chrome.tabs.create({ url: findScriptsUrl(url.hostname) });
  window.close();
});
check.addEventListener("click", () => openManager({ diagnosticUrl: url.href, showDiagnostics: Date.now() }));
create.addEventListener("click", () => openManager({ newScriptSite: `${url.origin}/*` }));
document.querySelector("#manager").addEventListener("click", () => openManager());
chrome.storage.onChanged.addListener(render);

await render();
// The setup card reflects the last registration attempt, so retry in case Allow User Scripts was just turned on.
if (!setup.hidden) send({ type: "sync" }).catch(() => {});

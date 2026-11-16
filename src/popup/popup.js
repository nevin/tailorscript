import { $ } from "../shared/dom.js";
import { localize, t } from "../shared/i18n.js";
import { timeAgo } from "../shared/format.js";
import { findScriptsUrl, installPageUrl, isUserscriptUrl } from "../shared/install.js";
import { getSession, readScripts, readSettings } from "../shared/storage.js";
import { parseSource, runsOn } from "../shared/userscript.js";

const managerUrl = chrome.runtime.getURL("manager/index.html");
const list = $("#scripts");
const empty = $("#empty");
const emptyText = $("#empty-text");
const count = $("#count");
const create = $("#create", HTMLButtonElement);
const notice = $("#notice");
const paused = $("#paused", HTMLInputElement);
const reload = $("#reload", HTMLButtonElement);
const check = $("#check", HTMLButtonElement);
const find = $("#find", HTMLButtonElement);
const setup = $("#setup");

localize();
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const url = /^https?:/.test(tab?.url ?? "") ? new URL(tab.url) : null;
$("#page").textContent = url?.host ?? t("pageCannotRun");
reload.hidden = !url;
check.hidden = !url;
create.hidden = !url;
find.hidden = !url;
$("#install-banner").hidden = !isUserscriptUrl(tab?.url);
let expanded;

async function send(message) {
  const connectionError = t("workerNoAnswer");
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.warn("Tailorscript popup message failed", message.type, error);
    throw new Error(connectionError, { cause: error });
  }
  if (!response?.ok) throw new Error(response?.error ?? connectionError);
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
    return run ? [t("ranAgo", timeAgo(run.at)), "ran"] : [t("runsOnRunNow"), "off"];
  }
  if (!script.enabled) return [t("stateOff"), "off"];
  if (settings.paused) return [t("statePaused"), "off"];
  if (state?.issues?.[script.id]) return [state.issues[script.id], "warning"];
  if (run?.error) return [run.error.line ? t("errorOnLine", run.error.line, run.error.message) : t("errorPlain", run.error.message), "error"];
  if (run) return [t("ranAgo", timeAgo(run.at)), "ran"];
  if (script.pendingUpdate) return [t("updateWaiting", script.pendingUpdate.version), "warning"];
  return [t("notRunYet"), "pending"];
}

// Messages are warnings unless they say otherwise.
function tell(text, kind = "warning") {
  notice.textContent = text;
  notice.dataset.kind = kind;
}

// The Reload button stands out whenever the page needs reloading for a change to show.
function suggestReload() {
  reload.dataset.suggested = "true";
  reload.textContent = t("reloadToApply");
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
  tell("");
  operation().then(result => {
    if (done && result !== false) tell(done, "info");
  }, error => {
    tell(error.message);
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
  toggle.setAttribute("aria-label", t("enableScript", script.name));
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
    button(t("runNow"), () => act(async () => {
      await send({ type: "run-now", id: script.id, tabId: tab.id });
    }, t("sentToPage", script.name))),
    button(t("edit"), () => openManager({ focusScript: script.id })),
    button(t("dontRunOn", url.hostname), () => act(async () => {
      if (!confirm(t("confirmExclude", script.name, url.hostname))) return false;
      await send({ type: "exclude-site", id: script.id, host: url.hostname });
      suggestReload();
    }, t("excluded", script.name, url.hostname))));
  function setActions(open) {
    expanded = open ? script.id : undefined;
    for (const other of /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll(".actions"))) other.hidden = other !== actions || !open;
    for (const other of list.querySelectorAll(".more")) other.setAttribute("aria-expanded", String(other === more && open));
  }
  const more = button("⋯", () => setActions(actions.hidden), "more");
  item.addEventListener("keydown", event => {
    if (event.key !== "Escape" || actions.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    setActions(false);
    more.focus();
  });
  more.setAttribute("aria-label", t("moreActionsFor", script.name));
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

let renderVersion = 0;
async function render() {
  const version = ++renderVersion;
  const [scripts, settings, session] = await Promise.all([
    readScripts(), readSettings(), getSession(["registrationState", "tabRuns"])
  ]);
  if (version !== renderVersion) return;
  paused.checked = Boolean(settings.paused);
  setup.hidden = !session.registrationState?.setupNeeded;
  const tabState = session.tabRuns?.[tab?.id] ?? { scripts: {}, menus: {} };
  const runs = tabState.scripts ?? {};
  const menus = tabState.menus ?? {};
  const matching = url ? scripts.filter(script => runsOn(script.source, url) || runs[script.id] || menus[script.id]?.length) : [];
  const active = matching.filter(script => script.enabled).length;
  count.textContent = !url ? "" : !matching.length ? t("noScriptsForSite")
    : matching.length === 1 ? t("scriptsForSiteOne", active) : t("scriptsForSiteMany", matching.length, active);
  empty.hidden = Boolean(url && matching.length);
  emptyText.textContent = !url ? t("httpOnly") : t("nothingRuns", url.host);
  list.replaceChildren(...matching.map(script => renderScript(script, runs, menus, session, settings)));
  // Scripts that are on but haven't run here usually just need the page reloaded, so say that once, on the button.
  if (list.querySelector('.run[data-state="pending"]')) suggestReload();
}

async function setEnabled(script, toggle) {
  tell("");
  try {
    const { origins } = parseSource(script.source);
    if (toggle.checked && !await chrome.permissions.contains({ origins })) {
      // Chrome closes the popup while it asks, so the service worker finishes the job once access is granted
      // (enablePending in background/library.js). If the popup stays open, the lines below do it instead.
      await chrome.storage.session.set({ pendingEnable: { id: script.id, at: Date.now() } });
      const granted = await chrome.permissions.request({ origins });
      await chrome.storage.session.remove("pendingEnable");
      if (!granted) {
        toggle.checked = false;
        tell(t("accessDeclined"));
        return;
      }
    }
    await send({ type: "toggle", id: script.id, enabled: toggle.checked });
    tell(t("reloadTabToApply"), "info");
    suggestReload();
  } catch (error) {
    toggle.checked = !toggle.checked;
    tell(error.message);
  }
}

paused.addEventListener("change", async () => {
  try {
    await send({ type: "settings", patch: { paused: paused.checked } });
    tell(paused.checked ? t("scriptsPaused") : t("scriptsResumed"), "info");
    suggestReload();
  } catch (error) {
    paused.checked = !paused.checked;
    tell(error.message);
  }
});
chrome.commands?.getAll().then(commands => {
  const shortcut = commands.find(command => command.name === "toggle-pause")?.shortcut;
  if (shortcut) $("#pause-label").title = t("shortcutTitle", shortcut);
});
reload.addEventListener("click", async () => {
  await chrome.tabs.reload(tab.id);
  window.close();
});
$("#open-settings", HTMLButtonElement).addEventListener("click", async () => {
  await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  window.close();
});
$("#install-page", HTMLButtonElement).addEventListener("click", async () => {
  await chrome.tabs.update(tab.id, { url: installPageUrl(tab.url) });
  window.close();
});
find.addEventListener("click", async () => {
  await chrome.tabs.create({ url: findScriptsUrl(url.hostname) });
  window.close();
});
check.addEventListener("click", () => openManager({ diagnosticUrl: url.href, showDiagnostics: Date.now() }));
create.addEventListener("click", () => openManager({ newScriptSite: `${url.origin}/*` }));
$("#manager", HTMLButtonElement).addEventListener("click", () => openManager());
const footerMenu = $(".footer-menu", HTMLDetailsElement);
$("#builder", HTMLButtonElement).addEventListener("click", () => {
  footerMenu.open = false;
  tell(t("builderHowTo"), "info");
});
$("#guide", HTMLButtonElement).addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("guide/guide.html") });
  window.close();
});
let scheduledRender;
chrome.storage.onChanged.addListener((changes, area) => {
  const relevant = area === "local" ? Object.keys(changes).some(key =>
    ["settings", "scripts", "scriptOrder", "schemaVersion"].includes(key) || key.startsWith("script:"))
    : area === "session" && (changes.registrationState ||
      (changes.tabRuns && JSON.stringify(changes.tabRuns.oldValue?.[tab?.id]) !==
        JSON.stringify(changes.tabRuns.newValue?.[tab?.id])));
  if (!relevant || scheduledRender) return;
  scheduledRender = requestAnimationFrame(() => {
    scheduledRender = undefined;
    render().catch(error => { tell(error.message); });
  });
});

await render();
// The setup card reflects the last registration attempt, so retry in case Allow User Scripts was just turned on.
if (!setup.hidden) send({ type: "sync" }).catch(() => {});

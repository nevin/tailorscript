import { diffView } from "../manager/diff.js";
import { highlight } from "../manager/editor.js";
import { describeGrants } from "../shared/install.js";
import { readScripts } from "../shared/storage.js";
import { compareVersions, grantFamilies, insecureSources, parseSource } from "../shared/userscript.js";
import { validate } from "../shared/validate.js";

// Websites can open this page, so it refuses to run in a frame, where a disguised click could install a script.
if (window.top !== window) {
  document.body.replaceChildren();
  throw new Error("The Tailorscript install page can’t be shown inside another page.");
}

const url = location.hash.slice(1);
const $ = selector => document.querySelector(selector);
const state = $("#state");
const installButton = $("#install");
let source;
let metadata;
let existing;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showError(message, retry) {
  state.textContent = "";
  $("#error-text").textContent = message;
  $("#error").hidden = false;
  const allow = $("#allow");
  allow.hidden = !retry;
  if (retry) {
    allow.textContent = retry.label;
    allow.onclick = retry.action;
  }
}

function metadataOf(script) {
  try {
    return parseSource(script.source);
  } catch {
    return null;
  }
}

function renderSites() {
  const sites = $("#sites");
  const rules = [...metadata.matches, ...metadata.includes];
  sites.replaceChildren(...rules.map(rule => element("code", rule === "*://*/*" || rule === "*" ? "every website" : rule)));
  const excluded = [...metadata.excludeMatches, ...metadata.excludes];
  if (excluded.length) sites.append("except", ...excluded.map(rule => element("code", rule)));
  if (metadata.runAt === "manual") sites.append(element("span", "only when you choose Run now", "muted"));
}

function renderDetails() {
  $("#name").textContent = metadata.name;
  $("#version").textContent = metadata.version ? `v${metadata.version}` : "";
  $("#description").textContent = metadata.description;
  const byline = $("#byline");
  byline.replaceChildren();
  if (metadata.author) byline.append(`By ${metadata.author} · `);
  const link = element("a", url);
  link.href = metadata.homepage || url;
  link.target = "_blank";
  link.rel = "noreferrer";
  byline.append("From ", link);
  renderSites();
  $("#grants").replaceChildren(...describeGrants(metadata, grantFamilies).map(({ text, warning }) => element("li", text, warning ? "warning-item" : "")));
  const loads = [...metadata.requires, ...metadata.resources.map(({ name, url: address }) => `${address} (${name})`)];
  $("#code-title").hidden = $("#code-sources").hidden = !loads.length;
  $("#code-sources ul").replaceChildren(...loads.map(address => element("li", address)));
  const unsupported = $("#unsupported");
  unsupported.hidden = !metadata.unsupportedGrants.length;
  unsupported.textContent = `Tailorscript doesn’t provide ${metadata.unsupportedGrants.join(", ")}, so parts of this script may not work.`;
  highlight(source, $("#source"));
  const insecure = insecureSources(metadata, url);
  $("#insecure").hidden = !insecure.length;
  $("#insecure").textContent = `This script ${insecure.includes(url) ? "is" : "loads code that is"} downloaded over unencrypted http (${insecure.join(", ")}), `
    + "so someone on your network could change it. Install it only on a network you trust, and updates will wait for your review.";

  const notice = $("#existing");
  notice.hidden = !existing;
  $("#changes").hidden = !existing;
  if (existing) {
    const installed = metadataOf(existing)?.version;
    const order = compareVersions(metadata.version, installed);
    // A script from another address that reuses the name would inherit the installed script's saved data.
    const lookalike = existing.installUrl !== url && existing.source !== source;
    notice.classList.toggle("warning", lookalike);
    notice.textContent = existing.source === source ? `“${existing.name}” is already installed with this exact code.`
      : lookalike ? `You already have a script named “${existing.name}”, ${existing.installUrl ? `installed from ${existing.installUrl}` : "written in Tailorscript"}. `
        + "This one comes from a different address. Installing replaces yours, and the new code can read everything yours saved. Continue only if you trust this source."
      : order < 0 ? `This is older than the installed version${installed ? ` (v${installed})` : ""}. Installing it downgrades “${existing.name}”.`
      : `You have “${existing.name}”${installed ? ` v${installed}` : ""} installed. Installing replaces it and keeps its stored data.`;
    $("#changes").replaceChildren(element("p", "Changes from your installed copy:", "muted"), diffView(existing.source, source));
    installButton.textContent = existing.source === source ? "Reinstall" : lookalike ? "Replace" : order < 0 ? "Downgrade" : "Update";
    $("#enable").checked = existing.enabled;
    $("#auto-update").checked = existing.autoUpdate !== false;
  }
  $("#auto-update").closest("label").hidden = !metadata.updateUrl && !/\.user\.js$/.test(new URL(url).pathname);
  document.title = `Install ${metadata.name} · Tailorscript`;
  state.textContent = "";
  $("#details").hidden = false;
  installButton.focus();
}

async function load() {
  $("#error").hidden = true;
  state.textContent = "Downloading the script…";
  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    showError("This page needs the address of a .user.js file.");
    return;
  }
  let response;
  try {
    response = await fetch(url, { cache: "no-cache", credentials: "omit" });
  } catch {
    showError(`${parsed.host} didn’t let Tailorscript download the script.`, {
      label: `Allow access to ${parsed.host} and retry`,
      action: async () => {
        if (await chrome.permissions.request({ origins: [`${parsed.origin}/*`] })) load();
      }
    });
    return;
  }
  if (!response.ok) {
    showError(`The download failed with HTTP ${response.status}.`, { label: "Try again", action: load });
    return;
  }
  source = (await response.text()).replace(/\r\n?/g, "\n");
  try {
    metadata = validate(source);
  } catch (error) {
    showError(`This isn’t a script Tailorscript can install. ${error.message}`);
    return;
  }
  const scripts = await readScripts();
  existing = scripts.find(script => script.installUrl === url) ?? scripts.find(script => {
    const other = metadataOf(script);
    return other && other.name === metadata.name && other.namespace === metadata.namespace;
  });
  renderDetails();
}

installButton.addEventListener("click", async () => {
  const enable = $("#enable").checked;
  installButton.disabled = true;
  state.textContent = "Installing…";
  try {
    if (enable && !await chrome.permissions.request({ origins: metadata.origins })) {
      throw new Error("Site access was declined. Allow access, or install it turned off.");
    }
    const response = await chrome.runtime.sendMessage({
      type: "install", id: existing?.id, source, url, enabled: enable, autoUpdate: $("#auto-update").checked
    });
    if (!response?.ok) throw new Error(response?.error ?? "Tailorscript didn’t respond. Try again.");
    const issue = response.state.issues?.[response.state.installedId];
    $("#done-text").textContent = !enable ? `Installed “${metadata.name}”. It’s turned off until you enable it.`
      : issue ? `Installed “${metadata.name}”, but it can’t run yet: ${issue}`
      : `Installed “${metadata.name}”. Reload matching tabs to run it.`;
    $("#open-manager").onclick = async () => {
      const managerUrl = chrome.runtime.getURL("manager/index.html");
      await chrome.storage.session.set({ focusScript: response.state.installedId });
      const [manager] = await chrome.tabs.query({ url: managerUrl });
      if (manager) await chrome.tabs.update(manager.id, { active: true });
      else await chrome.tabs.create({ url: managerUrl });
      closeTab();
    };
    $("#details").hidden = true;
    $("#done").hidden = false;
    state.textContent = "";
    $("#open-manager").focus();
  } catch (error) {
    state.textContent = error.message;
    installButton.disabled = false;
  }
});
// Pages can't close tabs they didn't open, so ask Chrome to close this one.
async function closeTab() {
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
  else window.close();
}
$("#cancel").addEventListener("click", closeTab);
$("#close").addEventListener("click", closeTab);

load();

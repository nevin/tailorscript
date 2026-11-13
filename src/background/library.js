// Changes to the script library, applied one at a time through the write queue.
import { getLocal, getSession, readScripts, readSettings, writeScripts } from "../shared/storage.js";
import { backupToSync } from "../shared/sync-backup.js";
import { addMetadata, parseSource } from "../shared/userscript.js";
import { validate } from "../shared/validate.js";
import { resolveDeps } from "./dependencies.js";
import { ignore } from "./queue.js";
import { syncScripts } from "./registration.js";
import { sourceHash } from "./updates.js";

const settingTypes = { paused: "boolean", reloadAfterSave: "boolean", syncBackup: "boolean", lastExportAt: "number" };
const trashDays = 30;
const historyLimit = 25;
const pendingEnableMs = 2 * 60 * 1000;

export function showPaused(paused) {
  chrome.action?.setBadgeText({ text: paused ? "off" : "" }).catch(ignore);
  if (paused) chrome.action?.setBadgeBackgroundColor({ color: "#5a6b6e" }).catch(ignore);
}

export async function reconcile(scripts) {
  const settings = await readSettings();
  const state = await syncScripts(scripts, settings);
  await chrome.storage.session.set({ registrationState: state });
  showPaused(settings.paused);
  return state;
}

export async function purgeExpired() {
  const { trash = [] } = await getLocal("trash");
  const cutoff = Date.now() - trashDays * 86_400_000;
  const expired = trash.filter(script => script.deletedAt < cutoff);
  if (!expired.length) return;
  await chrome.storage.local.set({ trash: trash.filter(script => script.deletedAt >= cutoff) });
  await chrome.storage.local.remove(expired.flatMap(script => [`values:${script.id}`, `deps:${script.id}`]));
}

async function backup(scripts) {
  const settings = await readSettings();
  if (!settings.syncBackup) return;
  try {
    await chrome.storage.local.set({ syncState: { at: await backupToSync(scripts) } });
  } catch (error) {
    await chrome.storage.local.set({ syncState: { at: Date.now(), error: error.message } });
  }
}

export async function commit(scripts, extra = {}) {
  // Keep the editor's saved state durable even if Chrome rejects a registration.
  await writeScripts(scripts, extra);
  await backup(scripts);
  return reconcile(scripts);
}

// The popup closes while Chrome asks for site access, so it can't finish turning a script on itself. It leaves a
// note first, and the script is turned on here once the access it needs has been granted.
export async function enablePending() {
  const { pendingEnable } = await getSession("pendingEnable");
  if (!pendingEnable) return;
  const scripts = await readScripts();
  const index = scripts.findIndex(script => script.id === pendingEnable.id);
  if (index === -1 || Date.now() - pendingEnable.at > pendingEnableMs) {
    await chrome.storage.session.remove("pendingEnable");
    return;
  }
  if (!await chrome.permissions.contains({ origins: parseSource(scripts[index].source).origins })) return;
  await chrome.storage.session.remove("pendingEnable");
  if (!scripts[index].enabled) await handlers.toggle({ enabled: true }, scripts, index);
}

export function withHistory(current, source) {
  const history = current?.history ?? [];
  return current && current.source !== source
    ? [{ source: current.source, savedAt: Date.now() }, ...history].slice(0, historyLimit)
    : history;
}

export async function storedDeps(id) {
  if (!id) return undefined;
  const key = `deps:${id}`;
  return (await getLocal(key))[key];
}

// Downloads happen before a message joins the write queue, so a slow CDN never blocks other saves.
export const preparers = {
  async save({ id, script }) {
    return { deps: await resolveDeps(parseSource(script.source), await storedDeps(id)) };
  },
  async install({ id, source }) {
    return { deps: await resolveDeps(validate(source), await storedDeps(id)) };
  },
  async import({ entries }) {
    return {
      deps: await Promise.all(entries.map(async ({ source, replace }) => {
        try {
          return await resolveDeps(parseSource(source), await storedDeps(replace));
        } catch (error) {
          return { error: `${error.message} Save the script to try again.` };
        }
      }))
    };
  },
  async "apply-update"({ id }) {
    const script = (await readScripts()).find(item => item.id === id);
    if (!script?.pendingUpdate) throw new Error("There’s no update waiting for this script.");
    return { source: script.pendingUpdate.source, deps: await resolveDeps(parseSource(script.pendingUpdate.source), await storedDeps(id)) };
  }
};

// Each handler gets the message, the library, the target script's index and record, and what its preparer returned.
export const handlers = {
  async sync(message, scripts) {
    await purgeExpired();
    return reconcile(scripts);
  },

  async import({ entries }, scripts, index, current, { deps }) {
    const now = Date.now();
    const extra = {};
    entries.forEach(({ source, history, replace }, position) => {
      const { name } = parseSource(source);
      const at = replace ? scripts.findIndex(script => script.id === replace) : -1;
      let id;
      if (at === -1) {
        id = crypto.randomUUID();
        scripts.push({ id, source, history, enabled: false, name, updatedAt: now });
      } else {
        // Replaced scripts are disabled so imported code is reviewed before it runs.
        const previous = scripts[at];
        id = previous.id;
        scripts[at] = { ...previous, name, source, enabled: false, history: withHistory(previous, source), updatedAt: now };
      }
      extra[`deps:${id}`] = deps[position];
    });
    return commit(scripts, extra);
  },

  async save(message, scripts, index, current, { deps }) {
    const { source, enabled } = message.script;
    const { name } = validate(source);
    const script = {
      ...current,
      id: message.id, name, source, enabled,
      history: withHistory(current, source),
      updatedAt: current?.source === source ? current.updatedAt : Date.now()
    };
    if (index === -1) scripts.push(script);
    else scripts[index] = script;
    return commit(scripts, { [`deps:${message.id}`]: deps });
  },

  async install({ source, url, enabled, autoUpdate }, scripts, index, current, { deps }) {
    if (!/^https?:\/\//.test(url)) throw new Error("Scripts can only be installed from http or https addresses.");
    const { name } = validate(source);
    const id = current?.id ?? crypto.randomUUID();
    const now = Date.now();
    const { pendingUpdate, ...previous } = current ?? {};
    const script = {
      ...previous,
      id, name, source,
      enabled: Boolean(enabled),
      history: withHistory(current, source),
      updatedAt: now,
      installUrl: url,
      installedHash: await sourceHash(source),
      autoUpdate: autoUpdate !== false,
      updateCheck: { at: now }
    };
    if (index === -1) scripts.push(script);
    else scripts[index] = script;
    return { ...await commit(scripts, { [`deps:${id}`]: deps }), installedId: id };
  },

  async "apply-update"({ id }, scripts, index, current, prepared) {
    if (current?.pendingUpdate?.source !== prepared.source) throw new Error("This update changed. Check for updates again.");
    const { pendingUpdate, ...script } = current;
    scripts[index] = {
      ...script,
      name: parseSource(pendingUpdate.source).name,
      source: pendingUpdate.source,
      history: withHistory(current, pendingUpdate.source),
      updatedAt: Date.now(),
      installedHash: await sourceHash(pendingUpdate.source),
      updateCheck: { at: Date.now() }
    };
    return commit(scripts, { [`deps:${id}`]: prepared.deps });
  },

  async "dismiss-update"(message, scripts, index, current) {
    if (!current?.pendingUpdate) return reconcile(scripts);
    const { pendingUpdate, ...script } = current;
    scripts[index] = { ...script, updateCheck: { ...script.updateCheck, skipped: pendingUpdate.version } };
    return commit(scripts);
  },

  async "auto-update"({ enabled }, scripts, index, current) {
    if (!current) throw new Error("This script no longer exists. Reload the manager.");
    scripts[index] = { ...current, autoUpdate: enabled };
    return commit(scripts);
  },

  async "exclude-site"({ host }, scripts, index, current) {
    if (!current) throw new Error("This script no longer exists.");
    if (!/^[a-z\d.-]+$/i.test(host)) throw new Error("That isn’t a site Tailorscript can exclude.");
    const source = addMetadata(current.source, "exclude-match", `*://${host.toLowerCase()}/*`);
    validate(source);
    scripts[index] = { ...current, source, history: withHistory(current, source), updatedAt: Date.now() };
    return commit(scripts);
  },

  async toggle({ enabled }, scripts, index) {
    if (index === -1) throw new Error("This script no longer exists. Reload the manager.");
    scripts[index] = { ...scripts[index], enabled };
    return commit(scripts);
  },

  async delete(message, scripts, index) {
    if (index === -1) return reconcile(scripts);
    const { trash = [] } = await getLocal("trash");
    const [script] = scripts.splice(index, 1);
    return commit(scripts, { trash: [{ ...script, enabled: false, deletedAt: Date.now() }, ...trash] });
  },

  async restore({ id }, scripts) {
    const { trash = [] } = await getLocal("trash");
    const script = trash.find(item => item.id === id);
    if (!script) throw new Error("This script is no longer in the Trash.");
    const { deletedAt, ...restored } = script;
    return commit([...scripts, restored], { trash: trash.filter(item => item.id !== id) });
  },

  async purge({ id }, scripts) {
    const { trash = [] } = await getLocal("trash");
    const removed = trash.filter(item => !id || item.id === id);
    await chrome.storage.local.set({ trash: trash.filter(item => id && item.id !== id) });
    await chrome.storage.local.remove(removed.flatMap(item => [`values:${item.id}`, `deps:${item.id}`]));
    return reconcile(scripts);
  },

  async move({ offset }, scripts, index) {
    const target = index + Math.sign(offset);
    if (index === -1 || target < 0 || target >= scripts.length) return reconcile(scripts);
    [scripts[index], scripts[target]] = [scripts[target], scripts[index]];
    return commit(scripts);
  },

  async label({ savedAt, label }, scripts, index) {
    const script = scripts[index];
    if (!script?.history?.some(item => item.savedAt === savedAt)) throw new Error("This version is no longer in the history.");
    const text = String(label ?? "").trim().slice(0, 80);
    const history = script.history.map(item => {
      if (item.savedAt !== savedAt) return item;
      const { label: previous, ...rest } = item;
      return text ? { ...rest, label: text } : rest;
    });
    scripts[index] = { ...script, history };
    await writeScripts(scripts);
    return reconcile(scripts);
  },

  async settings({ patch }, scripts) {
    const settings = await readSettings();
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === settingTypes[key]) settings[key] = value;
    }
    await chrome.storage.local.set({ settings });
    if (patch.syncBackup) await backup(scripts);
    return reconcile(scripts);
  },

  async "clear-values"({ id }, scripts) {
    await chrome.storage.local.remove(`values:${id}`);
    return reconcile(scripts);
  }
};

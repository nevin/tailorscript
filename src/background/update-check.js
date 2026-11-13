// Background and manual update checks. Network checks run outside the write queue; the results are applied in one queued write.
import { readScripts } from "../shared/storage.js";
import { parseSource } from "../shared/userscript.js";
import { resolveDeps } from "./dependencies.js";
import { commit, storedDeps, withHistory } from "./library.js";
import { enqueue } from "./queue.js";
import { fetchUpdate, reviewReasons, sourceHash, updateUrls } from "./updates.js";

export const updateMinutes = 720;

function checkable(script) {
  try {
    return Boolean(updateUrls(script).check);
  } catch {
    return false;
  }
}

export async function scheduleUpdates() {
  if (!chrome.alarms || await chrome.alarms.get("updates")) return;
  await chrome.alarms.create("updates", { delayInMinutes: 5, periodInMinutes: updateMinutes });
}

export async function checkUpdates(ids, { manual = false } = {}) {
  const scripts = (await readScripts()).filter(script => (!ids || ids.includes(script.id)) &&
    (manual || script.autoUpdate !== false) && checkable(script));
  const results = [];
  for (const script of scripts) {
    const result = { id: script.id, source: script.source };
    try {
      result.found = await fetchUpdate(script);
      if (result.found?.source) {
        const edited = Boolean(script.installedHash) && script.installedHash !== await sourceHash(script.source);
        result.reasons = reviewReasons(parseSource(script.source), result.found.metadata,
          { edited, autoUpdate: script.autoUpdate, urls: result.found.urls });
        if (!result.reasons.length) {
          try {
            result.deps = await resolveDeps(result.found.metadata, await storedDeps(script.id));
          } catch (error) {
            result.reasons.push(error.message);
          }
        }
      }
    } catch (error) {
      result.error = error.message;
    }
    results.push(result);
  }

  return enqueue(async () => {
    const latest = await readScripts();
    const extra = {};
    const summary = { checked: 0, updated: [], waiting: [], failed: [] };
    const now = Date.now();
    for (const result of results) {
      const index = latest.findIndex(script => script.id === result.id);
      if (index === -1 || latest[index].source !== result.source) continue;
      const { pendingUpdate, ...rest } = latest[index];
      /** @type {import("../shared/types.js").Script} */
      const script = rest;
      summary.checked++;
      script.updateCheck = { at: now, skipped: script.updateCheck?.skipped,
        ...(result.found?.version ? { latest: result.found.version } : {}), ...(result.error ? { error: result.error } : {}) };
      if (result.error) {
        summary.failed.push(script.name);
        if (pendingUpdate) script.pendingUpdate = pendingUpdate;
      } else if (result.deps) {
        Object.assign(script, {
          source: result.found.source, name: result.found.metadata.name, history: withHistory(latest[index], result.found.source),
          updatedAt: now, installedHash: await sourceHash(result.found.source)
        });
        extra[`deps:${script.id}`] = result.deps;
        summary.updated.push(script.name);
      } else if (result.found?.source) {
        script.pendingUpdate = { source: result.found.source, version: result.found.version, reasons: result.reasons, foundAt: now };
        summary.waiting.push(script.name);
      }
      latest[index] = script;
    }
    return { ...await commit(latest, extra), updateSummary: summary };
  });
}

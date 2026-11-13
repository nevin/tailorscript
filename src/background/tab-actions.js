// Work the popup asks for in a specific tab: running a script now and running its menu commands.
import { getSession, readScripts } from "../shared/storage.js";
import { enableMessaging, injectionFor } from "./registration.js";

// Runs a stored script once in a tab, whether or not it is enabled or matches the page.
export async function runNow({ id, tabId }) {
  const script = (await readScripts()).find(item => item.id === id);
  if (!script) throw new Error("This script no longer exists.");
  const { metadata, js, world, worldId } = await injectionFor(script);
  if (worldId) await enableMessaging(worldId);
  await chrome.userScripts.execute({
    target: { tabId, allFrames: metadata.allFrames }, js, world, ...(worldId ? { worldId } : {}), injectImmediately: true
  });
  return getSession("registrationState").then(({ registrationState }) => registrationState);
}

// Calls back into a script's own world, for menu commands and notification clicks.
/**
 * @param {{ tabId: number, documentId?: string, frameId?: number }} target
 * @param {string} scriptId
 * @param {string} kind
 * @param {string} callbackId
 */
export function callInPage({ tabId, documentId, frameId = 0 }, scriptId, kind, callbackId) {
  return chrome.userScripts.execute({
    target: { tabId, ...(documentId ? { documentIds: [documentId] } : { frameIds: [frameId] }) },
    world: "USER_SCRIPT",
    worldId: scriptId,
    js: [{ code: `globalThis[Symbol.for("tailorscript.callback")]?.(${JSON.stringify(kind)}, ${JSON.stringify(callbackId)});` }]
  });
}

export async function runMenuCommand({ tabId, id, commandId }) {
  const { tabRuns = {} } = await getSession("tabRuns");
  const command = tabRuns[tabId]?.menus?.[id]?.find(item => item.commandId === commandId);
  if (!command) throw new Error("This command is no longer available. Reload the page.");
  await callInPage({ tabId, documentId: command.documentId, frameId: command.frameId }, id, "menu", commandId);
}

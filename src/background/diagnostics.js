// A snapshot of the extension's state for bug reports. It names scripts but never includes their source or stored values.
import { getLocal, getSession, readScripts, readSettings } from "../shared/storage.js";

export async function collectDiagnostics() {
  const [scripts, settings, { schemaVersion = 1 }, session, permissions] = await Promise.all([
    readScripts(), readSettings(), getLocal("schemaVersion"),
    getSession(["registrationState", "runs"]), chrome.permissions.getAll()
  ]);
  let registered = null;
  let userScripts = "available";
  try {
    registered = (await chrome.userScripts.getScripts()).length;
  } catch (error) {
    userScripts = error.message;
  }
  const names = Object.fromEntries(scripts.map(script => [script.id, script.name]));
  const runs = session.runs ?? {};
  return {
    version: chrome.runtime.getManifest().version,
    browser: navigator.userAgent,
    schemaVersion,
    userScripts,
    paused: Boolean(settings.paused),
    scripts: { total: scripts.length, enabled: scripts.filter(script => script.enabled).length, registered },
    siteAccess: permissions.origins ?? [],
    issues: Object.entries(session.registrationState?.issues ?? {}).map(([id, issue]) => ({ script: names[id] ?? id, issue })),
    recentErrors: Object.entries(runs).filter(([, run]) => run.error)
      .map(([id, run]) => ({ script: names[id] ?? id, ...run.error }))
      .sort((a, b) => b.at - a.at).slice(0, 10)
  };
}

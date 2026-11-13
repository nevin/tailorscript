import { originsFor, parseSource, valueGrants } from "../shared/userscript.js";

// Runs as its own script in the userscript's world, so the user's directive prologue and line numbers stay intact.
// Everything stays inside the closure except the granted APIs, which avoids clashing with the user's globals.
function prelude(id, grants) {
  const values = valueGrants.filter(grant => grants.includes(grant)).map(grant => ({
    "GM.getValue": `getValue: async (key, fallback) => { const result = await value("get", key); return result === undefined ? fallback : result; }`,
    "GM.setValue": `setValue: async (key, data) => { await value("set", key, data); }`,
    "GM.deleteValue": `deleteValue: async key => { await value("delete", key); }`,
    "GM.listValues": `listValues: () => value("list")`
  })[grant]);
  return `(() => {
  const send = message => chrome.runtime.sendMessage({ id: ${JSON.stringify(id)}, ...message });
  const report = message => { try { send(message).catch(() => {}); } catch {} };
  report({ type: "run" });
  addEventListener("error", event => report({ type: "error", message: event.message, line: event.lineno, column: event.colno }));
  addEventListener("unhandledrejection", event => report({ type: "error", message: String(event.reason?.message ?? event.reason) }));
${grants.includes("GM_addStyle") ? `  globalThis.GM_addStyle = css => {
    const style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).append(style);
    return style;
  };
` : ""}${values.length ? `  const value = async (op, key, data) => {
    const reply = await send({ type: "value", op, key, value: data });
    if (reply?.error) throw new Error(reply.error);
    return reply?.value;
  };
  globalThis.GM = Object.freeze({ ${values.join(", ")} });
` : ""}})();`;
}

export async function syncScripts(scripts, settings = {}) {
  const issues = Object.create(null);
  const enabled = settings.paused ? [] : scripts.filter(script => script.enabled);

  let api;
  let current;
  try {
    api = chrome.userScripts;
    await api.configureWorld({ messaging: true });
    current = (await api.getScripts()).map(({ id }) => id);
  } catch {
    return {
      active: [],
      issues,
      error: "Check Allow User Scripts in Chrome’s extension details, then reopen this page to retry."
    };
  }

  const registrations = [];
  for (const script of enabled) {
    try {
      const { matches, excludeMatches, runAt, grants, allFrames } = parseSource(script.source);
      if (!await chrome.permissions.contains({ origins: originsFor(matches) })) {
        issues[script.id] = "Site access is missing. Save the enabled script to request access again.";
        continue;
      }
      registrations.push({
        id: script.id, matches, excludeMatches, runAt, allFrames,
        world: "USER_SCRIPT", worldId: script.id,
        js: [{ code: prelude(script.id, grants) }, { code: script.source }]
      });
    } catch (error) {
      issues[script.id] = error.message;
    }
  }

  // Chrome injects scripts with the same timing in registration order, so a reordered library re-registers everything.
  const desired = registrations.map(({ id }) => id);
  const kept = current.filter(id => desired.includes(id));
  const inOrder = kept.join("\n") === desired.slice(0, kept.length).join("\n");
  const registered = new Set(inOrder ? kept : []);
  const errors = [];
  for (const id of current) {
    if (registered.has(id)) continue;
    try {
      await api.unregister({ ids: [id] });
    } catch (error) {
      errors.push(`Chrome could not remove a registration: ${error.message}`);
    }
  }

  const active = [];
  for (const registration of registrations) {
    try {
      if (registered.has(registration.id)) await api.update([registration]);
      else await api.register([registration]);
      active.push(registration.id);
    } catch (error) {
      issues[registration.id] = error.message;
      if (!registered.has(registration.id)) continue;
      try {
        await api.unregister({ ids: [registration.id] });
      } catch (cleanup) {
        const { name } = scripts.find(script => script.id === registration.id);
        errors.push(`Chrome could not remove the previous registration for ${name}: ${cleanup.message}`);
      }
    }
  }

  return { active, issues, error: errors.join(" ") };
}

import { allows, grantFamilies, originsFor, parseSource, syncValueGrants } from "../shared/userscript.js";
import { channelFor, tokenFor } from "./bridge-token.js";
import { installBridge } from "./bridge.js";
import { installRuntime } from "./userscript-runtime.js";
import { getLocal } from "../shared/storage.js";

function regExpList(rules) {
  return `[${rules.map(({ source, flags }) => `new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)})`).join(", ")}]`;
}

// Regular-expression @include and @exclude rules can't be registered with Chrome, so the body checks them first.
// The check shares the script's first line, which keeps reported line numbers unchanged.
function guarded(source, guard) {
  if (!guard) return source;
  const strict = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*(["'])use strict\1/.test(source);
  const include = guard.include ? `${regExpList(guard.include)}.some(rule => rule.test(href))` : "true";
  const check = `(href => ${include} && !${regExpList(guard.exclude)}.some(rule => rule.test(href)))(location.href.replace(/#.*$/, ""))`;
  return `(function () {${strict ? ' "use strict";' : ""} if (!${check}) return; ${source}\n}).call(this);`;
}

// Page-world scripts get their APIs as local names from a wrapper rather than as page globals. The wrapper takes them
// from where the runtime left them, removes them from the page, and reports errors the script throws. It shares the
// script's first and last lines, so reported line numbers don't move.
function inPage(source, names, handoff) {
  const strict = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*(["'])use strict\1/.test(source);
  return `(function (__tailorscript) {${strict ? ' "use strict";' : ""} const { ${names.join(", ")} } = __tailorscript.api; try { ${source}\n} catch (error) { __tailorscript.failed(error); throw error; } })` +
    `.call(window, (bag => (delete window[${JSON.stringify(handoff)}], bag ?? { api: {}, failed() {} }))(window[${JSON.stringify(handoff)}]));`;
}

/**
 * @param {import("../shared/types.js").Script} script
 * @param {import("../shared/types.js").Metadata} metadata
 * @param {{ deps?: import("../shared/types.js").Deps, values?: Record<string, unknown>, token?: string, channel?: string }} [stored]
 *   token proves the script's identity to the service worker. Page-world scripts never get it: their bridge, which
 *   runs in the script's isolated world and shares channel with it, holds it instead.
 * @returns {{ world: "MAIN" | "USER_SCRIPT", worldId?: string,
 *   js: [chrome.userScripts.ScriptSource, ...chrome.userScripts.ScriptSource[]],
 *   bridge?: { worldId: string, js: [chrome.userScripts.ScriptSource] } }}
 */
export function buildInjection(script, metadata, { deps = {}, values, token, channel } = {}) {
  if (deps.error) throw new Error(deps.error);
  const requires = metadata.requires.map(url => {
    const entry = deps.requires?.find(item => item.url === url);
    if (!entry) throw new Error(`${url} hasn’t been downloaded. Save the script again to fetch its @require files.`);
    return { code: entry.code };
  });
  const resources = Object.fromEntries(metadata.resources.map(({ name, url }) => {
    const entry = deps.resources?.find(item => item.name === name && item.url === url);
    if (!entry) throw new Error(`@resource ${name} hasn’t been downloaded. Save the script again to fetch it.`);
    return [name, entry.dataUrl];
  }));
  const page = metadata.injectInto === "page";
  const bridged = page && Boolean(channel && token);
  const handoff = `__tailorscript_${(channel ?? script.id).replace(/\W/g, "_")}`;
  const config = {
    id: script.id,
    page,
    token: page ? undefined : token,
    ...(page ? { handoff, ...(bridged ? { channel } : {}) } : {}),
    allowed: Object.keys(grantFamilies).filter(family => allows(metadata.grants, family)),
    values: metadata.grants.some(grant => syncValueGrants.includes(grant)) ? values ?? {} : null,
    resources,
    info: {
      uuid: script.id,
      scriptHandler: "Tailorscript",
      version: chrome.runtime.getManifest?.().version ?? "",
      injectInto: page ? "page" : "content",
      scriptMetaStr: metadata.headerText,
      script: {
        name: metadata.name, namespace: metadata.namespace, version: metadata.version, description: metadata.description,
        author: metadata.author, homepage: metadata.homepage, matches: metadata.matches, excludes: metadata.excludes,
        includes: metadata.includes, excludeMatches: metadata.excludeMatches, grant: metadata.grants, connects: metadata.connects,
        requires: metadata.requires, resources: metadata.resources, "run-at": metadata.runAt.replace("_", "-")
      }
    }
  };
  const body = guarded(script.source, metadata.targets.guard);
  // The names the wrapper gives a page-world script: GM, GM_info and the granted APIs that are plain identifiers.
  const names = ["GM", "GM_info", ...new Set(config.allowed.flatMap(family => grantFamilies[family])
    .filter(name => /^[A-Za-z_$][\w$]*$/.test(name) && name !== "GM_info"))];
  return {
    world: page ? "MAIN" : "USER_SCRIPT",
    ...(page ? {} : { worldId: script.id }),
    js: [{ code: `(${installRuntime})(${JSON.stringify(config)});` }, ...requires, { code: page ? inPage(body, names, handoff) : body }],
    ...(bridged ? { bridge: { worldId: script.id, js: [{ code: `(${installBridge})(${JSON.stringify({ id: script.id, token, channel })});` }] } } : {})
  };
}

async function storedExtras(scripts) {
  const keys = scripts.flatMap(script => [`deps:${script.id}`, `values:${script.id}`]);
  return keys.length ? getLocal(keys) : {};
}

// Everything Chrome needs to run one script now, used by Run now in the popup.
export async function injectionFor(script) {
  const metadata = parseSource(script.source);
  const stored = await storedExtras([script]);
  return {
    metadata,
    ...buildInjection(script, metadata, { deps: stored[`deps:${script.id}`], values: stored[`values:${script.id}`],
      token: await tokenFor(script.id), channel: await channelFor(script.id) })
  };
}

// Each script runs in its own world, and Chrome only gives a world chrome.runtime.sendMessage once that world is
// configured for messaging. The default world's setting doesn't carry over to worlds with an ID.
export function enableMessaging(worldId) {
  return chrome.userScripts.configureWorld({ worldId, messaging: true });
}

// Forgets the settings of worlds whose scripts are gone or no longer registered.
async function resetUnusedWorlds(api, used) {
  try {
    const configured = await api.getWorldConfigurations?.() ?? [];
    for (const { worldId } of configured) {
      if (worldId && !used.has(worldId)) await api.resetWorldConfiguration(worldId);
    }
  } catch (error) {
    console.warn(error.message);
  }
}

// Chrome may omit empty lists or report default values for optional fields.
function sameList(before = [], after = []) {
  return before.length === after.length && before.every((value, index) => value === after[index]);
}

function sameRegistration(before, after) {
  return (before.world ?? "USER_SCRIPT") === after.world &&
    before.worldId === after.worldId &&
    (before.runAt ?? "document_idle") === after.runAt &&
    Boolean(before.allFrames) === after.allFrames &&
    sameList(before.matches, after.matches) &&
    sameList(before.excludeMatches, after.excludeMatches) &&
    sameList(before.includeGlobs, after.includeGlobs) &&
    sameList(before.excludeGlobs, after.excludeGlobs) &&
    before.js?.length === after.js.length &&
    before.js.every((part, index) => part.code === after.js[index].code && part.file === after.js[index].file);
}

const bridgeSuffix = "::bridge";
const scriptIdOf = registrationId => registrationId.endsWith(bridgeSuffix) ? registrationId.slice(0, -bridgeSuffix.length) : registrationId;

export async function syncScripts(scripts, settings = {}) {
  const issues = Object.create(null);
  const manual = [];
  const enabled = settings.paused ? [] : scripts.filter(script => script.enabled);

  let api;
  let current;
  try {
    api = chrome.userScripts;
    await api.configureWorld({ messaging: true });
    current = await api.getScripts();
  } catch {
    return {
      active: [],
      manual,
      issues,
      setupNeeded: true,
      error: "Chrome is blocking userscripts. Turn on Allow User Scripts in Tailorscript’s extension details."
    };
  }

  const stored = await storedExtras(enabled);
  const registrations = [];
  for (const script of enabled) {
    try {
      const metadata = parseSource(script.source);
      if (metadata.runAt === "manual") {
        manual.push(script.id);
        continue;
      }
      const { targets } = metadata;
      if (!await chrome.permissions.contains({ origins: originsFor(targets.matches) })) {
        issues[script.id] = "Site access is missing. Save the enabled script to request access again.";
        continue;
      }
      const where = {
        matches: targets.matches,
        excludeMatches: targets.excludeMatches,
        ...(targets.includeGlobs.length ? { includeGlobs: targets.includeGlobs } : {}),
        ...(targets.excludeGlobs.length ? { excludeGlobs: targets.excludeGlobs } : {}),
        runAt: metadata.runAt,
        allFrames: metadata.allFrames
      };
      const { bridge, ...injection } = buildInjection(script, metadata, { deps: stored[`deps:${script.id}`],
        values: stored[`values:${script.id}`], token: await tokenFor(script.id), channel: await channelFor(script.id) });
      // A page-world script's bridge is registered just before it, with the same sites and timing.
      if (bridge) registrations.push({ id: `${script.id}${bridgeSuffix}`, ...where, world: /** @type {const} */ ("USER_SCRIPT"), ...bridge });
      registrations.push({ id: script.id, ...where, ...injection });
    } catch (error) {
      issues[script.id] = error.message;
    }
  }

  // Chrome injects scripts with the same timing in registration order, so a reordered library re-registers everything.
  // update() keeps fields it isn't given, so dropping globs or changing worlds also needs a fresh registration.
  const desired = new Map(registrations.map(registration => [registration.id, registration]));
  const previous = new Map(current.map(registration => [registration.id, registration]));
  const kept = current.filter(({ id }) => desired.has(id));
  const inOrder = kept.every(({ id }, index) => id === registrations[index].id);
  const reshaped = kept.some(old => {
    const next = desired.get(old.id);
    return (old.world ?? "USER_SCRIPT") !== next.world || (old.includeGlobs?.length && !next.includeGlobs) ||
      (old.excludeGlobs?.length && !next.excludeGlobs);
  });
  const registered = new Set(inOrder && !reshaped ? kept.map(({ id }) => id) : []);
  const errors = [];
  for (const { id } of current) {
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
      if (registration.worldId) await enableMessaging(registration.worldId);
      if (!registered.has(registration.id)) await api.register([registration]);
      else if (!sameRegistration(previous.get(registration.id), registration)) await api.update([registration]);
      if (!registration.id.endsWith(bridgeSuffix)) active.push(registration.id);
    } catch (error) {
      issues[scriptIdOf(registration.id)] = error.message;
      if (!registered.has(registration.id)) continue;
      try {
        await api.unregister({ ids: [registration.id] });
      } catch (cleanup) {
        const { name } = scripts.find(script => script.id === scriptIdOf(registration.id));
        errors.push(`Chrome could not remove the previous registration for ${name}: ${cleanup.message}`);
      }
    }
  }

  // Manual scripts keep their world so Run now doesn't have to set it up each time.
  await resetUnusedWorlds(api, new Set([...active, ...manual]));
  return { active, manual, issues, error: errors.join(" ") };
}

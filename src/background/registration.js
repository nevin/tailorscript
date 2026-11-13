import { allows, grantFamilies, originsFor, parseSource, syncValueGrants } from "../shared/userscript.js";
import { tokenFor } from "./bridge-token.js";
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

/**
 * @param {import("../shared/types.js").Script} script
 * @param {import("../shared/types.js").Metadata} metadata
 * @param {{ deps?: import("../shared/types.js").Deps, values?: Record<string, unknown>, token?: string }} [stored]
 *   token proves the script's identity to the service worker; page-world scripts never get one.
 * @returns {{ world: "MAIN" | "USER_SCRIPT", worldId?: string,
 *   js: [chrome.userScripts.ScriptSource, ...chrome.userScripts.ScriptSource[]] }}
 */
export function buildInjection(script, metadata, { deps = {}, values, token } = {}) {
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
  const config = {
    id: script.id,
    page,
    token: page ? undefined : token,
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
  return {
    world: page ? "MAIN" : "USER_SCRIPT",
    ...(page ? {} : { worldId: script.id }),
    js: [{ code: `(${installRuntime})(${JSON.stringify(config)});` }, ...requires, { code: guarded(script.source, metadata.targets.guard) }]
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
    ...buildInjection(script, metadata,
      { deps: stored[`deps:${script.id}`], values: stored[`values:${script.id}`], token: await tokenFor(script.id) })
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
      registrations.push({
        id: script.id,
        matches: targets.matches,
        excludeMatches: targets.excludeMatches,
        ...(targets.includeGlobs.length ? { includeGlobs: targets.includeGlobs } : {}),
        ...(targets.excludeGlobs.length ? { excludeGlobs: targets.excludeGlobs } : {}),
        runAt: metadata.runAt,
        allFrames: metadata.allFrames,
        ...buildInjection(script, metadata,
          { deps: stored[`deps:${script.id}`], values: stored[`values:${script.id}`], token: await tokenFor(script.id) })
      });
    } catch (error) {
      issues[script.id] = error.message;
    }
  }

  // Chrome injects scripts with the same timing in registration order, so a reordered library re-registers everything.
  // update() keeps fields it isn't given, so dropping globs or changing worlds also needs a fresh registration.
  const desired = registrations.map(({ id }) => id);
  const kept = current.filter(({ id }) => desired.includes(id));
  const inOrder = kept.map(({ id }) => id).join("\n") === desired.slice(0, kept.length).join("\n");
  const reshaped = kept.some(old => {
    const next = registrations.find(({ id }) => id === old.id);
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

  // Manual scripts keep their world so Run now doesn't have to set it up each time.
  await resetUnusedWorlds(api, new Set([...active, ...manual]));
  return { active, manual, issues, error: errors.join(" ") };
}

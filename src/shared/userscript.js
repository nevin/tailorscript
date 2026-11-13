const timings = { "document-start": "document_start", "document-end": "document_end", "document-body": "document_end", "document-idle": "document_idle" };

// Each API family lists the grant spellings that turn it on. Scripts written for other managers use either style.
export const grantFamilies = {
  addStyle: ["GM_addStyle", "GM.addStyle"],
  getValue: ["GM.getValue", "GM_getValue"],
  setValue: ["GM.setValue", "GM_setValue"],
  deleteValue: ["GM.deleteValue", "GM_deleteValue"],
  listValues: ["GM.listValues", "GM_listValues"],
  xhr: ["GM_xmlhttpRequest", "GM.xmlHttpRequest"],
  menu: ["GM_registerMenuCommand", "GM.registerMenuCommand", "GM_unregisterMenuCommand", "GM.unregisterMenuCommand"],
  notification: ["GM_notification", "GM.notification"],
  clipboard: ["GM_setClipboard", "GM.setClipboard"],
  openInTab: ["GM_openInTab", "GM.openInTab"],
  resources: ["GM_getResourceText", "GM.getResourceText", "GM_getResourceURL", "GM.getResourceUrl"],
  info: ["GM_info", "GM.info"],
  unsafeWindow: ["unsafeWindow"],
  window: ["window.close", "window.focus"]
};
export const supportedGrants = ["none", ...Object.values(grantFamilies).flat()];
// Synchronous value getters need a snapshot of stored values when the script starts.
export const syncValueGrants = ["GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues"];
const pageGrants = ["none", "unsafeWindow", ...grantFamilies.addStyle, ...grantFamilies.info, ...grantFamilies.window];

export function allows(grants, family) {
  return grantFamilies[family].some(grant => grants.includes(grant));
}

const matchPattern = /^(https?|\*):\/\/(?:\*|(?:\*\.)?[a-z\d-]+(?:\.[a-z\d-]+)*)\/\S*$/i;
const allSites = "*://*/*";

function escapeRegExp(text) {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob) {
  return `^${glob.split("*").map(escapeRegExp).join(".*")}$`;
}

function matchToRegExp(pattern) {
  const [, scheme, host, path] = pattern.match(/^(.*?):\/\/([^/]+)(\/.*)$/);
  const hostPart = host === "*" ? "[^/]*"
    : host.startsWith("*.") ? `(?:[^/]*\\.)?${escapeRegExp(host.slice(2))}` : escapeRegExp(host);
  return `^${scheme === "*" ? "https?" : scheme}://${hostPart}(?::\\d+)?${path.split("*").map(escapeRegExp).join(".*")}$`;
}

function matchToGlobs(pattern) {
  const [, scheme, host, path] = pattern.match(/^(.*?):\/\/([^/]+)(\/.*)$/);
  const prefix = scheme === "*" ? "http*" : scheme;
  if (!host.startsWith("*.")) return [`${prefix}://${host}${path}`];
  return [`${prefix}://${host}${path}`, `${prefix}://${host.slice(2)}${path}`];
}

// @include and @exclude accept globs, "*", and /regular expressions/. Chrome registers on match patterns and globs,
// so regular expressions fall back to a broad registration plus a check before the script body runs.
function parseRule(rule) {
  const regex = rule.match(/^\/(.+)\/([a-z]*)$/);
  if (regex) {
    try {
      new RegExp(regex[1], regex[2]);
    } catch (error) {
      throw new Error(`Invalid regular expression in ${rule}: ${error.message}`, { cause: error });
    }
    return { regex: { source: regex[1], flags: regex[2].includes("i") ? "i" : "" }, match: allSites };
  }
  if (rule === "*") return { glob: "*", match: allSites };
  const glob = rule.replace(/\.tld(?=[/:]|$)/i, ".*");
  const parts = glob.match(/^(\*|https?|http\*):\/\/([^/]*)(?:\/.*)?$/i);
  if (!parts) return { glob, match: allSites };
  const scheme = /^https?$/i.test(parts[1]) ? parts[1].toLowerCase() : "*";
  const host = parts[2].replace(/:\d+$/, "").toLowerCase();
  const exactHost = host && !host.slice(host.startsWith("*.") ? 2 : 0).includes("*") ? host : "*";
  return { glob, match: `${scheme}://${exactHost}/*` };
}

function buildTargets(declaredMatches, includes, excludes, excludeMatches) {
  if (!includes.length) {
    return { matches: declaredMatches, excludeMatches, includeGlobs: [], excludeGlobs: [], guard: null, ...excludeRules(excludes) };
  }
  const rules = includes.map(parseRule);
  const matches = [...new Set([...declaredMatches, ...rules.map(rule => rule.match)])];
  if (rules.some(rule => rule.regex)) {
    const include = [
      ...declaredMatches.map(pattern => ({ source: matchToRegExp(pattern), flags: "" })),
      ...rules.map(rule => rule.regex ?? { source: globToRegExp(rule.glob), flags: "" })
    ];
    const { excludeGlobs, guardExclude } = excludeRules(excludes);
    return { matches, excludeMatches, includeGlobs: [], excludeGlobs, guard: { include, exclude: guardExclude } };
  }
  const includeGlobs = [...new Set([...declaredMatches.flatMap(matchToGlobs), ...rules.map(rule => rule.glob)])];
  return { matches, excludeMatches, includeGlobs, guard: null, ...excludeRules(excludes) };
}

function excludeRules(excludes) {
  const rules = excludes.map(parseRule);
  const excludeGlobs = rules.filter(rule => rule.glob).map(rule => rule.glob);
  const guardExclude = rules.filter(rule => rule.regex).map(rule => rule.regex);
  return { excludeGlobs, guardExclude };
}

function finishTargets(targets) {
  const { guardExclude, ...rest } = targets;
  if (rest.guard || !guardExclude?.length) return rest;
  return { ...rest, guard: { include: null, exclude: guardExclude } };
}

function isWebUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function connectOrigins(connects) {
  return connects.flatMap(value => {
    const host = value.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[:/].*$/, "");
    if (!host || host === "self") return [];
    if (host === "*") return [allSites];
    if (/^[\d.]+$/.test(host) || host === "localhost" || !host.includes(".")) return [`*://${host}/*`];
    return [`*://${host}/*`, `*://*.${host}/*`];
  });
}

export function parseSource(source) {
  const header = source.match(/^\s*\/\/\s*==UserScript==[^\n]*\n([\s\S]*?)^\s*\/\/\s*==\/UserScript==[^\n]*/m);
  const metadata = new Map();

  for (const line of (header?.[1] ?? "").split("\n")) {
    const entry = line.trim().match(/^\s*\/\/\s*@([\w:.-]+)(?:\s+(.*))?$/);
    if (!entry) continue;
    const [, key, value = ""] = entry;
    const values = metadata.get(key) ?? [];
    values.push(value.trim());
    metadata.set(key, values);
  }
  const first = key => metadata.get(key)?.[0] || "";
  const all = key => (metadata.get(key) ?? []).filter(Boolean);

  const declared = [...new Set(all("grant"))];
  const grants = declared.length > 1 ? declared.filter(grant => grant !== "none") : declared;
  const unsupportedGrants = grants.filter(grant => !supportedGrants.includes(grant));
  if (metadata.has("all-frames") && metadata.has("noframes")) {
    throw new Error("Use either @all-frames or @noframes, not both.");
  }

  const declaredMatches = [];
  const includes = all("include");
  for (const pattern of all("match")) {
    if (pattern === "<all_urls>") declaredMatches.push(allSites);
    else if (/^http\*:\/\//i.test(pattern)) includes.push(pattern);
    else declaredMatches.push(pattern);
  }
  const excludeMatches = all("exclude-match");
  if (!declaredMatches.length && !includes.length) {
    throw new Error("Add an @match line for the site where this script should run.");
  }
  for (const pattern of [...declaredMatches, ...excludeMatches]) {
    if (!matchPattern.test(pattern)) throw new Error(`Invalid HTTP(S) match pattern: ${pattern}`);
  }
  const targets = finishTargets(buildTargets(declaredMatches, includes, all("exclude"), excludeMatches));

  const runAt = first("run-at") || "document-idle";
  const manual = runAt === "context-menu";
  if (!manual && !timings[runAt]) throw new Error(`Unsupported @run-at: ${runAt}`);
  const injectInto = ["page"].includes(first("inject-into")) || first("sandbox") === "raw" ? "page" : "content";
  if (injectInto === "page" && grants.some(grant => !pageGrants.includes(grant))) {
    throw new Error("Scripts injected into the page can only use @grant none, GM_addStyle, GM_info or unsafeWindow.");
  }

  const requires = all("require");
  for (const url of requires) {
    if (!isWebUrl(url)) throw new Error(`@require needs an http or https URL: ${url}`);
  }
  const resources = all("resource").map(value => {
    const [name, url] = value.split(/\s+/);
    if (!name || !url || !(isWebUrl(url) || url.startsWith("data:"))) throw new Error(`Use @resource name https://url, not: ${value}`);
    return { name, url };
  });
  if (new Set(resources.map(({ name }) => name)).size !== resources.length) throw new Error("Each @resource needs a unique name.");

  if (!source.slice((header?.index ?? 0) + (header?.[0].length ?? 0)).trim()) {
    throw new Error("Add JavaScript below the metadata header.");
  }

  const connects = all("connect");
  const updateUrl = [first("updateURL"), first("downloadURL")].find(isWebUrl) ?? "";
  const downloadUrl = [first("downloadURL"), first("updateURL")].find(url => isWebUrl(url) && /\.user\.js(\?|$)/.test(url)) ?? "";
  return {
    name: first("name") || "Untitled script",
    namespace: first("namespace"),
    version: first("version"),
    description: first("description"),
    author: first("author"),
    homepage: [first("homepageURL"), first("homepage"), first("website"), first("source")].find(isWebUrl) ?? "",
    updateUrl,
    downloadUrl,
    matches: declaredMatches,
    excludeMatches,
    includes,
    excludes: all("exclude"),
    targets,
    origins: [...new Set([...originsFor(targets.matches), ...connectOrigins(connects)])],
    grants,
    unsupportedGrants,
    connects,
    requires,
    resources,
    runAt: manual ? "manual" : timings[runAt],
    allFrames: metadata.has("all-frames"),
    injectInto,
    tags: [...new Set(all("tag").flatMap(value => value.split(/[\s,]+/)).filter(Boolean))],
    headerText: header?.[0] ?? ""
  };
}

export function originsFor(matches) {
  return [...new Set(matches.map(pattern => pattern.match(/^[^:]+:\/\/[^/]+/)[0] + "/*"))];
}

export function matchesUrl(pattern, url) {
  const [, scheme, host, path] = pattern.match(/^(.*?):\/\/([^/]+)(\/.*)$/);
  if (scheme !== "*" && url.protocol !== scheme.toLowerCase() + ":") return false;
  const domain = host.toLowerCase();
  const hostname = url.hostname;
  if (domain !== "*" && domain !== hostname &&
      !(domain.startsWith("*.") && (hostname === domain.slice(2) || hostname.endsWith(domain.slice(1))))) return false;
  const escaped = path.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${escaped}$`).test(url.pathname + url.search);
}

// Chrome globs treat * as any run of characters and ? as one character.
export function globMatches(glob, href) {
  const pattern = glob.split("").map(char => char === "*" ? ".*" : char === "?" ? "." : escapeRegExp(char)).join("");
  return new RegExp(`^${pattern}$`).test(href);
}

export function guardAllows(guard, href) {
  if (!guard) return true;
  const test = ({ source, flags }) => new RegExp(source, flags).test(href);
  return (!guard.include || guard.include.some(test)) && !guard.exclude.some(test);
}

export function targetsMatch(targets, url) {
  const href = url.href.replace(/#.*$/, "");
  return targets.matches.some(pattern => matchesUrl(pattern, url)) &&
    !targets.excludeMatches.some(pattern => matchesUrl(pattern, url)) &&
    (!targets.includeGlobs.length || targets.includeGlobs.some(glob => globMatches(glob, href))) &&
    !targets.excludeGlobs.some(glob => globMatches(glob, href)) &&
    guardAllows(targets.guard, href);
}

export function runsOn(source, url) {
  try {
    return targetsMatch(parseSource(source).targets, url);
  } catch {
    return false;
  }
}

// Numeric parts compare as numbers, so 1.10 is newer than 1.9. Missing parts count as zero.
export function compareVersions(a, b) {
  const split = value => String(value ?? "").split(/[.+-]/);
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const [x = "0", y = "0"] = [left[index], right[index]];
    const [nx, ny] = [Number(x), Number(y)];
    const result = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (result) return Math.sign(result);
  }
  return 0;
}

const headerLine = (key, value) => `// ${`@${key}`.padEnd(12)} ${value}`.trimEnd();

// Adds one metadata line after the last line with the same key, or at the end of the block.
export function addMetadata(source, key, value) {
  const lines = source.split("\n");
  const start = lines.findIndex(line => /^\s*\/\/\s*==UserScript==\s*$/.test(line));
  const end = lines.findIndex((line, index) => index > start && /^\s*\/\/\s*==\/UserScript==\s*$/.test(line));
  if (start < 0 || end < 0) throw new Error("Add a complete metadata block first.");
  const keyPattern = new RegExp(`^\\s*//\\s*@${escapeRegExp(key)}(?:\\s|$)`);
  const last = lines.slice(start, end).findLastIndex(line => keyPattern.test(line));
  const at = last === -1 ? end : start + last + 1;
  // Line the value up with the header's existing values when there are any.
  const sample = lines.slice(start + 1, end).map(line => line.match(/^(\s*\/\/\s*@[\w:.-]+\s+)\S/)?.[1]).find(Boolean);
  const width = sample?.length ?? 0;
  const prefix = `// @${key} `;
  lines.splice(at, 0, width > prefix.length ? `${prefix.padEnd(width)}${value}` : headerLine(key, value));
  return lines.join("\n");
}

// Preserve the source body and metadata unrelated to the guided fields.
export function updateTargets(source, name, patterns) {
  const lines = source.split("\n");
  const start = lines.findIndex(line => /^\s*\/\/\s*==UserScript==\s*$/.test(line));
  const end = lines.findIndex((line, index) => index > start && /^\s*\/\/\s*==\/UserScript==\s*$/.test(line));
  if ((start < 0) !== (end < 0)) throw new Error("Complete the userscript metadata block before applying these settings.");
  const metadata = [headerLine("name", name.trim() || "Untitled script"), ...patterns.map(pattern => headerLine("match", pattern))];
  if (start < 0) return ["// ==UserScript==", ...metadata, "// ==/UserScript==", "", source].join("\n");
  const other = lines.slice(start + 1, end).filter(line => !/^\s*\/\/\s*@(name|match)(?:\s|$)/.test(line));
  return [...lines.slice(0, start + 1), ...metadata, ...other, ...lines.slice(end)].join("\n");
}

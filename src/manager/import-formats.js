// Reads what people import: Tailorscript backups, single .user.js files, and backups from other userscript managers
// (Tampermonkey and ScriptCat zip or text exports, Violentmonkey zips, and any zip of .user.js files such as
// Greasemonkey's). Each script keeps whether it was on, the values it stored, and the site rules the other manager
// added on top of the script's own header, so it runs here the way it ran there.
import { addMetadata } from "../shared/userscript.js";
import { isZip, readZip } from "../shared/zip.js";

/**
 * @typedef {object} ImportEntry
 * @property {string} source
 * @property {{ source: string, savedAt: number, label?: string }[]} history
 * @property {Record<string, unknown>} [values] Values the script stored with GM_setValue in the other manager.
 * @property {boolean} [wasEnabled] Whether the script was on in the other manager.
 * @property {string[]} notes What changed in the conversion, in plain sentences.
 */

const userJs = ".user.js";
const runAts = ["document-start", "document-body", "document-end", "document-idle", "context-menu"];

const strings = value => Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : [];

function headerBounds(lines) {
  const start = lines.findIndex(line => /^\s*\/\/\s*==UserScript==\s*$/.test(line));
  const end = lines.findIndex((line, index) => index > start && /^\s*\/\/\s*==\/UserScript==\s*$/.test(line));
  return start < 0 || end < 0 ? null : { start, end };
}

const keyLine = key => new RegExp(`^\\s*//\\s*@${key.replace(/[-.]/g, "\\$&")}(?:\\s+(.*?))?\\s*$`);

/** The values of one header key, such as every @match. */
export function headerValues(source, key) {
  const lines = source.split("\n");
  const bounds = headerBounds(lines);
  if (!bounds) return [];
  const pattern = keyLine(key);
  return lines.slice(bounds.start + 1, bounds.end).map(line => line.match(pattern)).filter(Boolean).map(match => match[1] ?? "");
}

function removeHeaderKey(source, key) {
  const lines = source.split("\n");
  const bounds = headerBounds(lines);
  if (!bounds) return source;
  const pattern = keyLine(key);
  return lines.filter((line, index) => index <= bounds.start || index >= bounds.end || !pattern.test(line)).join("\n");
}

function setHeaderKey(source, key, value) {
  return addMetadata(removeHeaderKey(source, key), key, value);
}

/**
 * Applies the per-script settings another manager keeps outside the script: extra or replaced site rules, a different
 * run-at time and frame setting.
 */
export function applyOverrides(source, overrides, manager, notes) {
  const { runAt, noframes } = overrides;
  let result = source;
  if (!headerBounds(result.split("\n"))) return result;
  let added = 0;
  for (const key of ["match", "include", "exclude"]) {
    if (overrides[`keep_${key}`] === false && headerValues(result, key).length) {
      result = removeHeaderKey(result, key);
      notes.push(`${manager} was set to ignore the script’s own @${key} lines, so they were removed.`);
    }
    for (const pattern of strings(overrides[key])) {
      if (headerValues(result, key).includes(pattern)) continue;
      result = addMetadata(result, key, pattern);
      added++;
    }
  }
  if (added) notes.push(`Added ${added} site ${added === 1 ? "rule" : "rules"} you set in ${manager}.`);
  if (runAts.includes(runAt) && headerValues(result, "run-at")[0] !== runAt) {
    result = setHeaderKey(result, "run-at", runAt);
    notes.push(`Runs at ${runAt}, as you set in ${manager}.`);
  }
  const hasNoframes = headerValues(result, "noframes").length > 0;
  if ((noframes === true || noframes === 1) && !hasNoframes) {
    result = addMetadata(removeHeaderKey(result, "all-frames"), "noframes", "");
    notes.push(`Runs only in the top-level page, as you set in ${manager}.`);
  } else if ((noframes === false || noframes === 0) && !headerValues(result, "all-frames").length) {
    result = addMetadata(removeHeaderKey(result, "noframes"), "all-frames", "");
    notes.push(`Also runs inside frames, as you set in ${manager}.`);
  }
  return result.replace(/^(\s*\/\/\s*@(?:noframes|all-frames)) +$/gm, "$1");
}

const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : undefined;

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} isn’t valid JSON.`);
  }
}

// Violentmonkey stores each value as text with a one-letter type: s for text, n for numbers, b for true or false and
// o for anything JSON.
function violentmonkeyValue(raw) {
  if (typeof raw !== "string" || !raw) return raw;
  const rest = raw.slice(1);
  if (raw[0] === "s") return rest;
  if (raw[0] === "n") return Number(rest);
  if (raw[0] === "b") return rest === "true";
  if (raw[0] === "o") {
    try {
      return JSON.parse(rest);
    } catch {
      return rest;
    }
  }
  return raw;
}

// Violentmonkey files values under each script's namespace and name, escaped the way it names files.
function violentmonkeyUri(source) {
  const raw = `${headerValues(source, "namespace")[0] ?? ""}\n${headerValues(source, "name")[0] ?? ""}\n`;
  return raw.replace(/[-\\/:*?"<>|%\s]/g, char => `-${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function entry(source, extra = {}) {
  return { source, history: [], notes: [], ...extra };
}

function fromTampermonkeyScript(source, options, storage, notes) {
  const settings = object(options?.settings) ?? {};
  const opts = object(options?.options) ?? {};
  const override = object(opts.override) ?? {};
  const converted = applyOverrides(source, {
    match: override.use_matches, include: override.use_includes, exclude: override.use_excludes,
    keep_match: override.merge_matches, keep_include: override.merge_includes, keep_exclude: override.merge_excludes,
    runAt: opts.run_at, noframes: override.noframes
  }, "Tampermonkey", notes);
  const values = object(storage?.data);
  return {
    source: converted, notes, values, wasEnabled: options ? settings.enabled !== false : undefined,
    position: Number(settings.position) || Infinity
  };
}

function fromTampermonkeyZip(files, text) {
  return [...files.keys()].filter(path => path.endsWith(userJs)).map(path => {
    const base = path.slice(0, -userJs.length);
    const notes = [];
    const read = suffix => files.has(base + suffix) ? object(parseJson(text(base + suffix), base + suffix)) : undefined;
    return entry("", fromTampermonkeyScript(text(path), read(".options.json"), read(".storage.json"), notes));
  });
}

function fromViolentmonkeyZip(files, text) {
  const data = object(parseJson(text("violentmonkey"), "The violentmonkey file")) ?? {};
  const scripts = object(data.scripts) ?? {};
  const allValues = object(data.values) ?? {};
  return [...files.keys()].filter(path => path.endsWith(userJs)).map(path => {
    const source = text(path);
    const info = object(scripts[path.slice(0, -userJs.length)]) ?? {};
    const custom = object(info.custom) ?? {};
    const notes = [];
    const converted = applyOverrides(source, {
      match: custom.match, include: custom.include, exclude: custom.exclude,
      keep_match: custom.origMatch, keep_include: custom.origInclude, keep_exclude: custom.origExclude,
      runAt: custom.runAt, noframes: custom.noframes
    }, "Violentmonkey", notes);
    const stored = object(allValues[violentmonkeyUri(source)]);
    const enabled = info.config?.enabled ?? info.enabled;
    return entry(converted, {
      notes, wasEnabled: enabled === undefined ? undefined : Boolean(enabled),
      values: stored && Object.fromEntries(Object.entries(stored).map(([key, raw]) => [key, violentmonkeyValue(raw)])),
      position: Number(info.position) || Infinity
    });
  });
}

// Tampermonkey's text export holds every script in one JSON file, with sources sometimes base64-encoded.
function fromTampermonkeyText(data) {
  return data.scripts.filter(script => object(script)).map(script => {
    let source = typeof script?.source === "string" ? script.source : "";
    if (source && !source.includes("==UserScript==")) {
      try {
        source = new TextDecoder().decode(Uint8Array.from(atob(source), char => char.charCodeAt(0)));
      } catch {
        // Not base64 either; the review reports it as a script without a header.
      }
    }
    const notes = [];
    const options = { settings: { enabled: script?.enabled, position: script?.position }, options: object(script?.options) };
    return entry("", fromTampermonkeyScript(source, options, object(script?.storage), notes));
  });
}

function fromTailorscriptBackup(data) {
  return data.scripts.map(script => {
    if (typeof script?.source !== "string") throw new Error("A script in this backup is missing its source.");
    const history = Array.isArray(script.history) ? script.history
      .filter(version => typeof version?.source === "string" && Number.isFinite(version.savedAt))
      .map(({ source, savedAt, label }) => typeof label === "string" ? { source, savedAt, label: label.slice(0, 80) } : { source, savedAt })
      .slice(0, 25) : [];
    return entry(script.source, { history });
  });
}

/**
 * Works out what kind of file this is and returns its scripts, ready for the import review.
 * @param {string} name @param {Uint8Array} bytes
 * @returns {Promise<{ manager: string, entries: ImportEntry[], skipped?: number }>} skipped counts entries that weren't scripts.
 */
export async function decodeImportFile(name, bytes) {
  const decoder = new TextDecoder();
  let result;
  if (isZip(bytes)) {
    // macOS adds a hidden __MACOSX/._name copy of every file when it compresses a folder; they aren't scripts.
    const files = new Map([...await readZip(bytes)].filter(([path]) => !/(^|\/)(__MACOSX\/|\._)/.test(path)));
    const text = path => decoder.decode(files.get(path));
    if (![...files.keys()].some(path => path.endsWith(userJs))) throw new Error("This archive has no .user.js scripts in it.");
    if (files.has("violentmonkey")) result = { manager: "Violentmonkey", entries: fromViolentmonkeyZip(files, text) };
    else if ([...files.keys()].some(path => path.endsWith(".options.json"))) result = { manager: "Tampermonkey", entries: fromTampermonkeyZip(files, text) };
    else result = { manager: "another userscript manager", entries: [...files.keys()].filter(path => path.endsWith(userJs)).map(path => entry(text(path))) };
  } else {
    const text = decoder.decode(bytes).replace(/^\uFEFF/, "");
    if (/^\s*[{[]/.test(text)) {
      const data = parseJson(text, name);
      if (data?.version === 1 && Array.isArray(data.scripts)) result = { manager: "Tailorscript", entries: fromTailorscriptBackup(data) };
      else if (Array.isArray(data?.scripts) && (data.created_by === "Tampermonkey" || data.scripts.some(script => object(script) && "options" in script))) {
        result = { manager: "Tampermonkey", entries: fromTampermonkeyText(data), skipped: data.scripts.filter(script => !object(script)).length };
      } else throw new Error("This JSON file isn’t a backup Tailorscript recognises.");
    } else result = { manager: "file", entries: [entry(text)] };
  }
  if (!result.entries.length) throw new Error("There are no scripts in this file.");
  const order = item => item.position ?? Infinity;
  result.entries.sort((a, b) => (order(a) > order(b) ? 1 : 0) - (order(a) < order(b) ? 1 : 0));
  for (const item of result.entries) delete item.position;
  return result;
}

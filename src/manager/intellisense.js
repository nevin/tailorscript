// Editor intelligence that works on plain source text, so it can be tested without a browser.
// code-editor.js adapts these results to CodeMirror completions, diagnostics and tooltips.
import { addMetadata, allows, grantFamilies, parseSource, supportedGrants, syncValueGrants } from "../shared/userscript.js";
import { parse, tokenizer } from "../vendor/acorn/acorn.mjs";
import { gmApis, ignoredKeys, metadataKeys, metadataValues, signature } from "./gm-api.js";

const familyOf = name => Object.keys(grantFamilies).find(family => grantFamilies[family].includes(name));

// The metadata block's lines with the offsets of each key and value. Scanning stops at the end of the block, so the
// cost depends on the header, not the length of the script.
export function metadataLines(source) {
  const lines = [];
  let inside = false;
  let block = null;
  for (let from = 0; from <= source.length;) {
    const end = source.indexOf("\n", from);
    const to = end === -1 ? source.length : end;
    const text = source.slice(from, to);
    if (!inside && /^\s*\/\/\s*==UserScript==\s*$/.test(text)) {
      inside = true;
      block = { from, to: source.length };
    } else if (inside && /^\s*\/\/\s*==\/UserScript==/.test(text)) {
      block.to = to;
      break;
    } else if (inside) {
      const entry = text.match(/^(\s*\/\/\s*@)([\w:.-]+)(\s*)(.*?)\s*$/);
      if (entry) {
        const keyFrom = from + entry[1].length;
        const valueFrom = keyFrom + entry[2].length + entry[3].length;
        lines.push({ key: entry[2], value: entry[4], from, to, keyFrom, keyTo: keyFrom + entry[2].length, valueFrom, valueTo: valueFrom + entry[4].length });
      }
    }
    if (end === -1) break;
    from = end + 1;
  }
  return { block, lines };
}

function inBlock(block, pos) {
  return block && pos > block.from && pos <= block.to;
}

/** @param {string} source @returns {any[]} acorn tokens */
function tokens(source) {
  const list = [];
  try {
    for (const token of tokenizer(source, { ecmaVersion: "latest" })) list.push(token);
  } catch {
    // Use the tokens before the first syntax error.
  }
  return list;
}

// Every place the code names a GM API or unsafeWindow, skipping property accesses such as obj.GM_x.
export function apiUsages(source, list = tokens(source)) {
  const usages = [];
  list.forEach((token, index) => {
    if (token.type.label !== "name" || list[index - 1]?.type.label === ".") return;
    if (/^GM_\w+$/.test(token.value) || token.value === "unsafeWindow") {
      usages.push({ name: token.value, from: token.start, to: token.end });
    } else if (token.value === "GM" && list[index + 1]?.type.label === "." && list[index + 2]?.type.label === "name") {
      usages.push({ name: `GM.${list[index + 2].value}`, from: token.start, to: list[index + 2].end });
    }
  });
  return usages;
}

function needsGrant(name, grants) {
  const family = familyOf(name);
  if (!family || family === "info" || grants.includes(name)) return false;
  return syncValueGrants.includes(name) || !allows(grants, family);
}

export function missingGrants(source) {
  let metadata;
  try {
    metadata = parseSource(source);
  } catch {
    return [];
  }
  return [...new Set(apiUsages(source).filter(({ name }) => needsGrant(name, metadata.grants)).map(({ name }) => name))];
}

export function addGrants(source, grants) {
  let next = source.replace(/^[ \t]*\/\/[ \t]*@grant[ \t]+none[ \t]*\n/m, "");
  for (const grant of grants) next = addMetadata(next, "grant", grant);
  return next;
}

// The smallest single replacement that turns before into after, so quick fixes keep the cursor and undo history tidy.
export function minimalChange(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

function grantInfo(name) {
  const family = familyOf(name);
  return family === "info" ? "Always available." : family ? `Needs @grant ${name}.` : "";
}

function apiOption(name) {
  const api = gmApis[name];
  return {
    label: name,
    type: api.kind === "property" ? "variable" : "function",
    detail: api.kind === "property" ? api.type : `(${api.params.map(param => param.split(":")[0]).join(", ")})`,
    info: [signature(name), api.doc, grantInfo(name)].filter(Boolean).join("\n\n"),
    boost: 1
  };
}

// Completions for metadata keys and values inside the header, or GM APIs in the code.
// meta is metadataLines(source), passed in when the caller already has it.
export function completeAt(source, pos, explicit = false, meta = metadataLines(source)) {
  const lineStart = source.lastIndexOf("\n", pos - 1) + 1;
  const before = source.slice(lineStart, pos);
  const { block, lines } = meta;
  if (inBlock(block, pos)) {
    const value = before.match(/^\s*\/\/\s*@([\w:.-]+)\s+(\S*)$/);
    if (value) {
      const choices = value[1] === "grant" ? supportedGrants : metadataValues[value[1]];
      if (!choices) return null;
      return {
        kind: "metadata",
        from: pos - value[2].length,
        options: choices.map(label => ({ label, type: "constant", info: gmApis[label] ? [signature(label), gmApis[label].doc].join("\n\n") : undefined }))
      };
    }
    const key = before.match(/^\s*\/\/\s*@([\w:.-]*)$/);
    if (!key) return null;
    // Pad new keys so their values line up with the rest of the header.
    const width = Math.max(0, ...lines.map(line => line.valueFrom - line.keyFrom).filter(size => size <= 16));
    return {
      kind: "metadata",
      from: pos - key[1].length,
      options: Object.entries(metadataKeys).map(([label, info]) => ({
        label, type: "keyword", info, apply: width > label.length ? label.padEnd(width) : `${label} `
      }))
    };
  }
  const word = before.match(/[A-Za-z_$][\w$]*(?:\.[\w$]*)?$/)?.[0] ?? "";
  if (!/^(G|u)/.test(word) && !(explicit && !word)) return null;
  return { kind: "api", from: pos - word.length, options: Object.keys(gmApis).map(apiOption) };
}

function lineAt(source, pos) {
  const from = source.lastIndexOf("\n", pos - 1) + 1;
  const end = source.indexOf("\n", pos);
  return { from, to: end === -1 ? source.length : end };
}

function lineRange(source, number) {
  let from = 0;
  for (let line = 1; line < number; line++) {
    const next = source.indexOf("\n", from);
    if (next === -1) break;
    from = next + 1;
  }
  return lineAt(source, from);
}

function deleteLine(source, line) {
  return { from: line.from, to: Math.min(source.length, line.to + 1), insert: "" };
}

// Problems shown in the editor, each with a range and, where one is obvious, a quick fix.
/**
 * @typedef {object} Problem
 * @property {number} from
 * @property {number} to
 * @property {"error" | "warning" | "info" | "hint"} severity
 * @property {string} message
 * @property {{ name: string, change: { from: number, to: number, insert: string } }[]} [actions]
 */

/** @returns {Problem[]} @param {string} source @param {{ runError?: { line: number, message: string }, meta?: ReturnType<typeof metadataLines> }} [options] */
export function diagnose(source, { runError, meta = metadataLines(source) } = {}) {
  /** @type {Problem[]} */
  const found = [];
  const { block, lines } = meta;
  try {
    parse(source, { ecmaVersion: "latest" });
  } catch (error) {
    const from = Math.min(error.pos ?? 0, source.length);
    found.push({ from, to: Math.min(from + 1, source.length), severity: "error", message: error.message.replace(/\s*\(\d+:\d+\)$/, "") });
  }

  let metadata;
  try {
    metadata = parseSource(source);
  } catch (error) {
    const named = error.message.match(/@([\w-]+)/)?.[1];
    const line = lines.find(item => error.message.includes(item.value) && item.value) ?? lines.find(item => item.key === named);
    const fallback = block ? lineAt(source, block.from) : lineAt(source, 0);
    found.push({ ...(line ? { from: line.valueFrom, to: Math.max(line.valueTo, line.valueFrom + 1) } : fallback), severity: "error", message: error.message });
  }

  for (const line of lines) {
    if (!metadataKeys[line.key] && !ignoredKeys.includes(line.key)) {
      found.push({ from: line.keyFrom, to: line.keyTo, severity: "info", message: `Tailorscript doesn’t use @${line.key}.` });
    }
    const insecure = line.value.search(/http:\/\//i);
    if (["require", "resource", "updateURL", "downloadURL"].includes(line.key) && insecure !== -1) {
      const from = line.valueFrom + insecure;
      found.push({
        from, to: line.valueTo, severity: "warning",
        message: "This is downloaded over unencrypted http, so anyone on the network could change it. Use https.",
        actions: [{ name: "Use https", change: { from, to: from + 7, insert: "https://" } }]
      });
    }
  }

  if (metadata) {
    const list = tokens(source);
    const usages = apiUsages(source, list);
    // A script can call the same API many times; each fix for it is the same edit, so work it out once.
    const grantFixes = new Map();
    for (const usage of usages.filter(({ name }) => needsGrant(name, metadata.grants))) {
      if (!grantFixes.has(usage.name)) grantFixes.set(usage.name, minimalChange(source, addGrants(source, [usage.name])));
      const change = grantFixes.get(usage.name);
      found.push({
        from: usage.from, to: usage.to, severity: "warning",
        message: `${usage.name} needs @grant ${usage.name}. Without it, it isn’t defined.`,
        actions: [{ name: `Add @grant ${usage.name}`, change }]
      });
    }
    const usedFamilies = new Set(usages.map(({ name }) => familyOf(name)).filter(Boolean));
    for (const line of lines.filter(item => item.key === "grant")) {
      const family = familyOf(line.value);
      if (metadata.unsupportedGrants.includes(line.value)) {
        found.push({ from: line.valueFrom, to: line.valueTo, severity: "warning", message: `Tailorscript doesn’t provide ${line.value}, so calls to it will fail.` });
      } else if (family && !["info", "window"].includes(family) && !usedFamilies.has(family)) {
        found.push({
          from: line.valueFrom, to: line.valueTo, severity: "hint", message: `${line.value} is granted but the code doesn’t use it.`,
          actions: [{ name: "Remove this line", change: deleteLine(source, line) }]
        });
      }
    }
    for (const request of requestUrls(list)) {
      const host = request.host;
      const page = metadata.targets.matches.some(pattern => {
        const site = pattern.match(/^[^:]+:\/\/([^/]+)/)[1];
        return site === host || (site.startsWith("*.") && (host === site.slice(2) || host.endsWith(site.slice(1))));
      });
      const connected = metadata.connects.some(value => {
        const allowed = value.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[:/].*$/, "");
        return allowed === "*" || host === allowed || host.endsWith(`.${allowed}`);
      });
      if (page || connected) continue;
      found.push({
        from: request.from, to: request.to, severity: "warning", message: `Requests to ${host} need @connect ${host}.`,
        actions: [{ name: `Add @connect ${host}`, change: minimalChange(source, addMetadata(source, "connect", host)) }]
      });
    }
  }

  if (runError?.line) {
    const line = lineRange(source, runError.line);
    found.push({ ...line, severity: "error", message: `Last run failed here: ${runError.message}` });
  }
  return found;
}

// String URLs passed as url: in GM_xmlhttpRequest and GM.xmlHttpRequest calls.
function requestUrls(list) {
  const found = [];
  list.forEach((token, index) => {
    const isCall = (token.value === "GM_xmlhttpRequest" && list[index - 1]?.type.label !== ".") ||
      (token.value === "xmlHttpRequest" && list[index - 1]?.type.label === "." && list[index - 2]?.value === "GM");
    if (!isCall || list[index + 1]?.type.label !== "(") return;
    let depth = 0;
    for (let next = index + 1; next < list.length; next++) {
      const label = list[next].type.label;
      if (["(", "{", "[", "${"].includes(label)) depth++;
      else if ([")", "}", "]"].includes(label) && --depth === 0) break;
      if (depth === 2 && list[next].value === "url" && list[next + 1]?.type.label === ":" && list[next + 2]?.type.label === "string") {
        try {
          const url = new URL(list[next + 2].value);
          if (/^https?:$/.test(url.protocol)) found.push({ host: url.hostname, from: list[next + 2].start, to: list[next + 2].end });
        } catch {
          // Relative and invalid URLs go to the page's own site.
        }
      }
    }
  });
  return found;
}

function wordAt(source, pos) {
  let from = pos;
  let to = pos;
  while (from > 0 && /[\w$.]/.test(source[from - 1])) from--;
  while (to < source.length && /[\w$]/.test(source[to])) to++;
  return { from, to, text: source.slice(from, to) };
}

// Documentation for the metadata key, grant or GM API under the pointer.
export function hoverAt(source, pos, meta = metadataLines(source)) {
  const { block, lines } = meta;
  if (inBlock(block, pos)) {
    const line = lines.find(item => pos >= item.from && pos <= item.to);
    if (!line) return null;
    if (pos >= line.keyFrom - 1 && pos <= line.keyTo && metadataKeys[line.key]) {
      return { from: line.keyFrom - 1, to: line.keyTo, title: `@${line.key}`, doc: metadataKeys[line.key] };
    }
    if (line.key === "grant" && pos >= line.valueFrom && pos <= line.valueTo && gmApis[line.value]) {
      return { from: line.valueFrom, to: line.valueTo, title: signature(line.value), doc: gmApis[line.value].doc };
    }
    return null;
  }
  const word = wordAt(source, pos);
  const parts = word.text.split(".");
  let offset = word.from;
  for (let index = 0; index < parts.length; index++) {
    const end = offset + parts[index].length;
    const name = parts[index] === "GM" && parts[index + 1] ? `GM.${parts[index + 1]}` : parts[index];
    const nameEnd = name.includes(".") ? end + 1 + parts[index + 1].length : end;
    if (gmApis[name] && pos >= offset && pos <= nameEnd && (index === 0 || parts[index - 1] === "" || name.startsWith("GM."))) {
      return { from: offset, to: nameEnd, title: signature(name), doc: [gmApis[name].doc, grantInfo(name)].filter(Boolean).join(" ") };
    }
    offset = end + 1;
  }
  return null;
}

// The parameter hint for argument number `argument` (from 0) of a GM call, or null when name isn't a GM function.
export function signatureFor(name, argument) {
  const api = gmApis[name];
  if (!api || api.kind === "property") return null;
  return { name, params: api.params, returns: api.returns, active: Math.min(argument, api.params.length - 1), doc: api.doc };
}

// The GM call the cursor is inside and which argument it's on, for the parameter hint. The editor finds the call
// with CodeMirror's incremental syntax tree instead (editor-state.js); this text version backs the tests and fallbacks.
export function signatureAt(source, pos, meta = metadataLines(source)) {
  if (inBlock(meta.block, pos)) return null;
  const list = tokens(source.slice(0, pos));
  let depth = 0;
  let argument = 0;
  for (let index = list.length - 1; index >= 0; index--) {
    const label = list[index].type.label;
    if ([")", "]", "}"].includes(label)) depth++;
    else if (["[", "{", "${"].includes(label)) {
      if (depth === 0) return null;
      depth--;
    } else if (label === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const callee = list[index - 1];
      let name = callee?.type.label === "name" ? callee.value : "";
      if (list[index - 2]?.type.label === "." && list[index - 3]?.value === "GM") name = `GM.${name}`;
      return signatureFor(name, argument);
    } else if (label === "," && depth === 0) argument++;
  }
  return null;
}

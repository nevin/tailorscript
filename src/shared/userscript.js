const timings = ["document_start", "document_end", "document_idle"];
export const valueGrants = ["GM.getValue", "GM.setValue", "GM.deleteValue", "GM.listValues"];
export const supportedGrants = ["none", "GM_addStyle", ...valueGrants];

export function parseSource(source) {
  const header = source.match(/^\s*\/\/\s*==UserScript==[^\n]*\n([\s\S]*?)^\s*\/\/\s*==\/UserScript==[^\n]*/m);
  const metadata = new Map();

  for (const line of (header?.[1] ?? "").split("\n")) {
    const entry = line.trim().match(/^\s*\/\/\s*@([\w-]+)(?:\s+(.*))?$/);
    if (!entry) continue;
    const [, key, value = ""] = entry;
    const values = metadata.get(key) ?? [];
    values.push(value.trim());
    metadata.set(key, values);
  }

  for (const key of ["include", "exclude", "require", "resource", "sandbox", "inject-into", "unwrap"]) {
    if (metadata.has(key)) throw new Error(`@${key} is unsupported.`);
  }
  const grants = [...new Set(metadata.get("grant") ?? [])];
  if (grants.some(value => !supportedGrants.includes(value)) ||
      (grants.includes("none") && grants.length > 1)) {
    throw new Error(`Use @grant none, or any of ${supportedGrants.slice(1).join(", ")}.`);
  }
  if (metadata.has("all-frames") && metadata.has("noframes")) {
    throw new Error("Use either @all-frames or @noframes, not both.");
  }

  const matches = metadata.get("match") ?? [];
  const excludeMatches = metadata.get("exclude-match") ?? [];
  if (!matches.length) throw new Error("Add an @match line for the site where this script should run.");
  for (const pattern of [...matches, ...excludeMatches]) {
    if (!/^(https?|\*):\/\/(?:\*|(?:\*\.)?[a-z\d-]+(?:\.[a-z\d-]+)*)\/\S*$/i.test(pattern)) {
      throw new Error(`Invalid HTTP(S) match pattern: ${pattern}`);
    }
  }

  const runAt = metadata.get("run-at")?.[0] ?? "document-idle";
  const normalizedTiming = runAt.replaceAll("-", "_");
  if (!timings.includes(normalizedTiming)) throw new Error(`Unsupported @run-at: ${runAt}`);
  if (!source.slice((header?.index ?? 0) + (header?.[0].length ?? 0)).trim()) {
    throw new Error("Add JavaScript below the metadata header.");
  }

  return {
    name: metadata.get("name")?.[0] || "Untitled script",
    matches,
    excludeMatches,
    grants,
    runAt: normalizedTiming,
    allFrames: metadata.has("all-frames"),
    tags: [...new Set((metadata.get("tag") ?? []).flatMap(value => value.split(/[\s,]+/)).filter(Boolean))]
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
  const escaped = path.split("*").map(part => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(url.pathname + url.search);
}

export function runsOn(source, url) {
  try {
    const { matches, excludeMatches } = parseSource(source);
    return matches.some(pattern => matchesUrl(pattern, url)) && !excludeMatches.some(pattern => matchesUrl(pattern, url));
  } catch {
    return false;
  }
}

// Preserve the source body and metadata unrelated to the guided fields.
export function updateTargets(source, name, patterns) {
  const lines = source.split("\n");
  const start = lines.findIndex(line => /^\s*\/\/\s*==UserScript==\s*$/.test(line));
  const end = lines.findIndex((line, index) => index > start && /^\s*\/\/\s*==\/UserScript==\s*$/.test(line));
  if ((start < 0) !== (end < 0)) throw new Error("Complete the userscript metadata block before applying these settings.");
  const metadata = [`// @name        ${name.trim() || "Untitled script"}`,
    ...patterns.map(pattern => `// @match       ${pattern}`)];
  if (start < 0) return ["// ==UserScript==", ...metadata, "// ==/UserScript==", "", source].join("\n");
  const other = lines.slice(start + 1, end).filter(line => !/^\s*\/\/\s*@(name|match)(?:\s|$)/.test(line));
  return [...lines.slice(0, start + 1), ...metadata, ...other, ...lines.slice(end)].join("\n");
}

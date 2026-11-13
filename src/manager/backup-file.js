import { parseSource } from "../shared/userscript.js";

export function decodeImport(text, isJson) {
  const data = isJson ? JSON.parse(text) : { version: 1, scripts: [{ source: text }] };
  if (data?.version !== 1 || !Array.isArray(data.scripts) || !data.scripts.length) {
    throw new Error("Choose a version 1 backup or a .user.js file with at least one script.");
  }
  return data.scripts.map(entry => {
    if (typeof entry?.source !== "string") throw new Error("A script in this backup is missing its source.");
    const history = Array.isArray(entry.history) ? entry.history
      .filter(version => typeof version?.source === "string" && Number.isFinite(version.savedAt))
      .map(({ source, savedAt, label }) => typeof label === "string" ? { source, savedAt, label: label.slice(0, 80) } : { source, savedAt })
      .slice(0, 25) : [];
    return { source: entry.source, history, ...parseSource(entry.source) };
  });
}

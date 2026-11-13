import { compareVersions, parseSource } from "../shared/userscript.js";
import { validate } from "../shared/validate.js";
import { downloadText } from "./dependencies.js";

export async function sourceHash(source) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function updateUrls(script, metadata = parseSource(script.source)) {
  const check = metadata.updateUrl || script.installUrl || "";
  return { check, download: metadata.downloadUrl || script.installUrl || (/\.user\.js(\?|$)/.test(check) ? check : "") };
}

// Reads the version from the update URL (often a small .meta.js) and only downloads the full script when it is newer.
export async function fetchUpdate(script) {
  const metadata = parseSource(script.source);
  const urls = updateUrls(script, metadata);
  if (!urls.check) return null;
  const header = await downloadText(urls.check);
  const version = header.match(/^\s*\/\/\s*@version\s+(\S+)/m)?.[1];
  if (!version) throw new Error(`${urls.check} doesn’t declare an @version.`);
  if (compareVersions(version, metadata.version) <= 0 || version === script.updateCheck?.skipped) return { version };
  if (!urls.download) throw new Error("This script has no download URL for updates.");
  const source = urls.download === urls.check ? header : await downloadText(urls.download);
  const next = validate(source);
  if (compareVersions(next.version, metadata.version) <= 0) return { version: next.version };
  return { version: next.version, source, metadata: next };
}

// Updates apply on their own only when they need nothing new from the user.
export function reviewReasons(current, next, { edited, autoUpdate }) {
  const reasons = [];
  if (autoUpdate === false) reasons.push("Automatic updates are off for this script.");
  if (edited) reasons.push("You edited this script after installing it, and updating replaces your changes.");
  const origins = next.origins.filter(origin => !current.origins.includes(origin));
  if (origins.length) reasons.push(`It asks for access to ${origins.join(", ")}.`);
  const grants = next.grants.filter(grant => grant !== "none" && !current.grants.includes(grant));
  if (grants.length) reasons.push(`It uses new APIs: ${grants.join(", ")}.`);
  const requires = next.requires.filter(url => !current.requires.includes(url));
  if (requires.length) reasons.push(`It loads new code from ${requires.join(", ")}.`);
  if (next.injectInto !== current.injectInto) reasons.push("It changes where the script runs.");
  return reasons;
}

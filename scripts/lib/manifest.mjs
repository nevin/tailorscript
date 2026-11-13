import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { listFiles, readJson, relative } from "./project.mjs";

const limits = { name: 75, short_name: 12, description: 132 };

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function pngSize(buffer) {
  if (buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

function isVersion(value) {
  return /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(value) && value.split(".").every(part => Number(part) <= 65535);
}

async function checkIcons(dir, icons, label, errors) {
  for (const [size, file] of Object.entries(icons ?? {})) {
    const full = path.join(dir, file);
    if (!await exists(full)) {
      errors.push(`${label} ${size}: ${file} does not exist.`);
      continue;
    }
    const dimensions = file.endsWith(".png") ? pngSize(await readFile(full)) : null;
    if (!dimensions) errors.push(`${label} ${size}: ${file} must be a PNG.`);
    else if (dimensions.join("x") !== `${size}x${size}`) errors.push(`${label} ${size}: ${file} is ${dimensions.join("x")}.`);
  }
}

// Every page, script, stylesheet and image an extension file points at must ship with it, and MV3 forbids remote code.
async function checkReferences(dir, errors) {
  for (const file of await listFiles(dir)) {
    const text = file.endsWith(".html") || file.endsWith(".js") || file.endsWith(".mjs") ? await readFile(file, "utf8") : "";
    const references = file.endsWith(".html")
      ? [...text.matchAll(/\s(?:src|href)="([^"#?]+)"/g)].map(match => match[1])
      : [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|(?:^|\n)\s*import\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g)]
        .map(match => match[1] ?? match[2] ?? match[3]);
    for (const reference of references) {
      if (/^https?:|^\/\//.test(reference)) {
        if (/\.m?js$/.test(reference) || file.endsWith(".js")) errors.push(`${relative(file, dir)} loads remote code from ${reference}.`);
        continue;
      }
      if (/^[a-z]+:/i.test(reference)) continue;
      if (!await exists(path.resolve(path.dirname(file), reference))) {
        errors.push(`${relative(file, dir)} references missing file ${reference}.`);
      }
    }
  }
}

export async function validateExtension(dir, { version } = {}) {
  const errors = [];
  const manifest = await readJson(path.join(dir, "manifest.json"));
  if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3.");
  for (const [field, limit] of Object.entries(limits)) {
    if (field === "name" && !manifest.name) errors.push("name is required.");
    if (manifest[field] && manifest[field].length > limit) errors.push(`${field} is longer than ${limit} characters.`);
  }
  if (!isVersion(manifest.version ?? "")) errors.push(`version "${manifest.version}" is not 1-4 dot-separated integers.`);
  if (version && manifest.version !== version) errors.push(`manifest version ${manifest.version} does not match package.json ${version}.`);
  if (!manifest.icons?.["128"]) errors.push("A 128px icon is required for the Chrome Web Store.");
  await checkIcons(dir, manifest.icons, "icons", errors);
  await checkIcons(dir, manifest.action?.default_icon, "action.default_icon", errors);
  for (const file of [manifest.background?.service_worker, manifest.action?.default_popup, manifest.options_page].filter(Boolean)) {
    if (!await exists(path.join(dir, file))) errors.push(`${file} is referenced by the manifest but does not exist.`);
  }
  await checkReferences(dir, errors);
  return { manifest, errors };
}

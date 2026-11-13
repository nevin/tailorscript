// Uploads the packaged zip to the Chrome Web Store (API v2) and optionally submits it for review.
//
//   npm run submit -- --dry-run          check configuration and the package without calling the API
//   npm run submit                       upload release/<name>-<version>.zip as a draft
//   npm run submit -- --publish          upload, then submit for review (publishes when approved)
//   npm run submit -- --publish --staged upload, then submit for review and stage instead of publishing
//   npm run submit -- --status           show the item's current upload and review status
//
// Credentials come from the environment or a .env file: see .env.example and docs/publishing.md.
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { done, fail, packageInfo, relative, releaseDir, root } from "./lib/project.mjs";

const required = ["CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN", "CWS_PUBLISHER_ID", "CWS_EXTENSION_ID"];
const pollAttempts = 20;
const pollDelay = Number(process.env.CWS_POLL_MS ?? 3000);

const { values: options } = parseArgs({
  options: {
    zip: { type: "string" },
    publish: { type: "boolean", default: false },
    staged: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false }
  }
});

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function request(url, init, label) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${body.error?.message ?? body.error_description ?? body.raw ?? text}`);
  }
  return body;
}

async function accessToken() {
  const body = await request(process.env.CWS_TOKEN_URL ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.CWS_CLIENT_ID,
      client_secret: process.env.CWS_CLIENT_SECRET,
      refresh_token: process.env.CWS_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  }, "Requesting an access token");
  if (!body.access_token) throw new Error("Google did not return an access token.");
  return body.access_token;
}

function itemUrl(kind = "v2") {
  const origin = process.env.CWS_API_ORIGIN ?? "https://chromewebstore.googleapis.com";
  const prefix = kind === "upload" ? "/upload/v2" : "/v2";
  return `${origin}${prefix}/publishers/${process.env.CWS_PUBLISHER_ID}/items/${process.env.CWS_EXTENSION_ID}`;
}

async function fetchStatus(token) {
  return request(`${itemUrl()}:fetchStatus`, { headers: { Authorization: `Bearer ${token}` } }, "Fetching item status");
}

function describeStatus(status) {
  const revision = (label, value) => value?.state
    ? `${label}: ${value.state}${value.distributionChannels?.[0]?.crxVersion ? ` (version ${value.distributionChannels[0].crxVersion})` : ""}`
    : `${label}: none`;
  return [
    revision("Published", status.publishedItemRevisionStatus),
    revision("Submitted", status.submittedItemRevisionStatus),
    `Last upload: ${status.lastAsyncUploadState ?? "none in the last 24 hours"}`,
    ...(status.takenDown ? ["Taken down for a policy violation"] : []),
    ...(status.warned ? ["Policy warning: resolve it in the Developer Dashboard"] : [])
  ].join("\n  ");
}

async function upload(token, zipPath) {
  let result = await request(`${itemUrl("upload")}:upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
    body: await readFile(zipPath)
  }, "Uploading the package");
  let state = result.uploadState;
  for (let attempt = 0; state === "IN_PROGRESS" && attempt < pollAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, pollDelay));
    result = await fetchStatus(token);
    state = result.lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") {
    throw new Error(`Upload ended in state ${state ?? "unknown"}: ${JSON.stringify(result)}`);
  }
  return result;
}

async function publish(token) {
  const result = await request(`${itemUrl()}:publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ publishType: options.staged ? "STAGED_PUBLISH" : "DEFAULT_PUBLISH" })
  }, "Submitting for review");
  for (const warning of result.warningInfo?.warnings ?? []) console.warn(`  warning: ${warning.reason}: ${warning.description}`);
  return result;
}

async function main() {
  const envFile = path.join(root, ".env");
  if (await exists(envFile)) process.loadEnvFile(envFile);
  const { name, version } = await packageInfo();
  const zipPath = path.resolve(options.zip ?? path.join(releaseDir, `${name}-${version}.zip`));
  const missing = required.filter(key => !process.env[key]);

  if (options["dry-run"]) {
    console.log(`Package:  ${relative(zipPath)} ${await exists(zipPath) ? "(found)" : "(missing: run npm run package)"}`);
    console.log(`Item:     ${process.env.CWS_EXTENSION_ID ?? "<CWS_EXTENSION_ID>"} for publisher ${process.env.CWS_PUBLISHER_ID ?? "<CWS_PUBLISHER_ID>"}`);
    console.log(`Steps:    upload${options.publish ? `, then submit for review (${options.staged ? "staged" : "publish on approval"})` : " as a draft"}`);
    if (missing.length) console.log(`Missing:  ${missing.join(", ")}`);
    done("Dry run finished. Nothing was sent.");
    return;
  }
  if (missing.length) throw new Error(`Set ${missing.join(", ")} in the environment or .env (see .env.example).`);
  if (options.staged && !options.publish) throw new Error("--staged only applies with --publish.");

  const token = await accessToken();
  if (options.status) {
    done(`Status for ${process.env.CWS_EXTENSION_ID}:\n  ${describeStatus(await fetchStatus(token))}`);
    return;
  }
  if (!await exists(zipPath)) throw new Error(`${relative(zipPath)} does not exist. Run npm run package first.`);
  await upload(token, zipPath);
  done(`Uploaded ${relative(zipPath)} as a draft.`);
  if (!options.publish) {
    console.log("  Review the draft in the Developer Dashboard, or rerun with --publish to submit it.");
    return;
  }
  const result = await publish(token);
  done(`Submitted version ${version} for review: ${result.state ?? "state not reported"}.`);
}

main().catch(error => fail(error.message));

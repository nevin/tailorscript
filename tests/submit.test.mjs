import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = path.resolve(import.meta.dirname, "../scripts/submit.mjs");
const token = "secret-access-token";
let server;
let origin;
let requests;
let behaviour;
let dir;
let zipPath;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "submit-test-"));
  zipPath = path.join(dir, "extension.zip");
  await writeFile(zipPath, "zip-bytes");
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body });
    const reply = (status, json) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
    if (req.url === "/token") return behaviour.token ? reply(...behaviour.token) : reply(200, { access_token: token });
    if (req.url.endsWith(":upload")) return reply(200, { uploadState: behaviour.uploadState ?? "SUCCEEDED" });
    if (req.url.endsWith(":fetchStatus")) {
      return reply(200, { lastAsyncUploadState: behaviour.polled ?? "SUCCEEDED", submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: "0.4.0" }] } });
    }
    if (req.url.endsWith(":publish")) return reply(200, { state: "PENDING_REVIEW", warningInfo: { warnings: [{ reason: "R", description: "D" }] } });
    reply(404, { error: { message: "not found" } });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  behaviour = {};
});

const env = () => ({
  ...process.env,
  CWS_CLIENT_ID: "client", CWS_CLIENT_SECRET: "client-secret", CWS_REFRESH_TOKEN: "refresh",
  CWS_PUBLISHER_ID: "pub", CWS_EXTENSION_ID: "item", CWS_API_ORIGIN: origin, CWS_TOKEN_URL: `${origin}/token`, CWS_POLL_MS: "1"
});

async function submit(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, "--zip", zipPath, ...args], { env: env() });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    return { code: error.code, output: error.stdout + error.stderr };
  }
}

test("uploads, waits for an in-progress upload and submits a staged review", async () => {
  behaviour.uploadState = "IN_PROGRESS";
  const { code, output } = await submit("--publish", "--staged");
  assert.equal(code, 0, output);
  assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
    "POST /token",
    "POST /upload/v2/publishers/pub/items/item:upload",
    "GET /v2/publishers/pub/items/item:fetchStatus",
    "POST /v2/publishers/pub/items/item:publish"
  ]);
  assert.match(requests[0].body, /grant_type=refresh_token/);
  assert.equal(requests[1].body, "zip-bytes");
  assert.equal(requests[1].type, "application/zip");
  assert.ok(requests.slice(1).every(({ auth }) => auth === `Bearer ${token}`));
  assert.deepEqual(JSON.parse(requests[3].body), { publishType: "STAGED_PUBLISH" });
  assert.match(output, /warning: R: D/);
  assert.match(output, /PENDING_REVIEW/);
  assert.ok(!output.includes(token) && !output.includes("client-secret"));
});

test("uploads a draft without publishing by default", async () => {
  const { code, output } = await submit();
  assert.equal(code, 0, output);
  assert.equal(requests.filter(({ url }) => url.endsWith(":publish")).length, 0);
  assert.match(output, /as a draft/);
});

test("reports failed uploads, token errors and status", async () => {
  behaviour.uploadState = "FAILED";
  let result = await submit("--publish");
  assert.equal(result.code, 1);
  assert.match(result.output, /Upload ended in state FAILED/);
  assert.equal(requests.filter(({ url }) => url.endsWith(":publish")).length, 0);

  behaviour = { token: [400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }] };
  result = await submit();
  assert.equal(result.code, 1);
  assert.match(result.output, /expired or revoked/);

  behaviour = {};
  result = await submit("--status");
  assert.equal(result.code, 0);
  assert.match(result.output, /Submitted: PENDING_REVIEW \(version 0\.4\.0\)/);
});

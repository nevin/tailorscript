import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { backupToSync, readSyncBackup } from "../src/shared/sync-backup.js";
import { installChrome } from "./helpers/chrome.mjs";

beforeEach(() => installChrome());

test("round-trips multi-byte and escape-heavy sources within per-item quotas", async () => {
  const scripts = Array.from({ length: 6 }, (_, index) => ({ source: `é"\\\n😀${index}`.repeat(250) }));
  await backupToSync(scripts);
  const { text } = await readSyncBackup();
  assert.deepEqual(JSON.parse(text).scripts.map(({ source }) => source), scripts.map(({ source }) => source));
});

test("removes stale chunks and rejects libraries over the sync quota", async () => {
  await backupToSync(Array.from({ length: 6 }, () => ({ source: "x".repeat(9000) })));
  await backupToSync([{ source: "small" }]);
  const keys = Object.keys(chrome.storage.sync.data).filter(key => key.startsWith("backup:"));
  assert.equal(keys.length, chrome.storage.sync.data.syncBackup.chunks);
  await assert.rejects(backupToSync([{ source: "x".repeat(200_000) }]), /too large/);
  await assert.rejects(installChrome() && readSyncBackup(), /No Chrome sync backup/);
});

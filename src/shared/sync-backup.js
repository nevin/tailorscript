/** @typedef {{ chunks: number, savedAt: number, count: number }} SyncBackup */

const encoder = new TextEncoder();
const syncItemBytes = 8000;

// chrome.storage.sync caps each item near 8 KB, measured on the JSON-encoded value.
function chunk(text) {
  const chunks = [];
  let current = "";
  let size = 0;
  for (const char of text) {
    const cost = encoder.encode(JSON.stringify(char)).length - 2;
    if (size + cost > syncItemBytes) {
      chunks.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += cost;
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function backupToSync(scripts) {
  const savedAt = Date.now();
  const chunks = chunk(JSON.stringify({ version: 1, scripts: scripts.map(({ source }) => ({ source })) }));
  const bytes = chunks.reduce((total, text, index) => total + encoder.encode(`backup:${index}` + JSON.stringify(text)).length, 0);
  if (bytes > chrome.storage.sync.QUOTA_BYTES - 1000) {
    throw new Error("The library is too large for Chrome sync. Use Export backup instead.");
  }
  const { syncBackup: previous } = /** @type {{ syncBackup?: SyncBackup }} */ (await chrome.storage.sync.get("syncBackup"));
  await chrome.storage.sync.set({
    ...Object.fromEntries(chunks.map((text, index) => [`backup:${index}`, text])),
    syncBackup: { chunks: chunks.length, savedAt, count: scripts.length }
  });
  const stale = Array.from({ length: Math.max(0, (previous?.chunks ?? 0) - chunks.length) },
    (_, index) => `backup:${chunks.length + index}`);
  if (stale.length) await chrome.storage.sync.remove(stale);
  return savedAt;
}

export async function readSyncBackup() {
  const { syncBackup } = /** @type {{ syncBackup?: SyncBackup }} */ (await chrome.storage.sync.get("syncBackup"));
  if (!syncBackup?.chunks) throw new Error("No Chrome sync backup was found for this profile.");
  const keys = Array.from({ length: syncBackup.chunks }, (_, index) => `backup:${index}`);
  const stored = await chrome.storage.sync.get(keys);
  if (keys.some(key => typeof stored[key] !== "string")) {
    throw new Error("The Chrome sync backup is incomplete. Try again after Chrome finishes syncing.");
  }
  return { text: keys.map(key => stored[key]).join(""), savedAt: syncBackup.savedAt };
}

export async function readScripts() {
  const { scripts = [] } = await chrome.storage.local.get("scripts");
  return scripts;
}

export async function readSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return settings;
}

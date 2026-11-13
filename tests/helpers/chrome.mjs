// In-memory stand-ins for the Chrome APIs the extension uses. Tests install them on globalThis.chrome.

function storageArea({ itemLimit } = {}) {
  const data = {};
  return {
    data,
    QUOTA_BYTES: 102_400,
    async get(keys) {
      const names = keys == null ? Object.keys(data)
        : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return structuredClone(Object.fromEntries(names.filter(name => name in data).map(name => [name, data[name]])));
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        if (itemLimit && new TextEncoder().encode(key + JSON.stringify(value)).length > itemLimit) {
          throw new Error(`QUOTA_BYTES_PER_ITEM exceeded for ${key}`);
        }
      }
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete data[key];
    }
  };
}

export function installChrome() {
  const listeners = {};
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  const registered = [];
  const calls = [];
  globalThis.chrome = {
    storage: { local: storageArea(), session: storageArea(), sync: storageArea({ itemLimit: 8192 }) },
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      onInstalled: event("installed"),
      onStartup: event("startup"),
      onMessage: event("message"),
      onUserScriptMessage: event("userScriptMessage")
    },
    permissions: { contains: async () => true, onAdded: event("permissionsAdded"), onRemoved: event("permissionsRemoved") },
    tabs: { onRemoved: event("tabRemoved") },
    userScripts: {
      configureWorld: async config => { calls.push(["configureWorld", config]); },
      getScripts: async () => registered.map(({ id }) => ({ id })),
      register: async ([registration]) => {
        calls.push(["register", registration.id]);
        registered.push(registration);
      },
      update: async ([registration]) => {
        calls.push(["update", registration.id]);
        registered[registered.findIndex(({ id }) => id === registration.id)] = registration;
      },
      unregister: async ({ ids }) => {
        calls.push(["unregister", ...ids]);
        for (const id of ids) registered.splice(registered.findIndex(item => item.id === id), 1);
      }
    }
  };
  return { listeners, registered, calls };
}

export function userscript(body = "run();", extra = "") {
  return `// ==UserScript==\n// @name        Test\n// @match       https://a.com/*\n${extra}// ==/UserScript==\n${body}`;
}

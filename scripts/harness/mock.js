// A stand-in for the chrome.* APIs so the manager, popup and install pages run in an ordinary browser tab.
// Storage persists in localStorage; set localStorage["mock-blocked"] to simulate Allow User Scripts being off.
(() => {
  const changeListeners = [];
  function area(name) {
    const data = JSON.parse(localStorage.getItem("mock-" + name) || "{}");
    const persist = () => localStorage.setItem("mock-" + name, JSON.stringify(data));
    return {
      QUOTA_BYTES: 102400,
      async get(keys) {
        const list = keys == null ? Object.keys(data) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return structuredClone(Object.fromEntries(list.filter(k => k in data).map(k => [k, data[k]])));
      },
      async set(items) {
        const changes = {};
        for (const [k, v] of Object.entries(items)) { changes[k] = { oldValue: data[k], newValue: structuredClone(v) }; data[k] = structuredClone(v); }
        persist();
        setTimeout(() => changeListeners.forEach(fn => fn(changes, name)));
      },
      async remove(keys) {
        const changes = {};
        for (const k of [].concat(keys)) if (k in data) { changes[k] = { oldValue: data[k] }; delete data[k]; }
        persist();
        if (Object.keys(changes).length) setTimeout(() => changeListeners.forEach(fn => fn(changes, name)));
      }
    };
  }
  const listeners = {};
  const on = name => ({ addListener: fn => (listeners[name] = fn) });
  const registered = [];
  window.mockListeners = listeners;
  window.chrome = {
    storage: { local: area("local"), session: area("session"), sync: area("sync"), onChanged: { addListener: fn => changeListeners.push(fn) } },
    runtime: {
      id: "harness",
      getManifest: () => ({ version: "harness" }),
      getURL: p => new URL(p, location.origin + "/").href,
      onInstalled: on("i"), onStartup: on("s"), onMessage: on("message"), onUserScriptMessage: on("us"),
      sendMessage: message => new Promise(resolve => {
        const keep = listeners.message(structuredClone(message), { url: location.href.split("?")[0].split("#")[0] }, resolve);
        if (!keep) resolve(undefined);
      })
    },
    permissions: {
      contains: async () => true, request: async () => true, remove: async () => true,
      getAll: async () => ({ origins: ["https://example.com/*", "https://news.ycombinator.com/*"] }),
      onAdded: on("pa"), onRemoved: on("pr")
    },
    tabs: { onRemoved: on("tr"), onUpdated: on("tu"), query: async () => [], reload: async () => {}, create: async props => { console.log("tabs.create", JSON.stringify(props)); return { id: 50 }; },
      update: async (id, props) => console.log("tabs.update", JSON.stringify(props)), getCurrent: async () => ({ id: 77 }), remove: async id => console.log("tabs.remove", id) },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { get: async () => ({}), create: async () => {}, onAlarm: on("alarm") },
    notifications: { create: async () => {}, clear: async () => {}, onClicked: on("nc"), onClosed: on("nx") },
    commands: { onCommand: on("command"), getAll: async () => [{ name: "toggle-pause", shortcut: "⌥⇧P" }] },
    declarativeNetRequest: { updateDynamicRules: async () => {} },
    userScripts: {
      getWorldConfigurations: async () => [], resetWorldConfiguration: async () => {},
      configureWorld: async () => { if (localStorage.getItem("mock-blocked")) throw new Error("off"); },
      getScripts: async () => structuredClone(registered),
      execute: async injection => console.log("userScripts.execute", injection.target),
      register: async ([r]) => registered.push(r), update: async () => {},
      unregister: async ({ ids }) => ids.forEach(id => registered.splice(registered.findIndex(r => r.id === id), 1))
    }
  };
})();

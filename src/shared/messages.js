// Every message the service worker accepts, with the fields each one carries. A field type ending in "?" may be missing
// or null; a nested object lists its own fields; a one-item array describes each item. The service worker checks a
// message against this before acting on it, so handlers can trust the shapes they read.

const id = "string";
const expected = "object?";

// From extension pages (manager, popup, install).
export const pageMessages = {
  sync: {},
  save: { id, script: { source: "string", enabled: "boolean" }, expected },
  install: { id: "string?", source: "string", url: "string", enabled: "boolean?", autoUpdate: "boolean?" },
  import: { entries: [{ source: "string", history: "array?", replace: "string?" }] },
  "apply-update": { id },
  "dismiss-update": { id },
  "auto-update": { id, enabled: "boolean" },
  "exclude-site": { id, host: "string" },
  toggle: { id, enabled: "boolean" },
  delete: { id, expected },
  restore: { id },
  purge: { id: "string?" },
  move: { id, offset: "number" },
  label: { id, savedAt: "number", label: "string?" },
  settings: { patch: "object" },
  "clear-values": { id },
  "check-updates": { id: "string?" },
  "run-now": { id, tabId: "number" },
  "menu-run": { id, tabId: "number", commandId: "string" },
  diagnostics: {}
};

// From userscripts, through the USER_SCRIPT world's messaging. Each also carries the script's id and its token,
// which the service worker checks first (background/bridge-token.js).
export const scriptMessages = {
  run: {},
  error: { message: "string?", line: "number?", column: "number?" },
  menu: { op: "string", commandId: "string", caption: "string?" },
  "xhr-abort": { requestId: "string" },
  value: { op: "string", key: "string?" },
  xhr: { requestId: "string", request: { url: "string" } },
  notify: { callbackId: "string", notification: "object?" },
  "open-tab": { url: "string", active: "boolean?" },
  "close-tab": { tabId: "number" }
};

function typeOf(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function check(schema, value, path) {
  if (typeof schema === "string") {
    const optional = schema.endsWith("?");
    const type = optional ? schema.slice(0, -1) : schema;
    if (value == null) {
      if (!optional) throw new Error(`${path} is missing.`);
      return;
    }
    if (typeOf(value) !== type) throw new Error(`${path} should be a ${type}, not a ${typeOf(value)}.`);
    return;
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) throw new Error(`${path} should be a list.`);
    value.forEach((item, index) => check(schema[0], item, `${path}[${index}]`));
    return;
  }
  if (typeOf(value) !== "object") throw new Error(`${path} should be an object.`);
  for (const [key, field] of Object.entries(schema)) check(field, value[key], path ? `${path}.${key}` : key);
}

// Returns the message's schema, or throws a readable error when the type is unknown or a field has the wrong shape.
export function checkMessage(schemas, message) {
  if (typeOf(message) !== "object" || typeof message.type !== "string" || !Object.hasOwn(schemas, message.type)) {
    throw new Error("Unknown message.");
  }
  check(schemas[message.type], message, "");
  return schemas[message.type];
}

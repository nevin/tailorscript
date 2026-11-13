// Reference data for editor completions, hover docs and parameter hints.

const valueGet = { params: ["key: string", "fallback?: any"], doc: "Reads a value this script saved, or returns fallback when nothing is stored." };
const valueSet = { params: ["key: string", "value: any"], doc: "Saves a JSON-compatible value for this script. All values together can use up to 1 MB." };
const valueDelete = { params: ["key: string"], doc: "Deletes a value this script saved." };
const valueList = { params: [], doc: "Lists the keys of every value this script saved." };
const requestDetails = "details: { url, method?, headers?, data?, responseType?, timeout?, anonymous?, onload?, onerror?, ontimeout?, onabort? }";
const requestDoc = "Requests any URL from the page's own site or a host listed with @connect, without the page's CORS limits. responseType can be text, json, arraybuffer, blob or document.";
const menuDoc = "Adds a command under this script in the Tailorscript popup. Returns its id.";
const notificationDoc = "Shows a desktop notification. onclick runs when the user clicks it, ondone when it closes.";
const tabDoc = "Opens an http or https URL in a new tab next to this one.";

export const gmApis = {
  GM_info: { kind: "property", type: "object", doc: "Details about this script and Tailorscript: script.name, script.version, script.matches, scriptMetaStr and more. Always available." },
  "GM.info": { kind: "property", type: "object", doc: "Details about this script and Tailorscript. Always available." },
  GM_addStyle: { params: ["css: string"], returns: "HTMLStyleElement", doc: "Adds a <style> element with this CSS to the page." },
  "GM.addStyle": { params: ["css: string"], returns: "Promise<HTMLStyleElement>", doc: "Adds a <style> element with this CSS to the page." },
  GM_getValue: { ...valueGet, returns: "any", doc: `${valueGet.doc} Reads the copy taken when the page loaded.` },
  "GM.getValue": { ...valueGet, returns: "Promise<any>" },
  GM_setValue: { ...valueSet, returns: "void" },
  "GM.setValue": { ...valueSet, returns: "Promise<void>" },
  GM_deleteValue: { ...valueDelete, returns: "void" },
  "GM.deleteValue": { ...valueDelete, returns: "Promise<void>" },
  GM_listValues: { ...valueList, returns: "string[]" },
  "GM.listValues": { ...valueList, returns: "Promise<string[]>" },
  GM_xmlhttpRequest: { params: [requestDetails], returns: "{ abort() }", doc: requestDoc },
  "GM.xmlHttpRequest": { params: [requestDetails], returns: "Promise<Response> & { abort() }", doc: requestDoc },
  GM_registerMenuCommand: { params: ["caption: string", "onClick: () => void", "options?: { id? }"], returns: "string", doc: menuDoc },
  "GM.registerMenuCommand": { params: ["caption: string", "onClick: () => void", "options?: { id? }"], returns: "string", doc: menuDoc },
  GM_unregisterMenuCommand: { params: ["id: string"], returns: "void", doc: "Removes a command added with GM_registerMenuCommand." },
  "GM.unregisterMenuCommand": { params: ["id: string"], returns: "void", doc: "Removes a command added with GM.registerMenuCommand." },
  GM_notification: { params: ["details: { text, title?, timeout?, highlight?, silent?, onclick?, ondone? }"], returns: "void", doc: notificationDoc },
  "GM.notification": { params: ["details: { text, title?, timeout?, highlight?, silent?, onclick?, ondone? }"], returns: "Promise<void>", doc: notificationDoc },
  GM_setClipboard: { params: ["data: string", "type?: \"text\" | \"html\""], returns: "void", doc: "Copies text or HTML to the clipboard." },
  "GM.setClipboard": { params: ["data: string", "type?: \"text\" | \"html\""], returns: "Promise<void>", doc: "Copies text or HTML to the clipboard." },
  GM_openInTab: { params: ["url: string", "options?: boolean | { active?, loadInBackground? }"], returns: "{ close(), closed }", doc: tabDoc },
  "GM.openInTab": { params: ["url: string", "options?: { active?, loadInBackground? }"], returns: "Promise<{ close(), closed }>", doc: tabDoc },
  GM_getResourceText: { params: ["name: string"], returns: "string", doc: "Returns the text of a file declared with @resource." },
  "GM.getResourceText": { params: ["name: string"], returns: "Promise<string>", doc: "Returns the text of a file declared with @resource." },
  GM_getResourceURL: { params: ["name: string"], returns: "string", doc: "Returns a data: URL for a file declared with @resource." },
  "GM.getResourceUrl": { params: ["name: string"], returns: "Promise<string>", doc: "Returns a data: URL for a file declared with @resource." },
  unsafeWindow: { kind: "property", type: "Window", doc: "The window object. Scripts run in an isolated world, so add @inject-into page to reach the page's own variables." }
};

export function signature(name) {
  const api = gmApis[name];
  if (!api) return "";
  return api.kind === "property" ? `${name}: ${api.type}` : `${name}(${api.params.join(", ")}): ${api.returns}`;
}

export const metadataKeys = {
  name: "The script's name, shown in the library and popup.",
  namespace: "The author or project. With @name it identifies the script when you reinstall or update it.",
  version: "The script's version. Updates install only when the new @version is higher.",
  description: "What the script does, shown on the install page.",
  author: "Who wrote the script.",
  match: "A page the script runs on, as a Chrome match pattern such as https://example.com/*. Use one line per pattern.",
  include: "A page the script runs on, as a glob (* matches anything) or a /regular expression/.",
  "exclude-match": "A page the script never runs on, as a match pattern.",
  exclude: "A page the script never runs on, as a glob or a /regular expression/.",
  grant: "An API the script uses, such as GM_addStyle or GM.getValue. Use @grant none for none.",
  connect: "A host GM_xmlhttpRequest may contact besides the page's own site. * allows any host.",
  require: "A script URL loaded before this script, downloaded when you save.",
  resource: "A named file for GM_getResourceText: @resource name https://url",
  "run-at": "When the script runs: document-start, document-end, document-idle (default), or context-menu for Run now only.",
  "all-frames": "Also run inside frames on matching pages.",
  noframes: "Run only in the top-level page. This is the default.",
  "inject-into": "page runs the script in the page's own context so it can use the page's variables; content (default) keeps it isolated.",
  sandbox: "raw is the same as @inject-into page.",
  updateURL: "Where to check for a newer @version.",
  downloadURL: "Where to download updates from.",
  homepageURL: "The script's project page.",
  supportURL: "Where to report problems.",
  icon: "An icon for the script.",
  tag: "Labels for filtering the library, separated by spaces or commas.",
  license: "The script's license."
};

// Keys other managers define that Tailorscript accepts but doesn't use, so they aren't flagged as typos.
export const ignoredKeys = ["iconURL", "defaulticon", "icon64", "icon64URL", "homepage", "website", "source", "copyright",
  "contributionURL", "contributionAmount", "compatible", "incompatible", "antifeature", "unwrap", "nocompat", "webRequest", "author-url"];

export const metadataValues = {
  "run-at": ["document-start", "document-end", "document-idle", "context-menu"],
  "inject-into": ["content", "page"],
  sandbox: ["raw", "JavaScript", "DOM"]
};

// Userscript building blocks offered as snippets alongside the JavaScript ones.
export const userscriptSnippets = [
  { label: "waitFor", detail: "wait for an element", template: "function waitFor(selector) {\n\treturn new Promise(resolve => {\n\t\tconst found = document.querySelector(selector);\n\t\tif (found) return resolve(found);\n\t\tconst observer = new MutationObserver(() => {\n\t\t\tconst element = document.querySelector(selector);\n\t\t\tif (!element) return;\n\t\t\tobserver.disconnect();\n\t\t\tresolve(element);\n\t\t});\n\t\tobserver.observe(document.documentElement, { childList: true, subtree: true });\n\t});\n}\n\nwaitFor(\"${selector}\").then(element => {\n\t${}\n});" },
  { label: "observe", detail: "react to page changes", template: "new MutationObserver(() => {\n\t${}\n}).observe(document.body, { childList: true, subtree: true });" },
  { label: "addStyle", detail: "GM_addStyle block", template: "GM_addStyle(`\n\t${selector} {\n\t\t${}\n\t}\n`);" },
  { label: "request", detail: "GM.xmlHttpRequest", template: "const response = await GM.xmlHttpRequest({\n\turl: \"${https://}\",\n\tresponseType: \"json\"\n});\n${}" },
  { label: "menuCommand", detail: "popup command", template: "GM_registerMenuCommand(\"${Caption}\", () => {\n\t${}\n});" },
  { label: "keyboardShortcut", detail: "keydown handler", template: "document.addEventListener(\"keydown\", event => {\n\tif (event.target.closest(\"input, textarea, [contenteditable]\")) return;\n\tif (event.key === \"${k}\") {\n\t\t${}\n\t}\n});" }
];

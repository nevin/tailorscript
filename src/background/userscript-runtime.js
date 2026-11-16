// Serialized into every userscript world ahead of @require files and the script itself, so it must not reference
// anything outside its own body. Everything stays inside the closure except the APIs the script grants.
export function installRuntime(config) {
  const allowed = family => config.allowed.includes(family);
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const info = Object.freeze({ ...config.info, script: Object.freeze(config.info.script) });
  define("GM_info", info);
  const api = { info };

  const addStyle = css => {
    const style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).append(style);
    return style;
  };
  if (allowed("addStyle")) {
    define("GM_addStyle", addStyle);
    api.addStyle = async css => addStyle(css);
  }
  if (allowed("unsafeWindow")) define("unsafeWindow", window);

  // GM_addElement(tag, attributes) or GM_addElement(parent, tag, attributes): adds an element and returns it.
  if (allowed("addElement")) {
    const addElement = (...args) => {
      const [parent, tag, attributes] = typeof args[0] === "string" ? [null, args[0], args[1]] : args;
      const node = document.createElement(String(tag));
      for (const [name, value] of Object.entries(attributes ?? {})) {
        if (name === "textContent" || name === "innerText") node.textContent = String(value);
        else node.setAttribute(name, String(value));
      }
      const head = ["script", "style", "link", "meta"].includes(node.localName);
      (parent ?? (head ? document.head : document.body) ?? document.documentElement).append(node);
      return node;
    };
    define("GM_addElement", addElement);
    api.addElement = async (...args) => addElement(...args);
  }
  if (allowed("log")) {
    const log = (...args) => console.log(`[${config.info.script.name}]`, ...args);
    define("GM_log", log);
    api.log = async (...args) => log(...args);
  }
  // window.onurlchange: an urlchange event whenever a single-page app changes the address without loading a page.
  if (allowed("urlChange")) {
    const page = /** @type {any} */ (window);
    let last = location.href;
    const check = () => {
      if (location.href === last) return;
      last = location.href;
      const event = Object.assign(new Event("urlchange"), { url: last });
      if (typeof page.onurlchange === "function") page.onurlchange(event);
      dispatchEvent(event);
    };
    // Scripts test for this property to see whether the manager supports urlchange events.
    if (!("onurlchange" in page)) page.onurlchange = null;
    globalThis.navigation?.addEventListener("currententrychange", () => setTimeout(check));
    addEventListener("popstate", check);
    addEventListener("hashchange", check);
    setInterval(check, 500);
  }

  // Scripts injected into the page have no extension messaging, so they get only the APIs above.
  if (config.page) {
    define("GM", Object.freeze(api));
    return;
  }

  const send = message => chrome.runtime.sendMessage({ id: config.id, token: config.token, ...message });
  const report = message => {
    try {
      send(message).catch(() => {});
    } catch {
      // The extension can be reloading; reports are best effort.
    }
  };
  const call = async (type, payload) => {
    const reply = await send({ type, ...payload });
    if (reply?.error) throw new Error(reply.error);
    return reply?.value;
  };
  const warn = error => console.error(`[${config.info.script.name}]`, error);
  // crypto.randomUUID only exists on HTTPS pages, and scripts also run on plain HTTP.
  let counter = 0;
  const uniqueId = () => `${Date.now().toString(36)}-${++counter}-${Math.random().toString(36).slice(2)}`;
  Object.defineProperty(globalThis, Symbol.for("tailorscript.recipeRun"), {
    configurable: true,
    value: (revision, results) => report({ type: "recipe-run", revision, results })
  });
  report({ type: "run" });
  addEventListener("error", event => report({ type: "error", message: event.message, line: event.lineno, column: event.colno }));
  addEventListener("unhandledrejection", event => report({ type: "error", message: String(event.reason?.message ?? event.reason) }));

  const callbacks = new Map();
  Object.defineProperty(globalThis, Symbol.for("tailorscript.callback"), {
    value: (kind, id, detail) => {
      try {
        callbacks.get(`${kind}:${id}`)?.(detail);
      } catch (error) {
        warn(error);
      }
    }
  });

  // GM_getValue and friends are synchronous, so they read a snapshot taken when the script was registered.
  const cache = config.values;
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  // Change listeners hear about changes this script makes on this page; changes from other tabs aren't reported.
  const listeners = new Map();
  const changed = (key, before, after) => {
    for (const listener of listeners.values()) {
      if (listener.key !== key) continue;
      try {
        listener.callback(key, clone(before), clone(after), false);
      } catch (error) {
        warn(error);
      }
    }
  };
  const valueOp = async (op, key, value) => {
    const before = cache && op !== "get" && op !== "list" ? cache[key] : undefined;
    if (cache && op === "set") cache[key] = clone(value);
    if (cache && op === "delete") delete cache[key];
    if (listeners.size && (op === "set" || op === "delete")) changed(key, before, op === "set" ? value : undefined);
    return call("value", { op, key, value });
  };
  // The batch functions take a list of keys, or an object of keys and fallback values for getValues.
  const keysOf = spec => Array.isArray(spec) ? spec.map(String) : Object.keys(spec ?? {});
  const fallbackOf = (spec, key) => Array.isArray(spec) ? undefined : spec?.[key];
  if (allowed("getValue")) {
    api.getValue = async (key, fallback) => {
      const result = await valueOp("get", key);
      return result === undefined ? fallback : result;
    };
    if (cache) define("GM_getValue", (key, fallback) => key in cache ? clone(cache[key]) : fallback);
    api.getValues = async spec => {
      const result = {};
      for (const key of keysOf(spec)) {
        const value = await api.getValue(key, fallbackOf(spec, key));
        if (value !== undefined) result[key] = value;
      }
      return result;
    };
    if (cache) {
      define("GM_getValues", spec => Object.fromEntries(keysOf(spec)
        .map(key => [key, key in cache ? clone(cache[key]) : fallbackOf(spec, key)]).filter(([, value]) => value !== undefined)));
    }
  }
  if (allowed("setValue")) {
    api.setValue = async (key, value) => { await valueOp("set", key, value); };
    if (cache) define("GM_setValue", (key, value) => { valueOp("set", key, value).catch(warn); });
    api.setValues = async values => {
      for (const [key, value] of Object.entries(values ?? {})) await valueOp("set", key, value);
    };
    if (cache) define("GM_setValues", values => { api.setValues(values).catch(warn); });
  }
  if (allowed("deleteValue")) {
    api.deleteValue = async key => { await valueOp("delete", key); };
    if (cache) define("GM_deleteValue", key => { valueOp("delete", key).catch(warn); });
    api.deleteValues = async keys => {
      for (const key of keysOf(keys)) await valueOp("delete", key);
    };
    if (cache) define("GM_deleteValues", keys => { api.deleteValues(keys).catch(warn); });
  }
  if (allowed("valueListener")) {
    let next = 0;
    const add = (key, callback) => {
      const id = String(++next);
      listeners.set(id, { key: String(key), callback });
      return id;
    };
    const remove = id => { listeners.delete(String(id)); };
    define("GM_addValueChangeListener", add);
    define("GM_removeValueChangeListener", remove);
    api.addValueChangeListener = async (key, callback) => add(key, callback);
    api.removeValueChangeListener = async id => remove(id);
  }
  if (allowed("listValues")) {
    api.listValues = () => valueOp("list");
    if (cache) define("GM_listValues", () => Object.keys(cache));
  }

  const toBase64 = bytes => {
    let text = "";
    for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(text);
  };
  const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

  let request;
  if (allowed("xhr") || allowed("download")) {
    const encodeBody = async data => {
      if (data == null) return null;
      if (typeof data === "string") return { text: data };
      const body = new Response(data);
      return { base64: toBase64(new Uint8Array(await body.arrayBuffer())), contentType: body.headers.get("content-type") ?? "" };
    };
    const decodeResponse = (raw, details) => {
      const bytes = fromBase64(raw.body);
      const charset = raw.contentType.match(/charset=([\w-]+)/i)?.[1] ?? "utf-8";
      let text;
      const responseText = () => {
        if (text === undefined) {
          try {
            text = new TextDecoder(charset).decode(bytes);
          } catch {
            text = new TextDecoder().decode(bytes);
          }
        }
        return text;
      };
      const type = details.responseType ?? "";
      const response = {
        readyState: 4, status: raw.status, statusText: raw.statusText, finalUrl: raw.finalUrl,
        responseHeaders: raw.responseHeaders, context: details.context,
        get responseText() { return responseText(); },
        get responseXML() { return new DOMParser().parseFromString(responseText(), raw.contentType.includes("xml") ? "application/xml" : "text/html"); }
      };
      Object.defineProperty(response, "response", {
        enumerable: true,
        get() {
          if (type === "arraybuffer") return bytes.buffer;
          if (type === "blob") return new Blob([bytes], { type: raw.contentType });
          if (type === "document") return response.responseXML;
          if (type === "json") {
            try {
              return JSON.parse(responseText());
            } catch {
              return null;
            }
          }
          return responseText();
        }
      });
      return response;
    };
    request = details => {
      const requestId = uniqueId();
      let aborted = false;
      const fire = (name, value) => {
        try {
          details[name]?.(value);
        } catch (error) {
          warn(error);
        }
      };
      const failure = message => ({ readyState: 4, status: 0, statusText: "", responseHeaders: "", response: null, responseText: "",
        finalUrl: details.url, context: details.context, error: message });
      const promise = (async () => {
        const url = new URL(details.url, location.href).href;
        const raw = await call("xhr", { requestId, request: {
          method: String(details.method ?? "GET").toUpperCase(), url, headers: details.headers ?? {},
          body: await encodeBody(details.data), timeout: Number(details.timeout) || 0,
          anonymous: Boolean(details.anonymous), overrideMimeType: details.overrideMimeType ?? ""
        } });
        return decodeResponse(raw, details);
      })().then(response => {
        if (aborted) return response;
        fire("onreadystatechange", response);
        fire("onload", response);
        fire("onloadend", response);
        return response;
      }, error => {
        const response = failure(error.message);
        if (!aborted) {
          fire(error.message.startsWith("Timed out") ? "ontimeout" : "onerror", response);
          fire("onloadend", response);
        }
        throw Object.assign(new Error(error.message), { response });
      });
      return {
        promise,
        abort() {
          if (aborted) return;
          aborted = true;
          report({ type: "xhr-abort", requestId });
          fire("onabort", failure("Aborted"));
        }
      };
    };
  }
  if (allowed("xhr")) {
    define("GM_xmlhttpRequest", details => {
      const { promise, abort } = request(details);
      promise.catch(() => {});
      return { abort };
    });
    api.xmlHttpRequest = details => {
      const { promise, abort } = request(details);
      return Object.assign(promise, { abort });
    };
  }

  // GM_download(url, name) or GM_download({ url, name, headers, onload, onerror }): fetches like GM_xmlhttpRequest,
  // so other sites need @connect, then saves the file through a download link.
  if (allowed("download")) {
    const download = (details, name) => {
      const options = typeof details === "string" ? { url: details, name } : details ?? {};
      const { promise, abort } = request({ url: options.url, headers: options.headers, responseType: "blob", timeout: options.timeout });
      const saved = promise.then(response => {
        if (response.status >= 400) throw new Error(`The download failed with HTTP ${response.status}.`);
        const href = URL.createObjectURL(response.response);
        const link = document.createElement("a");
        link.href = href;
        link.download = options.name || decodeURIComponent(new URL(options.url, location.href).pathname.split("/").pop() || "") || "download";
        document.documentElement.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(href), 60_000);
        try {
          options.onload?.({ url: options.url });
        } catch (error) {
          warn(error);
        }
      }, error => {
        try {
          options.onerror?.({ error: "not_succeeded", details: error.message });
        } catch (callbackError) {
          warn(callbackError);
        }
        throw error;
      });
      return { saved, abort };
    };
    define("GM_download", (details, name) => {
      const { saved, abort } = download(details, name);
      saved.catch(() => {});
      return { abort };
    });
    api.download = (details, name) => {
      const { saved, abort } = download(details, name);
      return Object.assign(saved, { abort });
    };
  }

  if (allowed("menu")) {
    let next = 0;
    const register = (caption, onClick, options) => {
      const commandId = String((typeof options === "object" && options?.id) || ++next);
      callbacks.set(`menu:${commandId}`, () => onClick());
      report({ type: "menu", op: "add", commandId, caption: String(caption).slice(0, 120) });
      return commandId;
    };
    const unregister = commandId => {
      callbacks.delete(`menu:${commandId}`);
      report({ type: "menu", op: "remove", commandId: String(commandId) });
    };
    define("GM_registerMenuCommand", register);
    define("GM_unregisterMenuCommand", unregister);
    api.registerMenuCommand = register;
    api.unregisterMenuCommand = unregister;
  }

  if (allowed("notification")) {
    const notify = (details, title, image, onclick) => {
      const options = typeof details === "object" ? details : { text: details, title, image, onclick };
      const callbackId = uniqueId();
      callbacks.set(`notification-click:${callbackId}`, () => options.onclick?.());
      callbacks.set(`notification-done:${callbackId}`, () => {
        callbacks.delete(`notification-click:${callbackId}`);
        callbacks.delete(`notification-done:${callbackId}`);
        options.ondone?.();
      });
      return call("notify", { callbackId, notification: {
        title: String(options.title ?? config.info.script.name), text: String(options.text ?? ""),
        timeout: Number(options.timeout) || 0, highlight: Boolean(options.highlight), silent: Boolean(options.silent)
      } });
    };
    define("GM_notification", (...args) => { notify(...args).catch(warn); });
    api.notification = notify;
  }

  if (allowed("clipboard")) {
    const copy = async (data, type) => {
      const text = String(data);
      const html = (typeof type === "string" ? type : type?.type) === "html" || type?.mimetype === "text/html";
      try {
        if (html) await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([text], { type: "text/html" }) })]);
        else await navigator.clipboard.writeText(text);
      } catch {
        const field = document.createElement("textarea");
        field.value = text;
        field.style.cssText = "position:fixed;opacity:0;pointer-events:none";
        document.documentElement.append(field);
        field.select();
        const copied = document.execCommand("copy");
        field.remove();
        if (!copied) throw new Error("The page did not allow copying. Try again after clicking the page.");
      }
    };
    define("GM_setClipboard", (data, type) => { copy(data, type).catch(warn); });
    api.setClipboard = copy;
  }

  if (allowed("openInTab")) {
    const open = (url, options) => {
      const background = typeof options === "boolean" ? options : Boolean(options?.loadInBackground ?? options?.active === false);
      const tab = { closed: false, onclose: null, close() {} };
      const opened = call("open-tab", { url: new URL(url, location.href).href, active: !background }).then(tabId => {
        tab.close = () => {
          tab.closed = true;
          return call("close-tab", { tabId }).catch(warn);
        };
        return tab;
      });
      opened.catch(warn);
      return { tab, opened };
    };
    define("GM_openInTab", (url, options) => open(url, options).tab);
    api.openInTab = (url, options) => open(url, options).opened;
  }

  if (allowed("resources")) {
    const resource = name => {
      const entry = config.resources[name];
      if (!entry) throw new Error(`No @resource named ${name}.`);
      return entry;
    };
    const text = name => {
      const url = resource(name);
      const comma = url.indexOf(",");
      const [meta, data] = [url.slice(0, comma), url.slice(comma + 1)];
      return meta.endsWith(";base64") ? new TextDecoder().decode(fromBase64(data)) : decodeURIComponent(data);
    };
    define("GM_getResourceText", text);
    define("GM_getResourceURL", resource);
    api.getResourceText = async name => text(name);
    api.getResourceUrl = async name => resource(name);
  }

  define("GM", Object.freeze(api));
}

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
  const valueOp = async (op, key, value) => {
    if (cache && op === "set") cache[key] = clone(value);
    if (cache && op === "delete") delete cache[key];
    return call("value", { op, key, value });
  };
  if (allowed("getValue")) {
    api.getValue = async (key, fallback) => {
      const result = await valueOp("get", key);
      return result === undefined ? fallback : result;
    };
    if (cache) define("GM_getValue", (key, fallback) => key in cache ? clone(cache[key]) : fallback);
  }
  if (allowed("setValue")) {
    api.setValue = async (key, value) => { await valueOp("set", key, value); };
    if (cache) define("GM_setValue", (key, value) => { valueOp("set", key, value).catch(warn); });
  }
  if (allowed("deleteValue")) {
    api.deleteValue = async key => { await valueOp("delete", key); };
    if (cache) define("GM_deleteValue", key => { valueOp("delete", key).catch(warn); });
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

  if (allowed("xhr")) {
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
    const request = details => {
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

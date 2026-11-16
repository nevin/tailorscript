// Runs in a page-world script's own isolated world, next to the script itself running in the page. Scripts that run
// in the page (so they can use the page's own variables) have no extension messaging, so their GM calls come here as
// DOM events on a channel only the two halves know, and this half forwards them, signed with the script's token,
// which never enters the page. Callbacks from the worker, such as menu commands, go the other way.
//
// Serialized into the registration, so it must not reference anything outside its own body.
export function installBridge({ id, token, channel }) {
  const announce = () => document.dispatchEvent(new CustomEvent(`${channel}:ready`));
  document.addEventListener(`${channel}:request`, event => {
    let request;
    try {
      request = JSON.parse(/** @type {CustomEvent} */ (event).detail);
    } catch {
      return;
    }
    const reply = detail => document.dispatchEvent(new CustomEvent(`${channel}:reply`,
      { detail: JSON.stringify({ requestId: request.requestId, ...detail }) }));
    Promise.resolve()
      .then(() => chrome.runtime.sendMessage({ ...request.message, id, token }))
      .then(response => reply({ response }), error => reply({ failure: String(error?.message ?? error) }));
  });
  Object.defineProperty(globalThis, Symbol.for("tailorscript.callback"), {
    value: (kind, callbackId, detail) => document.dispatchEvent(new CustomEvent(`${channel}:callback`,
      { detail: JSON.stringify({ kind, id: callbackId, detail }) }))
  });
  // Either half can load first: the page half says hello, and this half answers or announces itself.
  document.addEventListener(`${channel}:hello`, announce);
  announce();
}

// Proves which script a message came from. Chrome doesn't tell the service worker which user script world sent a
// message, so each script's runtime gets a token derived from its ID and a secret that never leaves the extension.
// A script only ever sees its own token: worlds are isolated from each other and from the page.
import { getLocal } from "../shared/storage.js";

let key;

async function secretKey() {
  if (key) return key;
  let { bridgeSecret } = await getLocal("bridgeSecret");
  if (typeof bridgeSecret !== "string") {
    bridgeSecret = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    await chrome.storage.local.set({ bridgeSecret });
  }
  const bytes = Uint8Array.from(bridgeSecret.match(/../g), pair => parseInt(pair, 16));
  key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return key;
}

/** @param {string} id */
export async function tokenFor(id) {
  const signature = await crypto.subtle.sign("HMAC", await secretKey(), new TextEncoder().encode(id));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

// Throws unless the message carries the token for the script ID it claims.
export async function authenticate(message) {
  if (typeof message?.id !== "string" || typeof message.token !== "string" || message.token !== await tokenFor(message.id)) {
    throw new Error("This message didn’t come from a Tailorscript script.");
  }
  return message.id;
}

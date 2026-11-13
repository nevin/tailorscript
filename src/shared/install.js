// Sites whose .user.js links open the install page once the user turns on one-click installs.
export const installOrigins = [
  "https://greasyfork.org/*",
  "https://update.greasyfork.org/*",
  "https://openuserjs.org/*",
  "https://raw.githubusercontent.com/*",
  "https://gist.githubusercontent.com/*"
];

export function installPageUrl(url) {
  return `${chrome.runtime.getURL("install/install.html")}#${url}`;
}

export function isUserscriptUrl(url) {
  return /^https?:\/\/[^?#]+\.user\.js(?:[?#]|$)/.test(url ?? "");
}

export function findScriptsUrl(host) {
  return `https://greasyfork.org/scripts/by-site/${encodeURIComponent(host.replace(/^www\./, ""))}`;
}

const grantText = {
  addStyle: "Add styles to pages",
  getValue: "Read data it saved",
  setValue: "Save data in your browser",
  deleteValue: "Delete data it saved",
  listValues: "List data it saved",
  xhr: "Make requests to other websites",
  menu: "Add commands to the Tailorscript menu",
  notification: "Show desktop notifications",
  clipboard: "Copy text to your clipboard",
  openInTab: "Open new tabs",
  resources: "Use bundled files",
  info: "Read details about itself",
  unsafeWindow: "Use the page’s own variables",
  window: "Close or focus its window"
};

// Plain-language descriptions of what a script's @grant lines allow, for install and update reviews.
export function describeGrants(metadata, families) {
  const lines = Object.entries(families)
    .filter(([family, grants]) => family !== "info" && grants.some(grant => metadata.grants.includes(grant)))
    .map(([family]) => {
      if (family !== "xhr") return { text: grantText[family] };
      const hosts = metadata.connects.length ? metadata.connects.join(", ") : "only the page’s own site";
      return { text: `${grantText.xhr}: ${hosts}`, warning: metadata.connects.includes("*") };
    });
  return lines.length ? lines : [{ text: "Only change the pages it runs on" }];
}

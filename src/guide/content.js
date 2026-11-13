// The task-by-task part of the scripting guide. Each topic covers one group of GM APIs with a complete script that
// can be pasted into the editor as it is. Text between `backticks` is shown as code. Signatures and one-line
// descriptions come from manager/gm-api.js, so the guide and the editor's hover docs can't drift apart.

const header = (name, lines) => ["// ==UserScript==", `// @name        ${name}`, "// @match       https://example.com/*",
  ...lines.map(line => `// @${line}`), "// ==/UserScript==", ""].join("\n");

export const topics = [
  {
    id: "addStyle",
    title: "Change how a page looks",
    lead: "Give `GM_addStyle` some CSS and it is added to the page. This is the quickest way to restyle a site or hide parts of it, and it needs no other code.",
    apis: ["GM_addStyle", "GM.addStyle"],
    example: header("Bigger text, no banner", ["run-at      document-start", "grant       GM_addStyle"]) + `
GM_addStyle(\`
  body { font-size: 18px; }
  .banner, #newsletter-popup { display: none !important; }
\`);`,
    notes: [
      "Add `@run-at document-start` so the styles apply before the page is drawn. Without it the page can flash its original look first.",
      "If a rule doesn't take effect, the site's own CSS is probably more specific. Add `!important` to the declaration.",
      "To find the selector for something on a page, right-click it and choose Inspect."
    ]
  },
  {
    id: "values",
    title: "Remember things between visits",
    lead: "Ordinary variables are lost when the page reloads. Stored values are kept by Tailorscript, separately for each script, until you delete them. Use them for settings, counters or anything the script should remember.",
    apis: ["GM.getValue", "GM.setValue", "GM.deleteValue", "GM.listValues", "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues"],
    example: header("Count my visits", ["grant       GM.getValue", "grant       GM.setValue"]) + `
(async () => {
  // The second argument is what you get back when nothing has been saved yet.
  const visits = await GM.getValue("visits", 0);
  await GM.setValue("visits", visits + 1);
  console.log(\`You have opened this site \${visits + 1} times.\`);
})();`,
    notes: [
      "A value can be text, a number, true or false, a list or a plain object: anything JSON can hold. All of a script's values together can use up to 1 MB.",
      "The `GM.` versions return promises, so use them with `await` inside an `async` function, as the example does.",
      "The `GM_` versions answer straight away, without `await`. They read a copy of the values taken when the page loaded, so a change made in another tab shows up after a reload.",
      "Each script has its own values. One script can't read another's.",
      "To see or clear what a script has saved, open the script's ⋯ menu in the manager and choose Stored values."
    ]
  },
  {
    id: "xhr",
    title: "Get data from another site",
    lead: "A page's own `fetch` can usually talk only to the site it is on. `GM.xmlHttpRequest` can request any address you allow, which lets a script use an API or read another page.",
    apis: ["GM.xmlHttpRequest", "GM_xmlhttpRequest"],
    example: header("Show a quote", ["grant       GM.xmlHttpRequest", "connect     api.github.com"]) + `
(async () => {
  const response = await GM.xmlHttpRequest({
    url: "https://api.github.com/zen",
    responseType: "text"
  });
  if (response.status === 200) console.log("GitHub says:", response.response);
})();`,
    notes: [
      "List every site the script contacts with `@connect`, one host per line. A request to a host that isn't listed is refused, and the error tells you the line to add. The page's own site never needs listing.",
      "The reply has `status` (200 means OK), `responseText` (the body as text), `response` (the body in the form `responseType` asked for) and `responseHeaders`.",
      "Set `responseType: \"json\"` to get `response` as a ready-made object. It is `null` when the body isn't valid JSON.",
      "To send data, add `method: \"POST\"`, a `data` string and usually `headers: { \"Content-Type\": \"application/json\" }`.",
      "Requests carry your cookies for the site they contact, so they act as you. Add `anonymous: true` to send none.",
      "The older `GM_xmlhttpRequest` takes callbacks instead of returning a promise: pass `onload`, `onerror` and `ontimeout` functions in the same object.",
      "Both return an `abort()` function that cancels a request still in progress. `timeout` (in milliseconds) gives up automatically."
    ]
  },
  {
    id: "menu",
    title: "Add your own buttons to the popup",
    lead: "A menu command is a button with your caption, shown under the script in the Tailorscript toolbar popup. Clicking it runs your function on the page. It suits actions you want on demand instead of on every page load.",
    apis: ["GM_registerMenuCommand", "GM_unregisterMenuCommand", "GM.registerMenuCommand", "GM.unregisterMenuCommand"],
    example: header("Highlight links", ["grant       GM_registerMenuCommand"]) + `
GM_registerMenuCommand("Highlight links", () => {
  for (const link of document.links) link.style.background = "yellow";
});`,
    notes: [
      "The command appears after the script has run on the page, so reload the tab once after saving.",
      "`GM_registerMenuCommand` returns an id. Pass it to `GM_unregisterMenuCommand` to take the button away again.",
      "To change a caption, such as switching between “Turn on” and “Turn off”, remove the command and add it again with the new text."
    ]
  },
  {
    id: "notification",
    title: "Show a notification",
    lead: "`GM_notification` shows a desktop notification from Chrome, which you see even when the tab is in the background. Use it to announce that something finished or changed.",
    apis: ["GM_notification", "GM.notification"],
    example: header("Tell me when the page is ready", ["grant       GM_notification"]) + `
GM_notification({
  title: "Page ready",
  text: "example.com has finished loading.",
  timeout: 5000,
  onclick: () => console.log("You clicked the notification."),
  ondone: () => console.log("The notification closed.")
});`,
    notes: [
      "Only `text` is required. Without a `title` the script's name is used.",
      "`timeout` closes the notification after that many milliseconds. `silent: true` shows it without a sound.",
      "`onclick` runs when you click the notification, and `ondone` when it closes for any reason.",
      "If nothing appears, check that notifications are allowed for Chrome in your system settings and that Do Not Disturb is off."
    ]
  },
  {
    id: "clipboard",
    title: "Copy to the clipboard",
    lead: "`GM_setClipboard` puts text on the clipboard, ready to paste anywhere.",
    apis: ["GM_setClipboard", "GM.setClipboard"],
    example: header("Copy page title", ["grant       GM_setClipboard", "grant       GM_registerMenuCommand"]) + `
GM_registerMenuCommand("Copy title and address", () => {
  GM_setClipboard(\`\${document.title}\\n\${location.href}\`);
});`,
    notes: [
      "Chrome allows copying most reliably right after you have interacted with the page. Copying from a menu command or a click handler, as in the example, always works.",
      "Pass `\"html\"` as the second argument to copy formatted content instead of plain text."
    ]
  },
  {
    id: "openInTab",
    title: "Open a new tab",
    lead: "`GM_openInTab` opens an address in a new tab next to the current one. Unlike `window.open`, the popup blocker doesn't stop it.",
    apis: ["GM_openInTab", "GM.openInTab"],
    example: header("Open the docs", ["grant       GM_openInTab", "grant       GM_registerMenuCommand"]) + `
GM_registerMenuCommand("Open the documentation", () => {
  GM_openInTab("https://developer.mozilla.org/", { active: true });
});`,
    notes: [
      "`{ active: false }` opens the tab in the background and keeps you on the current page.",
      "The result has a `close()` function that closes the tab the script opened.",
      "Only http and https addresses can be opened."
    ]
  },
  {
    id: "resources",
    title: "Bundle files with your script",
    lead: "`@resource` gives a file a name and downloads it once, when you save the script. The script can then read it instantly on every page, with no request and no `@connect`. It suits stylesheets, data files and images.",
    apis: ["GM_getResourceText", "GM_getResourceURL", "GM.getResourceText", "GM.getResourceUrl"],
    example: header("Use a ready-made stylesheet", [
      "resource    theme https://cdn.jsdelivr.net/npm/water.css@2/out/water.css",
      "grant       GM_getResourceText", "grant       GM_addStyle"
    ]) + `
GM_addStyle(GM_getResourceText("theme"));`,
    notes: [
      "The line is `@resource`, then the name you choose, then the address of the file.",
      "`GM_getResourceText` returns the file's contents as text. `GM_getResourceURL` returns an address you can use as an image's `src` or a link's `href`.",
      "The file is downloaded again when you save the script or when an update is installed, so the script keeps working if the site hosting the file is slow or offline.",
      "To load a JavaScript library, use `@require` with its address instead. It runs before your code, and needs no `@grant`."
    ]
  },
  {
    id: "info",
    title: "Read details about your script",
    lead: "`GM_info` is an object describing the script and the manager running it. It is always available, with no `@grant` line.",
    apis: ["GM_info", "GM.info"],
    example: header("Say which version is running", ["version     1.0.0", "grant       none"]) + `
console.log(\`\${GM_info.script.name} \${GM_info.script.version} is running in \${GM_info.scriptHandler}.\`);`,
    notes: [
      "`GM_info.script` has the header's `name`, `version`, `description`, `matches` and more. `GM_info.scriptMetaStr` is the whole header as text.",
      "`GM_info.scriptHandler` is “Tailorscript”, which lets a script written for several managers tell where it is running."
    ]
  },
  {
    id: "unsafeWindow",
    title: "Use the page's own variables",
    lead: "Scripts run apart from the page's JavaScript. They share the page's content, so `document` works as usual, but they can't see variables or functions the page defined. Add `@inject-into page` to run inside the page instead.",
    apis: ["unsafeWindow"],
    example: header("Read a page variable", ["inject-into page", "grant       unsafeWindow"]) + `
// A page that sets window.appConfig can be read like this.
console.log("The page's settings:", unsafeWindow.appConfig);`,
    notes: [
      "With `@inject-into page` the script can call the page's functions and the page can see the script's. Use it only on sites you trust.",
      "A script running inside the page can use only `GM_addStyle`, `GM_info` and `unsafeWindow`. Stored values, requests, menu commands and the rest need the default, separate mode.",
      "Most scripts never need this. Reading and changing what is on the page works without it."
    ]
  }
];

// What usually goes wrong for someone new, and how to fix it.
export const mistakes = [
  {
    problem: "“GM_setValue is not defined”",
    fix: "The header has no `@grant` line for that API. Add `// @grant GM_setValue`, or use the quick fix the editor offers on the underlined name. Each spelling is granted separately: `GM_setValue` and `GM.setValue` are two different lines."
  },
  {
    problem: "The header says `@grant none` and a GM function fails",
    fix: "`none` means the script asked for no APIs. Replace it with a `@grant` line for each API the script uses."
  },
  {
    problem: "A request fails with “Add // @connect …”",
    fix: "Copy the line from the error into the header. Every site a script contacts must be listed, including the site a request is redirected to."
  },
  {
    problem: "`GM.getValue` gives “[object Promise]” instead of the value",
    fix: "The `GM.` functions return promises. Put `await` in front of the call, inside an `async` function, or switch to `GM_getValue`, which returns the value directly."
  },
  {
    problem: "The script doesn't run at all",
    fix: "Check four things: the script is Enabled and saved; its `@match` line covers the page's address (use Check a page in the manager); Allow User Scripts is on in Tailorscript's extension details; and the tab was reloaded after saving."
  },
  {
    problem: "The script runs before the element it needs exists",
    fix: "Many sites add content after loading. Start from the “Wait for an element” template, which runs your code once the element appears."
  },
  {
    problem: "The script can't see a variable the page defines",
    fix: "Scripts run apart from the page's JavaScript. See “Use the page's own variables” above."
  }
];

const header = (name, extra = []) => ["// ==UserScript==", `// @name        ${name}`,
  "// @match       https://example.com/*", ...extra, "// ==/UserScript==", ""].join("\n");

export const templates = [
  { name: "Blank script", description: "Only the metadata block.", source: "" },
  {
    name: "Add CSS",
    description: "Restyle a site with a stylesheet.",
    source: header("Custom styles", ["// @run-at      document-start", "// @grant       GM_addStyle"]) + `
GM_addStyle(\`
  body {
    font-size: 18px;
  }
\`);`
  },
  {
    name: "Hide elements",
    description: "Remove clutter that matches CSS selectors, including content that loads later.",
    source: header("Hide clutter", ["// @run-at      document-start", "// @grant       GM_addStyle"]) + `
const selectors = [".banner", "#newsletter-popup"];

GM_addStyle(\`\${selectors.join(", ")} { display: none !important; }\`);`
  },
  {
    name: "Auto-click a button",
    description: "Click a button as soon as it appears.",
    source: header("Auto-click", ["// @grant       none"]) + `
const selector = "button.accept";

const observer = new MutationObserver(() => {
  const button = document.querySelector(selector);
  if (!button) return;
  observer.disconnect();
  button.click();
});
observer.observe(document.documentElement, { childList: true, subtree: true });`
  },
  {
    name: "Keyboard shortcut",
    description: "Run code when you press a key outside text fields.",
    source: header("Keyboard shortcut", ["// @grant       none"]) + `
addEventListener("keydown", event => {
  if (event.target.closest("input, textarea, [contenteditable]")) return;
  if (event.key === "j" && !event.metaKey && !event.ctrlKey) {
    scrollBy({ top: innerHeight * 0.8, behavior: "smooth" });
  }
});`
  },
  {
    name: "Wait for an element",
    description: "Run code once a selector exists, even on single-page apps.",
    source: header("Wait for element", ["// @grant       none"]) + `
function waitFor(selector) {
  return new Promise(resolve => {
    const found = document.querySelector(selector);
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (!element) return;
      observer.disconnect();
      resolve(element);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

waitFor("main").then(main => {
  main.style.outline = "2px solid rebeccapurple";
});`
  },
  {
    name: "Remember a setting",
    description: "Store values between page loads with GM.getValue and GM.setValue.",
    source: header("Remember a setting", ["// @grant       GM.getValue", "// @grant       GM.setValue"]) + `
(async () => {
  const visits = await GM.getValue("visits", 0);
  await GM.setValue("visits", visits + 1);
  console.log(\`You have opened this site \${visits + 1} times.\`);
})();`
  },
  {
    name: "Menu command",
    description: "Add a button to the Tailorscript popup that runs code on this page.",
    source: header("Menu command", ["// @grant       GM_registerMenuCommand"]) + `
GM_registerMenuCommand("Highlight links", () => {
  for (const link of document.links) link.style.background = "yellow";
});`
  },
  {
    name: "Fetch from another site",
    description: "Request data from an API with GM.xmlHttpRequest and @connect.",
    source: header("Fetch data", ["// @grant       GM.xmlHttpRequest", "// @connect     api.github.com"]) + `
(async () => {
  const response = await GM.xmlHttpRequest({ url: "https://api.github.com/zen", responseType: "text" });
  console.log("GitHub says:", response.responseText);
})();`
  }
];

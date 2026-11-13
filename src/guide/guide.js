// The scripting guide: static explanations in guide.html, plus the API tasks, common mistakes and header keys
// rendered here from content.js and the editor's own reference data.
import { gmApis, metadataKeys, signature } from "../manager/gm-api.js";
import { $ } from "../shared/dom.js";
import { grantFamilies } from "../shared/userscript.js";
import { mistakes, topics } from "./content.js";
import { highlight, richText, topicFor } from "./render.js";

const managerUrl = new URL("../manager/index.html", location.href).href;
const topicList = $("#topics");
const topicLinks = $("#topic-links");
const filter = $("#filter", HTMLInputElement);

function element(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function code(source) {
  return element("pre", "code", ...highlight(source).map(({ text, kind }) => kind ? element("span", `tok-${kind}`, text) : text));
}

function button(label, action, className) {
  const node = element("button", className, label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

// Hands the example to the manager, which opens it as a new unsaved script.
async function startScript(source) {
  await chrome.storage.session.set({ newScriptSource: source });
  const [existing] = await chrome.tabs.query({ url: managerUrl });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: managerUrl });
  }
}

function apiEntry(name) {
  const always = grantFamilies.info.includes(name);
  const entry = element("div", "",
    element("dt", "", signature(name)),
    element("dd", "", gmApis[name].doc,
      element("span", "grant", ...(always ? ["Always available, with no @grant line."] : ["Header line: ", element("code", "", `// @grant ${name}`)]))));
  entry.id = name;
  return entry;
}

function renderTopic(topic) {
  const status = element("span", "");
  status.setAttribute("role", "status");
  const section = element("article", "topic",
    element("h3", "", topic.title),
    element("p", "", ...richText(topic.lead)),
    element("h4", "", "Example"),
    code(topic.example),
    element("div", "example-actions",
      button("Start a script from this", () => startScript(topic.example).catch(error => { status.textContent = error.message; }), "primary"),
      button("Copy", async () => {
        await navigator.clipboard.writeText(topic.example);
        status.textContent = "Copied.";
      }),
      status),
    element("h4", "", "Good to know"),
    element("ul", "", ...topic.notes.map(note => element("li", "", ...richText(note)))),
    element("h4", "", topic.apis.length === 1 ? "The API" : "The APIs"),
    element("dl", "api-list", ...topic.apis.map(apiEntry)));
  section.id = topic.id;
  return section;
}

function link(href, text) {
  const anchor = element("a", "", text);
  anchor.href = href;
  return element("li", "", anchor);
}

$("#anatomy").replaceChildren(...code(`// ==UserScript==
// @name        Purple headings
// @match       https://example.com/*
// @grant       none
// ==/UserScript==

document.querySelector("h1").style.color = "rebeccapurple";`).childNodes);
$("#grant-example").replaceChildren(...code(`// ==UserScript==
// @name        Remember my name
// @match       https://example.com/*
// @grant       GM_setValue
// @grant       GM_getValue
// ==/UserScript==

GM_setValue("name", "Sam");
console.log(GM_getValue("name"));   // "Sam", today and on every later visit`).childNodes);

topicList.replaceChildren(...topics.map(renderTopic));
topicLinks.replaceChildren(...topics.map(topic => link(`#${topic.id}`, topic.title)));
$("#mistake-list").replaceChildren(...mistakes.flatMap(({ problem, fix }) =>
  [element("dt", "", ...richText(problem)), element("dd", "", ...richText(fix))]));
$("#metadata-list").replaceChildren(...Object.entries(metadataKeys).flatMap(([key, doc]) => {
  const term = element("dt", "", element("code", "", `@${key}`));
  term.id = `meta-${key}`;
  return [term, element("dd", "", doc)];
}));

// Narrows the API tasks to those mentioning every word typed.
filter.addEventListener("input", () => {
  const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  topics.forEach((topic, index) => {
    const section = topicList.children[index];
    const hidden = !words.every(word => section.textContent.toLowerCase().includes(word));
    /** @type {HTMLElement} */ (section).hidden = hidden;
    /** @type {HTMLElement} */ (topicLinks.children[index]).hidden = hidden;
    if (!hidden) shown++;
  });
  $("#filter-empty").hidden = shown > 0;
  if (words.length && shown) $("#apis").scrollIntoView();
});

// The editor links here with an API's name, such as #GM_setValue; show the task that explains it.
function showTarget() {
  const name = decodeURIComponent(location.hash.slice(1));
  for (const section of topicList.children) section.classList.remove("found");
  const topic = topicFor(name);
  if (!topic) return;
  const section = $(`#${topic.id}`);
  section.classList.add("found");
  section.scrollIntoView();
}
addEventListener("hashchange", showTarget);
showTarget();

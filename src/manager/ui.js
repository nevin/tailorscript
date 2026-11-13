// Small DOM helpers shared by the manager and its dialogs.
import { $ } from "../shared/dom.js";

export const review = $("#review", HTMLDialogElement);
const reviewTitle = $("#review-title");
const reviewContent = $("#review-content");

export function openReview(heading, ...content) {
  reviewTitle.textContent = heading;
  reviewContent.replaceChildren(...content);
  if (!review.open) review.showModal();
}

export function makeButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function bulletList(items) {
  const node = element("ul", undefined, "plain-list");
  node.append(...items.map(({ text, warning }) => element("li", text, warning ? "warning-item" : "")));
  return node;
}

// A labelled on/off switch with a line of help underneath.
export function switchControl(title, help, checked, onChange) {
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "switch";
  toggle.setAttribute("role", "switch");
  toggle.checked = checked;
  toggle.addEventListener("change", () => onChange(toggle));
  const label = element("label", undefined, "switch-label");
  const text = element("span", title);
  text.append(element("small", help));
  label.append(toggle, text);
  return label;
}

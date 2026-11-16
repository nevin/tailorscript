import { explainMatch, parseSource } from "../shared/userscript.js";
import { element } from "./ui.js";

export function urlCheck(getSource, initial = "") {
  const box = element("div", undefined, "url-check");
  const label = element("label", "Test a page URL");
  const input = document.createElement("input");
  input.type = "url";
  input.placeholder = "https://example.com/page";
  input.value = initial;
  const result = element("p");
  result.setAttribute("role", "status");
  label.append(input);
  box.append(label, result);
  function update() {
    result.textContent = "";
    if (!input.value.trim()) return;
    try {
      const url = new URL(input.value.trim());
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      result.textContent = explainMatch(parseSource(getSource()), url);
    } catch (error) {
      result.textContent = error.message || "Enter a valid HTTP or HTTPS URL.";
    }
  }
  input.addEventListener("input", update);
  update();
  return box;
}

// Words people see come from _locales/<language>/messages.json through Chrome's i18n API, so Tailorscript can be
// translated by adding a folder there. Pages put a message's name in a data-i18n attribute (or data-i18n-title,
// data-i18n-aria-label and so on for attributes) and call localize(); scripts call t(). In a message, *words* are
// shown in bold.

/** @param {string} key @param {...(string | number)} substitutions */
export function t(key, ...substitutions) {
  return chrome.i18n.getMessage(key, substitutions.map(String)) || key;
}

function rich(text) {
  return text.split("*").map((part, index) => {
    if (index % 2 === 0) return part;
    const strong = document.createElement("strong");
    strong.textContent = part;
    return strong;
  }).filter(part => part !== "");
}

export function localize(root = document) {
  for (const element of root.querySelectorAll("*")) {
    for (const { name, value } of [...element.attributes]) {
      if (name === "data-i18n") element.replaceChildren(...rich(t(value)));
      else if (name.startsWith("data-i18n-")) element.setAttribute(name.slice("data-i18n-".length), t(value));
    }
  }
}

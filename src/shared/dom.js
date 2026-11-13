// Finds a required element and checks its type, so a renamed id or changed tag fails loudly at startup
// instead of as an undefined property later. The type also tells the type checker what the element is.
/**
 * @template {Element} [T=HTMLElement]
 * @param {string} selector
 * @param {{ new (): T, prototype: T }} [type]
 * @param {ParentNode} [root]
 * @returns {T}
 */
export function $(selector, type = /** @type {any} */ (HTMLElement), root = document) {
  const found = root.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`Expected ${selector} to be a ${type.name}.`);
  return found;
}

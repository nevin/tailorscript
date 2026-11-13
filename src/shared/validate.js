import { parse } from "../vendor/acorn/acorn.mjs";
import { parseSource } from "./userscript.js";

export function validate(source) {
  try {
    parse(source, { ecmaVersion: "latest" });
  } catch (error) {
    throw new Error(`JavaScript: ${error.message}`, { cause: error });
  }
  return parseSource(source);
}

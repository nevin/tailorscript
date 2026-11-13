import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist/", "release/", "node_modules/", "src/vendor/"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module"
    },
    rules: {
      "no-unused-vars": ["error", { args: "after-used", ignoreRestSiblings: true, caughtErrors: "none" }],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }]
    }
  },
  {
    files: ["src/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } }
  },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs", "eslint.config.mjs"],
    languageOptions: { globals: globals.node }
  },
  {
    // Tests install an in-memory chrome object before importing extension code.
    files: ["tests/**/*.mjs"],
    languageOptions: { globals: { chrome: "writable" } }
  }
];

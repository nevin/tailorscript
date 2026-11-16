import { actions } from "./generator.js";

export function recipeBackup(recipe) {
  const page = new URL(recipe.page);
  return JSON.stringify({ format: "tailorscript-visual-recipe", version: 1, recipe: {
    ...recipe, page: page.origin + page.pathname
  } }, null, 2);
}

export function parseRecipeBackup(text) {
  const file = JSON.parse(text);
  const data = file?.recipe;
  if (file?.format !== "tailorscript-visual-recipe" || file.version !== 1 || data?.version !== 2) {
    throw new Error("Choose a Tailorscript visual recipe JSON backup.");
  }
  const page = new URL(data.page);
  if (!["http:", "https:"].includes(page.protocol) || page.username || page.password ||
      !["site", "path"].includes(data.scope) || !Array.isArray(data.steps) || !data.steps.length || data.steps.length > 100) {
    throw new Error("The backup needs an HTTP(S) target and between 1 and 100 steps.");
  }
  const strings = ["name", "namespace", "scriptVersion"];
  if (typeof data.name !== "string" || strings.some(key => data[key] !== undefined &&
      (typeof data[key] !== "string" || /[\r\n\u2028\u2029]/.test(data[key])))) {
    throw new Error("Recipe name, namespace, and version must be single lines.");
  }
  const steps = data.steps.map(step => {
    if (!step || !Object.hasOwn(actions, step.action) || typeof step.selector !== "string" || !step.selector.trim() ||
        (step.expectedCount !== undefined && (!Number.isSafeInteger(step.expectedCount) || step.expectedCount < 1))) {
      throw new Error("A step has an invalid action, selector, or expected count.");
    }
    const fields = ["text", "label", "value", "tag", "one", "oneText", "plain"];
    if (fields.some(key => step[key] !== undefined && typeof step[key] !== "string")) {
      throw new Error("A recipe step has an invalid text field.");
    }
    const group = typeof step.group?.selector === "string" && Number.isSafeInteger(step.group.count) && step.group.count > 0
      ? { selector: step.group.selector, count: step.group.count } : undefined;
    return {
      selector: step.selector, action: step.action, all: Boolean(step.all), expectedCount: step.expectedCount, group,
      ...Object.fromEntries(fields.filter(key => step[key] !== undefined).map(key => [key, step[key]])),
      label: step.label || step.selector
    };
  });
  return {
    version: 2, name: data.name, page: page.origin + page.pathname, scope: data.scope,
    watch: Boolean(data.watch), namespace: data.namespace, scriptVersion: data.scriptVersion, steps
  };
}

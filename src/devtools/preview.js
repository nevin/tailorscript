// Serialized into the inspected page along with the runner.
export function previewPage(createRunner, steps, origin, path, createLocator) {
  const key = Symbol.for("tailorscript.builderPreview");
  window[key]?.();
  if (!steps) return [];
  if (location.origin !== origin || (path !== null && location.pathname !== path)) {
    return ["Preview skipped · this page is outside the recipe’s scope."];
  }
  const runner = createRunner(steps, true, createLocator());
  // A safety net for when DevTools closes without telling the panel.
  const timer = setTimeout(cleanup, 5 * 60 * 1000);
  function cleanup() {
    clearTimeout(timer);
    runner.undo();
    if (window[key] === cleanup) delete window[key];
  }
  window[key] = cleanup;
  try {
    return runner.run();
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Library writes go through one queue so concurrent messages never overwrite each other's changes.
let pending = Promise.resolve();
let runsPending = Promise.resolve();

export function enqueue(operation) {
  const result = pending.then(operation);
  pending = result.catch(error => console.warn(error.message));
  return result;
}

// Page loads report often, so runs get their own queue instead of waiting behind saves.
export function enqueueRun(operation) {
  runsPending = runsPending.then(operation).catch(error => console.warn(error.message));
}

export function ignore() {}

/** Serialize mutations across webhooks, slash commands and reconciliation. */
export function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(work) {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
}

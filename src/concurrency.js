/** Runs `worker(item)` over `items` with at most `limit` in flight at once. */
export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function runOne() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runOne);
  await Promise.all(workers);
  return results;
}

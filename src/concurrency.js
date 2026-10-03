/**
 * Runs `worker(item)` over `items` with at most `limit` in flight at once —
 * for work that can be put back and paused.
 *
 * - `requeue(item)` (passed to the worker) returns an item to the back of the
 *   queue, so a card that hit an outage is retried later instead of being
 *   marked failed.
 * - `gate()` is awaited before each item is taken; it blocks while the run is
 *   paused (bad key, no credits) or waiting for the network to come back, so
 *   nothing is sent during either.
 *
 * Finishes when the queue is empty and nothing is in flight that could still
 * requeue more work.
 */
export async function runQueue(items, limit, worker, { gate } = {}) {
  const queue = [...items];
  let active = 0;
  const requeue = (item) => { queue.push(item); };

  async function runOne() {
    for (;;) {
      if (gate) await gate();
      const item = queue.shift();
      if (item === undefined) {
        if (active === 0) return;
        // Someone still in flight may hand work back; wait and look again.
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      active++;
      try {
        await worker(item, { requeue });
      } finally {
        active--;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, Math.max(1, queue.length))) }, runOne);
  await Promise.all(workers);
}

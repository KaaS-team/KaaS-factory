// A worker pool of fixed size, not `Promise.all` over every item at once and
// not one-at-a-time. Before this, pollOnce ran every ready issue's whole
// stage chain sequentially — issue #4 never started until #1 finished
// (audit finding #2). concurrency here is the same knob as the target's
// `.factory/config.json` concurrency field.

export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

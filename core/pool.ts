/**
 * Bounded worker pool with adaptive throttling (design: docs/parallel-publish.md).
 *
 * Workers pull from a shared queue, so the pool never over-fetches: the number
 * of in-flight items is at most `limit`. When the Drive client reports a rate
 * limit, `halve()` drops the active limit - workers whose rank is above the new
 * limit simply stop pulling - and the floor is 1, so throttling degrades to
 * sequential, never to zero.
 *
 * Errors: the first failing item stops new pulls; in-flight items finish so
 * no partial write is abandoned mid-call. The error of the *lowest item index*
 * is rethrown so which error surfaces does not depend on completion order.
 */

export class AdaptivePool {
  readonly maxLimit: number;
  private activeLimit: number;

  constructor(maxLimit: number) {
    this.maxLimit = Math.max(1, maxLimit);
    this.activeLimit = this.maxLimit;
  }

  /** Concurrency in effect right now (never above the initial limit). */
  get limit(): number {
    return this.activeLimit;
  }

  /** Cut the active limit in half (floor 1). Never scales back up. */
  halve(): void {
    this.activeLimit = Math.max(1, Math.floor(this.activeLimit / 2));
  }

  /**
   * Run `work` over `items` with at most `limit` in flight, each item exactly
   * once, in pull order (which is items order at limit 1).
   */
  async run<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const errors: { index: number; error: unknown }[] = [];
    const workerCount = Math.max(1, Math.min(this.activeLimit, items.length));
    const workers = Array.from({ length: workerCount }, async (_unused, rank) => {
      while (next < items.length && errors.length === 0) {
        if (rank >= this.activeLimit) return; // throttled off mid-run
        const index = next++;
        const item = items[index] as T;
        try {
          await work(item);
        } catch (e) {
          errors.push({ index, error: e });
        }
      }
    });
    await Promise.all(workers);
    if (errors.length > 0) {
      const first = errors.sort((a, b) => a.index - b.index)[0] as { error: unknown };
      throw first.error;
    }
  }
}

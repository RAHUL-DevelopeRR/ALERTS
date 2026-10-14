/**
 * A FIFO promise queue: tasks run one at a time in submission order. A failing task never blocks the queue.
 * Both Db adapters use it so that a transaction holds the connection for its whole callback.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const p = this.tail.then(() => task());
    this.tail = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}

/** Positional params for both adapters: undefined -> null, booleans -> 0/1 (defensive; SqlValue excludes them). */
export function normParams(params?: readonly unknown[]): (string | number | null)[] {
  if (!params) return [];
  return params.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number' || typeof v === 'string') return v;
    if (typeof v === 'bigint') return Number(v);
    throw new TypeError(`Unsupported SQL parameter type: ${typeof v}`);
  });
}

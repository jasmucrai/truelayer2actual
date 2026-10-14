/**
 * Async mutexes used to serialise access to shared state.
 *
 * Ordering rule: a full sync takes `syncLock` first, then briefly takes
 * `stateLock` for read-modify-write sections, and `withBudget` is never taken
 * while holding `stateLock`. This keeps critical sections short and avoids
 * deadlock.
 */
export type Mutex = <T>(fn: () => T | Promise<T>) => Promise<T>;

export function createMutex(): Mutex {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = chain.then(() => fn());
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

/** Protects `data/config.json` and `data/tokens.json` read-modify-write. */
export const withStateLock = createMutex();

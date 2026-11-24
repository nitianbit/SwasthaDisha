/**
 * Shared by the background workers that claim a row before slow work (Meet retry, card follow-up, SMS notices).
 *
 * `freeLease(path)`: the filter part "nobody holds this row now" — no lease, or one already past on the wall clock.
 * `withDeadline(ms, fn)`: runs `fn` with a signal that aborts after `ms`, and gives up at that moment even if `fn`
 * ignores the signal, so a hanging call can never outlive the caller's lease.
 */
export const freeLease = (path: string): Record<string, unknown> =>
  ({ $or: [{ [path]: { $exists: false } }, { [path]: { $lte: new Date() } }] });

export async function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>, error: () => Error): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  const gaveUp = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(error()), { once: true }));
  return Promise.race([fn(signal), gaveUp]);
}

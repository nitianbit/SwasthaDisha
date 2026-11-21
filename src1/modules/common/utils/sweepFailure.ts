/**
 * Q16a: a scheduler sweep handles each row on its own — one failing row is logged and skipped (retried on the next run)
 * so it can never stop the rows after it. The log names the sweep, the row id and the error code/message only: never
 * patient details, phone numbers or amounts.
 */
export function sweepFailure(sweep: string, id: string, e: unknown): void {
  const x = e as { code?: unknown; message?: unknown } | undefined;
  console.error(`${sweep} failed for one row; continuing`, { id, code: x?.code, error: typeof x?.message === 'string' ? x.message : String(e) });
}

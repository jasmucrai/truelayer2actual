/** Shared HTTP timeout so a hung peer can never wedge the scheduler. */
export const HTTP_TIMEOUT_MS = 15_000;

/**
 * Extract a compact, safe description from an upstream error response body.
 * Prefer the standard OAuth `error` / `error_description` fields; fall back to
 * the body only when it has neither (avoids echoing arbitrary upstream
 * payloads into user-facing messages and logs).
 */
export function describeErrorBody(data: unknown): string {
  if (data && typeof data === 'object') {
    const { error, error_description } = data as Record<string, unknown>;
    if (typeof error === 'string' && typeof error_description === 'string') {
      return `${error} — ${error_description}`;
    }
    if (typeof error === 'string') return error;
    if (typeof error_description === 'string') return error_description;
  }
  return JSON.stringify(data) ?? 'unknown error';
}

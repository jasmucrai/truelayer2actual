/**
 * Flatten an error into a compact human-readable string that also digs out
 * nested detail (Actual's `meta.reason` / `meta.error.message`, axios
 * response bodies, `cause` chains) that plain `err.message` drops. Used for
 * logs and user-facing diagnostics — never throws.
 */
export function describeError(err: unknown): string {
  if (err === null || err === undefined) return String(err);
  if (typeof err !== 'object') return String(err);

  const parts: string[] = [];
  const e = err as Record<string, unknown>;

  const name = e.name instanceof String || typeof e.name === 'string' ? e.name : undefined;
  const message = typeof e.message === 'string' ? e.message : undefined;
  if (message) parts.push(name && name !== 'Error' ? `${name}: ${message}` : message);

  // Actual sync errors: { reason, meta: { error: { message }, query } }
  const meta = e.meta as Record<string, unknown> | undefined;
  if (meta && typeof meta === 'object') {
    if (typeof meta.reason === 'string') parts.push(`reason=${meta.reason}`);
    const metaError = meta.error as Record<string, unknown> | undefined;
    if (metaError && typeof metaError === 'object' && typeof metaError.message === 'string') {
      parts.push(metaError.message);
    }
  }
  if (typeof e.reason === 'string' && e.reason !== meta?.reason) parts.push(`reason=${e.reason}`);

  // Axios-style response bodies.
  const response = e.response as { data?: unknown } | undefined;
  if (response && typeof response === 'object' && response.data !== undefined) {
    parts.push(JSON.stringify(response.data));
  }

  // Wrapped error chains.
  const cause = e.cause;
  if (cause instanceof Error && cause.message && cause.message !== message) {
    parts.push(`cause: ${describeError(cause)}`);
  }

  if (parts.length === 0) {
    // Last resort: stringify own enumerable properties (drops circulars).
    try {
      const s = JSON.stringify(err, Object.getOwnPropertyNames(err as object));
      return s === '{}' || s === undefined ? String(err) : s;
    } catch {
      return String(err);
    }
  }
  return parts.join(' — ');
}

/**
 * Structured logs redact values by default; callers explicitly opt in to
 * non-sensitive metadata rather than accidentally logging PII.
 */
export function log(
  event: string,
  fields: { actorId?: string; traceId?: string; [key: string]: unknown } = {},
) {
  const safeFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key.toLowerCase().includes('email') || key.toLowerCase().includes('name')
        ? '[REDACTED]'
        : value,
    ]),
  );
  console.info(
    JSON.stringify({
      event,
      ...safeFields,
      timestamp: new Date().toISOString(),
    }),
  );
}

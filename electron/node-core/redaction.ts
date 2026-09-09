const secretKey = /(?:password|passphrase|private.?key|api.?key|authorization|token|secret)/i;
const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redactDiagnostic(value: string) {
  return value
    .replace(bearer, 'Bearer [REDACTED]')
    .replace(
      /(["']?(?:password|passphrase|private.?key|api.?key|token|secret)["']?\s*[:=]\s*)[^\s,;}]+/gi,
      '$1[REDACTED]',
    );
}

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnostic(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      secretKey.test(key) ? '[REDACTED]' : redactValue(item),
    ]),
  );
}

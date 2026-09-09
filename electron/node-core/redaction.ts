const secretKey = /(?:password|passphrase|private.?key|api.?key|authorization|token|secret)/i;
const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const privateKey = /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/i;
const knownToken =
  /\b(?:sk-ant-|sk-|glpat-|npm_|xox[baprs]-|sk_(?:live|test)_)[A-Za-z0-9_-]{20,}\b/g;
const awsKey = /\bAKIA[A-Z0-9]{16}\b/g;
const githubToken = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const jwt = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const urlCredentials = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

export function redactDiagnostic(value: string) {
  if (privateKey.test(value)) return '[REDACTED PRIVATE KEY]';
  return value
    .replace(bearer, 'Bearer [REDACTED]')
    .replace(knownToken, '[REDACTED]')
    .replace(awsKey, '[REDACTED]')
    .replace(githubToken, '[REDACTED]')
    .replace(jwt, '[REDACTED]')
    .replace(urlCredentials, '$1[REDACTED]@')
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

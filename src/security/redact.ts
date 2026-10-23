const SENSITIVE_KEY = /(?:api[-_]?key|authorization|bearer|password|secret|token|credential)/iu;
const REDACTED = "[REDACTED]";

// Recognizable secret shapes in free-form text; exact-match redaction cannot
// cover foreign secrets.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\b(api[-_]?key|access[-_]?key|secret|token|password|credential)\s*[=:]\s*(?!\[REDACTED\])[^\s"'`,;]{6,}/giu,
];

export function redactText(value: string, secrets: readonly string[] = []): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.split(secret).join(REDACTED);
    }
  }
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`);
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, key: unknown) =>
      typeof key === "string" ? `${key}=${REDACTED}` : REDACTED);
  }
  return result;
}

export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(child, secrets);
    }
    return result;
  }
  return value;
}

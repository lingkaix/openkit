const absolutePathPattern = /(?:^|[\s"'`(])(?:\/|~\/|[A-Za-z]:[\\/]|\\\\|\/\/)\S*/g;

/**
 * Redacts host-local paths from user-facing MCP responses.
 *
 * @param value Value to redact recursively.
 * @param extraSecrets Exact strings that must not appear in the returned value.
 * @returns A deep-redacted value with local path strings replaced.
 */
export function redactPublicValue(value: unknown, extraSecrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    return redactText(value, extraSecrets);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactPublicValue(item, extraSecrets));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactPublicValue(child, extraSecrets)])
    );
  }

  return value;
}

/**
 * Redacts host-local paths from one text value.
 *
 * @param value Text to redact.
 * @param extraSecrets Exact strings that must not appear in the returned value.
 * @returns Redacted text.
 */
function redactText(value: string, extraSecrets: readonly string[]): string {
  let redacted = value.replace(absolutePathPattern, (match) => {
    const prefix = /^[\s"'`(]/.test(match) ? match[0] : '';
    return `${prefix}[redacted-local-path]`;
  });

  for (const secret of extraSecrets) {
    if (secret) {
      redacted = redacted.split(secret).join('[redacted]');
    }
  }

  return redacted;
}

const REDACTED_VALUE = '[redacted]';
const SENSITIVE_KEY_PATTERN =
  /prompt|token|authorization|auth|api[-_]?key|envKey|secret|password|account|codexOAuthAccountSlotId/i;

/**
 * Redacts a diagnostics value recursively.
 *
 * @param value Arbitrary diagnostics value.
 * @returns Redacted diagnostics value safe for app diagnostics and internal agent tools.
 */
export function redactInternalAgentDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactInternalAgentDiagnosticValue(entry));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};

    for (const [key, nested] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED_VALUE
        : redactInternalAgentDiagnosticValue(nested);
    }

    return output;
  }
  if (typeof value === 'string') {
    return redactInternalAgentText(value);
  }

  return value;
}

/**
 * Redacts sensitive substrings while preserving complete JSON values and opaque text.
 *
 * @param value Diagnostics or model-visible text.
 * @returns Text with common secret, token, authorization, and account-id patterns removed.
 */
export function redactInternalAgentText(value: string): string {
  try {
    JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return redactOpaqueText(value);
    throw error;
  }
  // Decode string tokens, including property names, without rebuilding JSON or changing other bytes.
  // Capture and evidence readers detect redaction by byte inequality; safe JSON stays byte-identical.
  return value.replace(/"(?:\\.|[^"\\])*"/g, (literal) => {
    const decoded = JSON.parse(literal) as string;
    const redacted = redactInternalAgentText(decoded);
    return redacted === decoded ? literal : JSON.stringify(redacted);
  });
}

/** Applies the existing common credential filters to one non-JSON text value. */
function redactOpaqueText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/\bbearer\s+[a-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED_VALUE}`)
    .replace(
      /\b(token|secret|account[_-]?id|api[_-]?key)\s*[:=]\s*["']?[^,\s"'}]+/gi,
      `$1=${REDACTED_VALUE}`
    )
    .replace(/\b(?:sk-[a-z0-9_-]+|hf_[a-z0-9_-]+|ghp_[a-z0-9_-]+)\b/gi, REDACTED_VALUE);
}

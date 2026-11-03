/**
 * Rejects an identifier that cannot be used as one canonical path segment.
 *
 * @param value Candidate path segment.
 * @param label Human-readable identifier label.
 * @throws Error when the value is empty, special, or contains a path separator.
 */
export function assertSafeWorkspacePathSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`${label} must be a safe path segment.`);
  }
}

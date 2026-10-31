/** Checks named-field access only; prototypes, schema validity and authority remain caller concerns. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

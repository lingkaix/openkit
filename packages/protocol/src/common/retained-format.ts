/** Fixed retained v1 marker; future family formats select their own decoder instead of changing this constant. */
export const RETAINED_FORMAT_VERSION = 1 as const;

/** Adds the owned marker when a native writer publishes a new current-format record. */
export function writeRetainedV1<Value extends object>(
  value: Value
): Value & { schemaVersion: typeof RETAINED_FORMAT_VERSION } {
  return { ...value, schemaVersion: RETAINED_FORMAT_VERSION };
}

/** Checks the record marker before invoking its family-owned retained decoder. */
export function readRetainedV1<Value>(input: unknown, decode: (record: unknown) => Value): Value {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !Object.hasOwn(input, 'schemaVersion') ||
    (input as { schemaVersion?: unknown }).schemaVersion !== RETAINED_FORMAT_VERSION
  ) {
    throw new TypeError('Unsupported retained record format.');
  }
  return decode(input);
}

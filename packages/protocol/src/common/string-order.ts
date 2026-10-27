/** Compares strings by UTF-16 code units, independent of the host locale and ICU data. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

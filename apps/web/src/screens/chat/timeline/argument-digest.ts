const ARGUMENT_DIGEST = /^sha256:[a-f0-9]{64}$/;

/** Digest carried on the admitted item object itself. Other windows are not consulted. */
const admittedDigest = new WeakMap<object, string | null>();

export function noteAdmittedArgumentDigest(item: object, digest: string | null | undefined): void {
  admittedDigest.set(
    item,
    typeof digest === 'string' && ARGUMENT_DIGEST.test(digest) ? digest : null
  );
}

export function digestsCarriedWith(items: readonly object[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const item of items) {
    if (!admittedDigest.has(item)) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    map.set(id, admittedDigest.get(item) ?? null);
  }
  return map;
}

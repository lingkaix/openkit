import { readFileSync } from 'node:fs';

/** Frozen inputs and observations; these do not implement production policy. */
export const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));

/** Return a fresh small original without decoding or normalizing its bytes. */
export function originalBytes(id) {
  const source = cases.originals.find((item) => item.id === id);
  if (!source) throw new RangeError(`Unknown original: ${id}`);
  return Buffer.from(source.patternHex.repeat(source.repeats), 'hex');
}

/** Return inert ZIP bytes. Callers must not extract these into a real workspace. */
export function archiveBytes(id) {
  const source = cases.archives.find((item) => item.id === id);
  if (!source) throw new RangeError(`Unknown archive: ${id}`);
  return Buffer.from(source.base64, 'base64');
}

/** Yield a zero-filled recipe, optionally limited to a half-open byte range. */
export function* streamChunks(recipe, { start = 0, end = recipe.size } = {}) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > recipe.size ||
    recipe.patternHex !== '00' ||
    recipe.maxChunkBytes !== 65536
  ) {
    throw new RangeError('Invalid fixture range or recipe');
  }
  for (let offset = start; offset < end; offset += recipe.maxChunkBytes) {
    yield Buffer.alloc(Math.min(recipe.maxChunkBytes, end - offset));
  }
}

/** Yield entry descriptions, never expanded bodies or filesystem effects. */
export function* archiveEntryDescriptions(recipe) {
  let index = 0;
  for (const group of recipe.entries) {
    for (let entry = 0; entry < group.count; entry += 1) {
      yield {
        name: `entry-${String(index++).padStart(6, '0')}.bin`,
        size: group.eachBytes,
        depth: group.depth ?? 0,
      };
    }
  }
}

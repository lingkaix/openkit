/**
 * Parses a release tag into the product version value.
 *
 * @param {string} tag Tag name.
 * @returns {string} Version without leading v.
 */
export function parseVersionTag(tag) {
  const match =
    /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9a-z-]*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|[0-9a-z-]*[a-z-][0-9a-z-]*))*)?)$/.exec(
      tag
    );
  if (!match) {
    throw new Error(
      `Release tag must match v<major>.<minor>.<patch> or v<major>.<minor>.<patch>-<pre>: ${tag}`
    );
  }
  return match[1];
}

/** Select the direct stable 0.x channel introduced by v0.2.0. */
export function isDirectStableTag(tag) {
  return /^v0\.(?:[2-9]|[1-9]\d+)\.(?:0|[1-9]\d*)$/u.test(tag);
}

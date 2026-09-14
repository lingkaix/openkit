import type { z } from 'zod';

const RawSecretPattern =
  /(^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]+|hf_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|okt_[A-Za-z0-9_-]+)/;

/**
 * Adds validation issues for raw-secret-shaped strings in a parsed response.
 *
 * @param value Value to inspect recursively.
 * @param ctx Zod refinement context.
 * @param path Path to the value in the response.
 */
export function addRawSecretIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[]
): void {
  if (typeof value === 'string') {
    if (RawSecretPattern.test(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Response contains a raw-secret-shaped string.',
        path,
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      addRawSecretIssues(item, ctx, [...path, index]);
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      addRawSecretIssues(item, ctx, [...path, key]);
    }
  }
}

/** Exact generated artifacts exempt from the shape heuristic inside diff hunk bodies. */
const GeneratedPatchPaths = new Set(['skills/openkit/scripts/openkit']);

/**
 * Removes only complete hunk bodies for a recognized generated Git diff section.
 * Unknown paths, ambiguous headers, and malformed hunks retain full scanning.
 *
 * @param section One Git diff section, or unrecognized patch text.
 * @returns Text that still requires the raw-secret shape guard.
 */
function patchSectionToScan(section: string): string {
  const lines = section.split('\n');
  const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[0] ?? '');
  if (!header || header[1] !== header[2] || !GeneratedPatchPaths.has(header[1]!)) {
    return section;
  }
  const path = header[1];
  const oldHeader = lines.findIndex((line) => line.startsWith('--- '));
  const oldPath = lines[oldHeader];
  const newPath = lines[oldHeader + 1];
  if (
    oldHeader < 1 ||
    lines.slice(1, oldHeader).some((line) => /^(?:rename |copy |\+\+\+ )/.test(line)) ||
    (oldPath !== `--- a/${path}` && oldPath !== '--- /dev/null') ||
    (newPath !== `+++ b/${path}` && newPath !== '+++ /dev/null') ||
    (oldPath === '--- /dev/null' && newPath === '+++ /dev/null')
  ) {
    return section;
  }

  const scanned = lines.slice(0, oldHeader + 2);
  for (let index = oldHeader + 2; index < lines.length; index++) {
    const line = lines[index]!;
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(line);
    if (!hunk) {
      // A second file header or an unrecognized hunk must not inherit the exemption.
      if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) {
        return section;
      }
      scanned.push(line);
      continue;
    }
    scanned.push(line);
    let oldRemaining = Number(hunk[1] ?? 1);
    let newRemaining = Number(hunk[2] ?? 1);
    if (
      !Number.isSafeInteger(oldRemaining) ||
      !Number.isSafeInteger(newRemaining) ||
      (oldPath === '--- /dev/null' && oldRemaining !== 0) ||
      (newPath === '+++ /dev/null' && newRemaining !== 0)
    ) {
      return section;
    }
    while (oldRemaining > 0 || newRemaining > 0) {
      const body = lines[++index];
      if (body === '\\ No newline at end of file') continue;
      const prefix = body?.[0];
      if (prefix !== ' ' && prefix !== '-' && prefix !== '+') return section;
      if (prefix !== '+') oldRemaining--;
      if (prefix !== '-') newRemaining--;
      if (oldRemaining < 0 || newRemaining < 0) return section;
    }
  }
  return scanned.join('\n');
}

/**
 * Scans patch metadata and ordinary files while exempting known generated hunk bodies.
 * This is a shape heuristic, not credential detection within generated artifacts.
 *
 * @param text Unified Git diff text; unsupported formats receive full scanning.
 * @param ctx Zod refinement context.
 * @param path Path to the patch text in the response.
 */
export function addRawSecretIssuesForPatchText(
  text: string,
  ctx: z.RefinementCtx,
  path: (string | number)[]
): void {
  const scanned = text
    .split(/(?=^diff --git )/m)
    .map(patchSectionToScan)
    .join('\n');
  addRawSecretIssues(scanned, ctx, path);
}

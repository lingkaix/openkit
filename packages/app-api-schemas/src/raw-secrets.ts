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

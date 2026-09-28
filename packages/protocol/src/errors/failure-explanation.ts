import { z } from 'zod';

/** Closed, product-safe observation of the terminal remote Git fetch attempt. */
export const GitFailureExplanationSchema = z
  .object({
    code: z.enum([
      'git_fetch_failed',
      'git_fetch_tls_failed',
      'git_fetch_transport_failed',
      'git_fetch_http_refused',
    ]),
    stage: z.literal('workspace_materialization'),
    operation: z.literal('git.fetch'),
    dependency: z.literal('git_remote'),
    producer: z.literal('worker-shim'),
    observedAt: z.iso.datetime({ precision: 3 }).length(24),
    basis: z.literal('direct_observation'),
    subprocess: z.enum(['exit', 'signal', 'spawn', 'timeout']),
    httpStatus: z.union([z.literal(401), z.literal(403), z.null()]),
    enforcement: z.literal('unavailable'),
    evidence: z
      .object({
        availability: z.literal('partial'),
        outputTruncated: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.code === 'git_fetch_http_refused') !== (value.httpStatus !== null)) {
      context.addIssue({ code: 'custom', message: 'HTTP refusal requires its observed status.' });
    }
    if (value.code !== 'git_fetch_transport_failed' && value.subprocess !== 'exit') {
      context.addIssue({
        code: 'custom',
        message: 'Classification requires a completed failed fetch.',
      });
    }
  })
  .describe(
    'Closed Git fetch observation. Canonical Zod validation additionally requires HTTP status iff code is git_fetch_http_refused and a completed failed subprocess for every non-transport code.'
  );

/** Normalized explanation; no raw diagnostics or runtime handles are admitted. */
export type GitFailureExplanation = z.infer<typeof GitFailureExplanationSchema>;

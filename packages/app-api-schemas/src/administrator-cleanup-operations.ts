import { z } from 'zod';
import { AdministratorCleanupReadResponseSchema } from './administrator-cleanup.js';
import type { OperationDefinition } from './operation-contract.js';

const sandboxHoldRef = z.string().regex(/^sandbox-release-refusal:sha256:[a-f0-9]{64}$/u);

/** Current administrator-only observations; source owners retain all cleanup authority. */
export const ADMINISTRATOR_CLEANUP_OPERATION_DEFINITIONS = {
  'administration.cleanup-read': {
    stability: 'settled',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read bounded cleanup observations from current canonical records.',
    inputSchema: z.object({}).strict(),
    outputSchema: AdministratorCleanupReadResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'server' },
    policyOperation: 'audit.read',
    mutating: false,
  },
  'administration.sandbox-hold-read': {
    stability: 'release-coupled',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read exact Sandbox release-mismatch holds and their corrective action.',
    inputSchema: z.object({ cursor: sandboxHoldRef.optional() }).strict(),
    outputSchema: z.object({
      holds: z
        .array(
          z.object({
            sandboxRuntimeId: z.string().min(1).max(512),
            holdRef: sandboxHoldRef,
            revision: z.number().int().positive().safe(),
            reason: z.literal('worker_release_incompatible'),
            repairable: z.boolean(),
            repairBlockedReason: z
              .enum(['original-refusal-missing', 'original-refusal-conflicting'])
              .nullable(),
            correctiveAction: z.enum([
              'activate-compatible-worker-image-and-repair',
              'await-exact-release',
              'inspect-original-refusal-order',
            ]),
          })
        )
        .max(100),
      incomplete: z.boolean(),
      nextCursor: sandboxHoldRef.nullable(),
    }),
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'server' },
    policyOperation: 'audit.read',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;

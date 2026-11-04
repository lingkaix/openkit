import { STORAGE_LIMITS } from '@openkit/storage';
import { z } from 'zod';
import {
  StoredResolvedAgentSetupV1Schema,
  StoredSetupRequiredFeaturesV1Schema,
} from '../agents/setup-retained-v1.js';

/** The original complete whitelist-redacted row; private file transport changes no retained field. */
export const ControlResolvedAgentSetupRecordSchema = z
  .object({
    recordId: z.string(),
    workspaceId: z.string(),
    turnId: z.string().nullable(),
    requestId: z.string().nullable(),
    setup: StoredResolvedAgentSetupV1Schema,
    createdAt: z.string(),
  })
  .strict();
export type ControlResolvedAgentSetupRecord = z.infer<typeof ControlResolvedAgentSetupRecordSchema>;

/** Exact request-local file evidence, bound to the actual Workspace rather than retained attribution. */
export const ControlResolvedAgentSetupInputSchema = z
  .object({
    scopeWorkspaceId: z.string(),
    file: z
      .object({
        name: z.string().regex(/^resolved-setup-[A-Za-z0-9]+\/setup\.json$/),
        byteLength: z.number().int().min(0).max(STORAGE_LIMITS.contentBytes),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        identity: z.string().regex(/^\d+:\d+$/),
      })
      .strict(),
  })
  .strict();
export type ControlResolvedAgentSetupInput = z.infer<typeof ControlResolvedAgentSetupInputSchema>;
/** Existing complete redacted dependent readback, not a new retained representation. */
export const ControlResolvedAgentSetupResultSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    turnId: z.string().nullable(),
    requestId: z.string().nullable(),
    agentId: z.string(),
    logicalModelId: z.string(),
    runtimeKind: z.string(),
    runtimeAdapter: z.string(),
    requiredFeatures: StoredSetupRequiredFeaturesV1Schema,
    setup: StoredResolvedAgentSetupV1Schema,
    createdAt: z.string(),
  })
  .strict();
export type ControlResolvedAgentSetupResult = z.infer<typeof ControlResolvedAgentSetupResultSchema>;
/** Preserve the existing strict retained-marker refusal without exposing stored JSON or diagnostics. */
export const ControlResolvedAgentSetupRefusalSchema = z
  .object({
    operation: z.literal('resolved-agent-setup'),
    code: z.literal('unsupported_retained_format'),
  })
  .strict();

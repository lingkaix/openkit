import {
  RequestIdSchema,
  ResourceCandidateIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** These three original standalone Catalog receipts have separate record and maintenance commits. */
export const CATALOG_COMMAND_RECEIPTS = [
  'catalog.skill-candidate-submit',
  'catalog.skill-candidate-decide',
  'catalog.skill-candidate-withdraw',
] as const;

const receipt = z.strictObject({
  key: z.string().min(1),
  command: z.enum(CATALOG_COMMAND_RECEIPTS),
  requestId: RequestIdSchema,
  scope: z.strictObject({
    workspaceId: WorkspaceIdSchema,
    actorId: UserIdSchema,
    candidateId: ResourceCandidateIdSchema.optional(),
  }),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  response: z.strictObject({ kind: z.literal('skill_candidate'), id: ResourceCandidateIdSchema }),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

/** One existing stage per native request; maintenance cannot roll back the acknowledged record. */
export const ControlCatalogCommandReceiptInputSchema = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.literal('record'), workspaceId: WorkspaceIdSchema, receipt }),
  z.strictObject({
    stage: z.literal('maintenance'),
    workspaceId: WorkspaceIdSchema,
    referenceTime: z.string().datetime(),
  }),
]);

/** Closed original Candidate command facts, never a SQL or arbitrary receipt interface. */
export type ControlCatalogCommandReceiptInput = z.infer<
  typeof ControlCatalogCommandReceiptInputSchema
>;

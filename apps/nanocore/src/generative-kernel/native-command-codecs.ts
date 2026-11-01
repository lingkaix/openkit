import {
  CreateLightAppResponseSchema,
  LightAppAdmittedSchemaSchema,
  LightAppBatchRequestSchema,
  LightAppBatchResponseSchema,
  LightAppDefinitionSourceSchema,
  LightAppRecordSchema,
  LightAppSchemaInputSchema,
  UpdateLightAppRecordRequestSchema,
} from '@openkit/app-api-schemas';
import {
  ActorRefSchema,
  RequestIdSchema,
  TimestampSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Existing App command identities; the worker owns their business, Audit and original receipt tuple. */
export const APP_NATIVE_COMMANDS = [
  'kernel.apps.create',
  'kernel.schema.update',
  'kernel.apps.retire',
  'kernel.records.create',
  'kernel.records.update',
  'kernel.records.batch',
  'kernel.format.upgrade',
  'kernel.snapshots.rollback',
] as const;

/** Physical App binding within the existing native opening lifetime, separate from retained product ownership. */
export const ControlAppScopeSchema = z
  .object({
    kind: z.literal('app'),
    workspaceId: WorkspaceIdSchema,
    appId: z.string().uuid(),
  })
  .strict();
/** Exact physical scope of the App database, never a public path selector. */
export type ControlAppScope = z.infer<typeof ControlAppScopeSchema>;

const revision = z.number().int().positive();
const selectedDefinition = z
  .object({ entryId: z.string().min(1), digest: z.string().optional() })
  .strict();
const definition = {
  // Selected definitions already contain admitted collection/field identities. Do not strip them.
  schema: z.union([LightAppAdmittedSchemaSchema, LightAppSchemaInputSchema]),
  sourceSelection: LightAppDefinitionSourceSchema.optional(),
  requestedDefinition: selectedDefinition.optional(),
};
const identity = z
  .object({
    path: z.string().min(1),
    dev: z.string(),
    ino: z.string(),
    size: z.number().int().nonnegative(),
    mtimeMs: z.number(),
    ctimeMs: z.number(),
  })
  .strict();

/** Closed App inputs; format journal and final command remain separately acknowledged stages. */
export const ControlAppInputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    appId: z.string().uuid(),
    actor: ActorRefSchema,
    execution: z
      .object({ threadId: z.string().min(1), turnId: z.string().min(1) })
      .strict()
      .optional(),
    requestId: RequestIdSchema,
    receipt: z
      .object({
        key: z.string().min(1),
        command: z.enum(APP_NATIVE_COMMANDS),
        requestId: RequestIdSchema,
        scope: z.object({ workspaceId: WorkspaceIdSchema, appId: z.string().uuid() }).strict(),
        inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        responseKind: z.enum(['light_app', 'light_app_record', 'light_app_batch']),
        createdAt: TimestampSchema,
        expiresAt: TimestampSchema,
      })
      .strict(),
    change: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('create'), ...definition }).strict(),
      z
        .object({
          kind: z.literal('schema'),
          expectedAppRevision: revision,
          expectedSchemaRevision: revision,
          ...definition,
        })
        .strict(),
      z.object({ kind: z.literal('retire'), expectedAppRevision: revision }).strict(),
      z
        .object({
          kind: z.literal('record-create'),
          collectionSelector: z.string(),
          schemaRevision: revision,
          data: z.record(z.string(), z.unknown()),
        })
        .strict(),
      z
        .object({
          kind: z.literal('record-update'),
          collectionSelector: z.string(),
          recordId: z.string().uuid(),
          body: UpdateLightAppRecordRequestSchema,
          lineage: z
            .object({
              presentationId: z.string(),
              actionName: z.string(),
              itemId: z.string(),
              sourceFilter: z.string().optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
      z.object({ kind: z.literal('record-batch'), body: LightAppBatchRequestSchema }).strict(),
      z.object({ kind: z.literal('format-journal'), expectedAppRevision: revision }).strict(),
      z.object({ kind: z.literal('format-complete'), expectedAppRevision: revision }).strict(),
      z
        .object({
          kind: z.literal('rollback'),
          expectedAppRevision: revision,
          snapshotId: z.string().uuid(),
          candidate: identity,
          schemaRevision: revision,
          definitionVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          snapshotDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
  })
  .strict();
/** Typed message body for one App family through the existing native FIFO. */
export type ControlAppInput = z.infer<typeof ControlAppInputSchema>;
/** Small envelope; the existing transferable byte account owns the exact domain JSON. */
export const ControlAppWireSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    appId: z.string().uuid(),
    kind: z.enum([
      'create',
      'schema',
      'retire',
      'record-create',
      'record-update',
      'record-batch',
      'format-journal',
      'format-complete',
      'rollback',
    ]),
    turnId: z.string().min(1).optional(),
    byteLength: z.number().int().positive().safe(),
  })
  .strict();
/** Closed App envelope; neither SQL nor callbacks cross this seam. */
export type ControlAppWire = z.infer<typeof ControlAppWireSchema>;
/** Only existing public result shapes cross the internal ACK boundary. */
export const ControlAppResultSchema = z.union([
  CreateLightAppResponseSchema,
  LightAppRecordSchema,
  LightAppBatchResponseSchema,
  z.null(),
]);
/** Result is released only after the native covering FULL commit or completed publication. */
export type ControlAppResult = z.infer<typeof ControlAppResultSchema>;
/** Only product-safe Kernel fields or the existing snapshot EEXIST refusal leave the owner. */
export const ControlAppRefusalSchema = z
  .object({
    operation: z.literal('app-kernel'),
    code: z.enum([
      'validation_failed',
      'conflict',
      'schema_stale',
      'not_found',
      'access_denied',
      'limit_exceeded',
      'unsupported_operation',
      'unavailable',
      'idempotency_key_conflict',
      'recovery_required',
      'EEXIST',
    ]),
    message: z.string().min(1),
    status: z.number().int().min(400).max(599),
    appDetails: z
      .object({
        path: z.string().optional(),
        limit: z.string().optional(),
        maximum: z.number().optional(),
        expectedRevision: z.number().optional(),
        currentRevision: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

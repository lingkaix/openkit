import { RequestIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  GetLightAppResponseSchema,
  LightAppSchemaInputSchema,
  ListLightAppSnapshotsResponseSchema,
} from './light-apps.js';
import type { OperationDefinition } from './operation-contract.js';
import { SkillCatalogProducerSchema } from './resource-catalog.js';

const entryId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative();
const workspace = { workspaceId: WorkspaceIdSchema };
const entry = { ...workspace, entryId };
const command = { ...workspace, requestId: RequestIdSchema, expectedRevision: revision };
const app = { ...workspace, appId: z.string().uuid() };
const appCommand = {
  ...app,
  requestId: RequestIdSchema,
  expectedAppRevision: z.number().int().positive(),
};
const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
  'worker-package',
] as const;
const scope = { kind: 'body-workspace', field: 'workspaceId' } as const;
const workspaceTarget = { kind: 'workspace' } as const;
const appTarget = { kind: 'workspace-light-app', field: 'appId' } as const;

/** Reusable definition selection; it is separate from any live app's active data. */
export const LightAppDefinitionEntrySchema = z
  .object({
    id: entryId,
    displayName: z.string().min(1),
    availability: z.enum(['available', 'removed']),
    currentDigest: digest.nullable(),
  })
  .strict();
/** Immutable declarative bytes and their original author and parent. */
export const LightAppDefinitionVersionSchema = z
  .object({
    entryId,
    digest,
    parentDigest: digest.nullable(),
    producer: SkillCatalogProducerSchema,
    createdAt: z.string().min(1),
    definitionJson: z.string().max(256 * 1024),
  })
  .strict();
/** Exact retained definition pin in the current Workspace. */
export const LightAppDefinitionPinSchema = z.object({ entryId, digest }).strict();
/** Definition-only portable history, with no business data or execution grant. */
export const LightAppDefinitionExportSchema = z
  .object({
    schemaVersion: z.literal(1),
    entry: LightAppDefinitionEntrySchema,
    versions: z.array(LightAppDefinitionVersionSchema),
    pin: LightAppDefinitionPinSchema.nullable(),
  })
  .strict();
/** Current definition entry and retained revision history. */
export const ReadLightAppDefinitionResponseSchema = z
  .object({
    revision,
    entry: LightAppDefinitionEntrySchema,
    versions: z.array(LightAppDefinitionVersionSchema),
    pin: LightAppDefinitionPinSchema.nullable(),
  })
  .strict();
const mutation = z.object({ revision }).strict();

/** Existing catalog and Kernel projections for reusable definitions and explicit data activation. */
export const LIGHT_APP_DEFINITION_OPERATION_DEFINITIONS = {
  'catalog.light-app-list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'List reusable Light App definitions in the current Workspace.',
    inputSchema: z.object(workspace).strict(),
    outputSchema: z.object({ revision, entries: z.array(LightAppDefinitionEntrySchema) }).strict(),
    credentials,
    scope,
    target: workspaceTarget,
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'catalog.light-app-read': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read a Light App definition and its immutable parent, actor and time history.',
    inputSchema: z.object(entry).strict(),
    outputSchema: ReadLightAppDefinitionResponseSchema,
    credentials,
    scope,
    target: workspaceTarget,
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'catalog.light-app-import': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 201,
    description: 'Import one declarative definition version without changing live app data.',
    inputSchema: z
      .object({
        ...command,
        entryId,
        displayName: z.string().min(1),
        definition: LightAppSchemaInputSchema,
        parentDigest: digest.nullable().optional(),
        selectDefault: z.boolean().default(false),
      })
      .strict(),
    outputSchema: z.object({ revision, version: LightAppDefinitionVersionSchema }).strict(),
    credentials,
    scope,
    target: workspaceTarget,
    policyOperation: 'workspace.configure',
    mutating: true,
  },
  'catalog.light-app-history-import': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 201,
    description: 'Import exported definition history without activating source selections or data.',
    inputSchema: z
      .object({ ...command, entryId: entryId.optional(), export: LightAppDefinitionExportSchema })
      .strict(),
    outputSchema: z.object({ revision, entry: LightAppDefinitionEntrySchema }).strict(),
    credentials,
    scope,
    target: workspaceTarget,
    policyOperation: 'workspace.configure',
    mutating: true,
  },
  'catalog.light-app-export': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Export retained Light App definition history without business data.',
    inputSchema: z.object(entry).strict(),
    outputSchema: LightAppDefinitionExportSchema,
    credentials,
    scope,
    target: workspaceTarget,
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'catalog.light-app-select': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description:
      'Select a retained definition default, including an earlier version, without migrating live data.',
    inputSchema: z
      .object({ ...command, entryId, digest, expectedCurrentDigest: digest.nullable() })
      .strict(),
    outputSchema: mutation,
    credentials,
    scope,
    target: workspaceTarget,
    policyOperation: 'workspace.configure',
    mutating: true,
  },
  'catalog.light-app-pin': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Pin or unpin a retained definition for future explicit creation or activation.',
    inputSchema: z
      .object({
        ...command,
        entryId,
        digest: digest.nullable(),
        expectedPinDigest: digest.nullable(),
      })
      .strict(),
    outputSchema: mutation,
    credentials,
    scope,
    target: workspaceTarget,
    policyOperation: 'workspace.configure',
    mutating: true,
  },
  'kernel.apps.instantiate': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 201,
    description: 'Create one empty Light App from an exact, pinned or default retained definition.',
    inputSchema: z
      .object({ ...workspace, requestId: RequestIdSchema, entryId, digest: digest.optional() })
      .strict(),
    outputSchema: GetLightAppResponseSchema,
    credentials,
    scope,
    target: workspaceTarget,
    policyOperation: 'workspace.configure',
    mutating: true,
  },
  'kernel.schema.activate': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description:
      'Explicitly activate a retained definition after automatic data snapshot and supported one-way migration.',
    inputSchema: z
      .object({
        ...appCommand,
        expectedSchemaRevision: z.number().int().positive(),
        entryId,
        digest: digest.optional(),
      })
      .strict(),
    outputSchema: GetLightAppResponseSchema,
    credentials,
    scope,
    target: appTarget,
    policyOperation: 'workspace.configure',
    mutating: true,
  },
  'kernel.snapshots.list': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: "List the selected app's automatic pre-migration snapshots.",
    inputSchema: z.object(app).strict(),
    outputSchema: ListLightAppSnapshotsResponseSchema,
    credentials,
    scope,
    target: appTarget,
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'kernel.snapshots.rollback': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description:
      'Restore one selected data snapshot, discarding later data without a down migration.',
    inputSchema: z.object({ ...appCommand, snapshotId: RequestIdSchema }).strict(),
    outputSchema: GetLightAppResponseSchema,
    credentials,
    scope,
    target: appTarget,
    policyOperation: 'workspace.configure',
    mutating: true,
  },
  'kernel.format.upgrade': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description:
      'Upgrade a known older app format through the current native journal after an automatic snapshot.',
    inputSchema: z.object(appCommand).strict(),
    outputSchema: GetLightAppResponseSchema,
    credentials,
    scope,
    target: appTarget,
    policyOperation: 'workspace.configure',
    mutating: true,
  },
} as const satisfies Readonly<Record<string, OperationDefinition>>;

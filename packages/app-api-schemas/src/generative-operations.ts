import { RequestIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  GenerativePresentationDataModelResponseSchema,
  GenerativePresentationResourceResponseSchema,
  GetGenerativePresentationResponseSchema,
  PublishGenerativePresentationRequestSchema,
  PublishGenerativePresentationResponseSchema,
  RefreshGenerativePresentationRequestSchema,
  SubmitGenerativePresentationActionRequestSchema,
} from './generative-ui.js';
import {
  CreateLightAppRequestSchema,
  CreateLightAppResponseSchema,
  GetLightAppRecordResponseSchema,
  LightAppBatchRequestSchema,
  LightAppBatchResponseSchema,
  ListLightAppRecordsResponseSchema,
  ListLightAppsResponseSchema,
  RetireLightAppRequestSchema,
  RetireLightAppResponseSchema,
  UpdateLightAppRecordRequestSchema,
  UpdateLightAppRecordResponseSchema,
  UpdateLightAppSchemaRequestSchema,
  UpdateLightAppSchemaResponseSchema,
} from './light-apps.js';

const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
  'worker-package',
] as const;
const workspace = { workspaceId: WorkspaceIdSchema };
const app = { ...workspace, appId: z.string().uuid() };
const collection = { ...app, collection: z.string().min(1) };
const record = { ...collection, recordId: z.string().uuid() };
const presentation = { ...workspace, presentationId: z.string().uuid() };
const revision = z.number().int().positive();
const paging = { page: revision.optional(), perPage: revision.max(100).optional() };

/** Release-authored definitions for the existing remaining Kernel operations; effects remain with NanoCore owners. */
export const KERNEL_REMAINING_OPERATION_DEFINITIONS = {
  'kernel.apps.list': {
    description: 'List Light Apps in the current Workspace.',
    inputSchema: z.object({ ...workspace, ...paging }).strict(),
    outputSchema: ListLightAppsResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'kernel.apps.create': {
    description: 'Create one Light App from a file-authored schema.',
    inputSchema: CreateLightAppRequestSchema.safeExtend({
      ...workspace,
      requestId: RequestIdSchema,
    }),
    outputSchema: CreateLightAppResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.configure',
    mutating: true,
    successStatus: 201,
  },
  'kernel.schema.update': {
    description: 'Update one Light App schema within the initial evolution ceiling.',
    inputSchema: UpdateLightAppSchemaRequestSchema.extend({ ...app, requestId: RequestIdSchema }),
    outputSchema: UpdateLightAppSchemaResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace-light-app', field: 'appId' },
    policyOperation: 'workspace.configure',
    mutating: true,
  },
  'kernel.apps.retire': {
    description: 'Retire one Light App and disable writes.',
    inputSchema: RetireLightAppRequestSchema.extend({ ...app, requestId: RequestIdSchema }),
    outputSchema: RetireLightAppResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace-light-app', field: 'appId' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'kernel.records.list': {
    description: 'List records in one Light App collection.',
    inputSchema: z
      .object({
        ...collection,
        schemaRevision: revision,
        ...paging,
        filter: z.string().optional(),
        sort: z.string().optional(),
        fields: z.string().optional(),
      })
      .strict(),
    outputSchema: ListLightAppRecordsResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace-light-app', field: 'appId' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'kernel.records.get': {
    description: 'Read one Light App record.',
    inputSchema: z
      .object({ ...record, schemaRevision: revision, fields: z.string().optional() })
      .strict(),
    outputSchema: GetLightAppRecordResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace-light-app', field: 'appId' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'kernel.records.update': {
    description: 'Update one Light App record.',
    inputSchema: UpdateLightAppRecordRequestSchema.extend({
      ...record,
      requestId: RequestIdSchema,
    }),
    outputSchema: UpdateLightAppRecordResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace-light-app', field: 'appId' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'kernel.records.batch': {
    description: 'Apply one atomic Light App record batch.',
    inputSchema: LightAppBatchRequestSchema.extend({ ...app, requestId: RequestIdSchema }),
    outputSchema: LightAppBatchResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace-light-app', field: 'appId' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
} as const;

/** Release-authored definitions for the existing Generative UI operations; effects remain with NanoCore owners. */
export const GENERATIVE_UI_OPERATION_DEFINITIONS = {
  'generative-ui.publish': {
    description: 'Publish one admitted native Generative UI presentation.',
    inputSchema: PublishGenerativePresentationRequestSchema.extend({
      ...workspace,
      requestId: RequestIdSchema,
    }),
    outputSchema: PublishGenerativePresentationResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.write',
    mutating: true,
    successStatus: 201,
  },
  'generative-ui.get': {
    description: 'Read one retained Generative UI presentation.',
    inputSchema: z.object(presentation).strict(),
    outputSchema: GetGenerativePresentationResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'generative-ui.resource': {
    description: 'Read the retained native A2UI resource for one presentation.',
    inputSchema: z.object(presentation).strict(),
    outputSchema: GenerativePresentationResourceResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'generative-ui.refresh': {
    description: 'Refresh one presentation from its current authorized source.',
    inputSchema: RefreshGenerativePresentationRequestSchema.extend(presentation),
    outputSchema: GenerativePresentationDataModelResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'generative-ui.action': {
    description: 'Submit one admitted Kernel record-update action.',
    inputSchema: SubmitGenerativePresentationActionRequestSchema.extend({
      ...presentation,
      requestId: RequestIdSchema,
    }),
    outputSchema: GenerativePresentationDataModelResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
} as const;

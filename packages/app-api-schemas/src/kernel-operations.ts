import { RequestIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  CreateLightAppRecordRequestSchema,
  GetLightAppResponseSchema,
  LightAppRecordSchema,
} from './light-apps.js';
import type { OperationDefinition } from './operation-contract.js';

const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
  'worker-package',
] as const;

const selectors = { workspaceId: WorkspaceIdSchema, appId: z.string().uuid() };

/** Sole declarative contract for the first Generative Kernel operation slice. */
export const KERNEL_OPERATION_DEFINITIONS = {
  'kernel.apps.get': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read one Light App schema and capabilities.',
    inputSchema: z.object(selectors).strict(),
    outputSchema: GetLightAppResponseSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace-light-app', field: 'appId' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'kernel.records.create': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Create one Light App record.',
    inputSchema: CreateLightAppRecordRequestSchema.extend({
      ...selectors,
      collection: z.string().min(1),
      requestId: RequestIdSchema,
    }),
    outputSchema: LightAppRecordSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace-light-app', field: 'appId' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;

/** Canonical ids inferred from the single definition table. */
export type KernelOperationId = keyof typeof KERNEL_OPERATION_DEFINITIONS;

/** Complete logical input for a selected operation. */
export type KernelOperationInput<K extends KernelOperationId> = z.infer<
  (typeof KERNEL_OPERATION_DEFINITIONS)[K]['inputSchema']
>;

/** Validated result of a selected operation. */
export type KernelOperationOutput<K extends KernelOperationId> = z.infer<
  (typeof KERNEL_OPERATION_DEFINITIONS)[K]['outputSchema']
>;

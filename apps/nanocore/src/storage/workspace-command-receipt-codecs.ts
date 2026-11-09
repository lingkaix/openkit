import {
  ArtifactIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkerStorageTargetIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** The original creator receipt belongs to User; metadata and environment receipts belong to Workspace. */
export const WORKSPACE_USER_COMMAND_RECEIPTS = ['workspace.create'] as const;
/** Existing public metadata and Worker environment commands share this physical Workspace receipt partition. */
export const WORKSPACE_LOCAL_COMMAND_RECEIPTS = [
  'workspace.update',
  'worker_environment.prepare',
  'worker_environment.activate',
  'worker_environment.purge',
] as const;

const receiptBase = {
  key: z.string().min(1),
  requestId: RequestIdSchema,
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  response: z.strictObject({ kind: z.literal('workspace'), id: WorkspaceIdSchema }),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
};
const createReceipt = z.strictObject({
  ...receiptBase,
  command: z.literal('workspace.create'),
  scope: z.strictObject({ userId: UserIdSchema }),
});
const updateReceipt = z.strictObject({
  ...receiptBase,
  command: z.literal('workspace.update'),
  scope: z.strictObject({ workspaceId: WorkspaceIdSchema }),
});

/** The three original environment commands keep their exact Thread or storage-reference provenance. */
const environmentReceipt = z.discriminatedUnion('command', [
  z.strictObject({
    ...receiptBase,
    command: z.enum(['worker_environment.prepare', 'worker_environment.activate']),
    scope: z.strictObject({
      actorId: UserIdSchema,
      threadId: ThreadIdSchema,
      workspaceId: WorkspaceIdSchema,
    }),
    response: z.strictObject({ kind: z.literal('artifact'), id: ArtifactIdSchema }),
  }),
  z.strictObject({
    ...receiptBase,
    command: z.literal('worker_environment.purge'),
    scope: z.strictObject({
      actorId: UserIdSchema,
      storageRef: WorkerStorageTargetIdSchema,
      workspaceId: WorkspaceIdSchema,
    }),
    response: z.strictObject({
      kind: z.literal('worker_environment'),
      id: WorkerStorageTargetIdSchema,
    }),
  }),
]);

/** Separate original record and expiry-maintenance commits, with two exact physical owners. */
export const ControlWorkspaceCommandReceiptInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create-receipt'),
    userId: UserIdSchema,
    receipt: createReceipt,
  }),
  z.strictObject({
    action: z.literal('create-maintenance'),
    userId: UserIdSchema,
    referenceTime: z.string().datetime(),
  }),
  z.strictObject({
    action: z.literal('update-receipt'),
    workspaceId: WorkspaceIdSchema,
    receipt: updateReceipt,
  }),
  z.strictObject({
    action: z.literal('update-maintenance'),
    workspaceId: WorkspaceIdSchema,
    referenceTime: z.string().datetime(),
  }),
  z.strictObject({
    action: z.literal('environment-receipt'),
    workspaceId: WorkspaceIdSchema,
    receipt: environmentReceipt,
  }),
  z.strictObject({
    action: z.literal('environment-maintenance'),
    workspaceId: WorkspaceIdSchema,
    referenceTime: z.string().datetime(),
  }),
]);

/** Closed original Workspace command facts; no authored name, image, configuration or arbitrary receipt crosses. */
export type ControlWorkspaceCommandReceiptInput = z.infer<
  typeof ControlWorkspaceCommandReceiptInputSchema
>;
/** Original receipt identity and resource pointer for one of the closed live producers. */
export type WorkspaceCommandReceipt = Extract<
  ControlWorkspaceCommandReceiptInput,
  { receipt: unknown }
>['receipt'];

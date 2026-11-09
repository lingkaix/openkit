import {
  ArtifactIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkerStorageTargetIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** The original creator receipt belongs to User; metadata, environment, Skill and Artifact receipts belong to Workspace. */
export const WORKSPACE_USER_COMMAND_RECEIPTS = ['workspace.create'] as const;
/** Existing closed public metadata, Worker environment, Skill and Artifact commands share this physical Workspace receipt partition. */
export const WORKSPACE_LOCAL_COMMAND_RECEIPTS = [
  'workspace.update',
  'worker_environment.prepare',
  'worker_environment.activate',
  'worker_environment.purge',
  'catalog.skill-import',
  'catalog.skill-select',
  'catalog.skill-pin',
  'catalog.skill-remove',
  'catalog.skill-purge',
  'artifact.import',
  'artifact.version-commit',
  'artifact.version-file-commit',
  'artifact.introduce',
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

/** Existing Skill management receipts retain their original import tuple or Workspace pointer. */
const skillReceipt = z.discriminatedUnion('command', [
  z.strictObject({
    ...receiptBase,
    command: z.literal('catalog.skill-import'),
    scope: z.strictObject({ workspaceId: WorkspaceIdSchema, actorId: UserIdSchema }),
    response: z.strictObject({
      kind: z.literal('skill_version'),
      id: z
        .string()
        .min(1)
        .refine((value) => {
          try {
            const tuple: unknown = JSON.parse(value);
            return (
              Array.isArray(tuple) &&
              tuple.length === 2 &&
              typeof tuple[0] === 'string' &&
              tuple[0].length > 0 &&
              typeof tuple[1] === 'string' &&
              /^sha256:[a-f0-9]{64}$/.test(tuple[1]) &&
              JSON.stringify(tuple) === value
            );
          } catch {
            return false;
          }
        }),
    }),
  }),
  z.strictObject({
    ...receiptBase,
    command: z.enum([
      'catalog.skill-select',
      'catalog.skill-pin',
      'catalog.skill-remove',
      'catalog.skill-purge',
    ]),
    scope: z.strictObject({ workspaceId: WorkspaceIdSchema, actorId: UserIdSchema }),
    response: z.strictObject({ kind: z.literal('skill_catalog'), id: WorkspaceIdSchema }),
  }),
]);

/** Four original Artifact receipt producers preserve their exact actor, Thread and target selectors. */
const artifactReceipt = z.discriminatedUnion('command', [
  z.strictObject({
    ...receiptBase,
    // App Artifact commands retain opaque public identities, including non-UUID values.
    requestId: z.string().min(1),
    command: z.literal('artifact.import'),
    scope: z.strictObject({ actorId: UserIdSchema, workspaceId: WorkspaceIdSchema }),
    response: z.strictObject({ kind: z.literal('artifact'), id: ArtifactIdSchema }),
  }),
  z.strictObject({
    ...receiptBase,
    // App Artifact commands retain opaque public identities, including non-UUID values.
    requestId: z.string().min(1),
    command: z.enum(['artifact.version-commit', 'artifact.version-file-commit']),
    scope: z.strictObject({
      actorId: UserIdSchema,
      workspaceId: WorkspaceIdSchema,
      threadId: ThreadIdSchema,
      artifactId: ArtifactIdSchema,
    }),
    response: z.strictObject({ kind: z.literal('artifact'), id: ArtifactIdSchema }),
  }),
  z.strictObject({
    ...receiptBase,
    // App Artifact commands retain opaque public identities, including non-UUID values.
    requestId: z.string().min(1),
    command: z.literal('artifact.introduce'),
    scope: z.strictObject({ workspaceId: WorkspaceIdSchema, threadId: ThreadIdSchema }),
    response: z.strictObject({ kind: z.literal('artifact'), id: ArtifactIdSchema }),
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
  z.strictObject({
    action: z.literal('skill-receipt'),
    workspaceId: WorkspaceIdSchema,
    receipt: skillReceipt,
  }),
  z.strictObject({
    action: z.literal('skill-maintenance'),
    workspaceId: WorkspaceIdSchema,
    referenceTime: z.string().datetime(),
  }),
  z.strictObject({
    action: z.literal('artifact-receipt'),
    workspaceId: WorkspaceIdSchema,
    receipt: artifactReceipt,
  }),
  z.strictObject({
    action: z.literal('artifact-maintenance'),
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

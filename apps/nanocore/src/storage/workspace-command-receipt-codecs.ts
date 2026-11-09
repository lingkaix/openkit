import { RequestIdSchema, UserIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** The original creator receipt belongs to User, and metadata-update receipt belongs to Workspace. */
export const WORKSPACE_USER_COMMAND_RECEIPTS = ['workspace.create'] as const;
/** Only the existing public metadata command joins this Workspace receipt partition. */
export const WORKSPACE_LOCAL_COMMAND_RECEIPTS = ['workspace.update'] as const;

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
]);

/** Closed original Workspace command facts; no authored name or arbitrary receipt crosses. */
export type ControlWorkspaceCommandReceiptInput = z.infer<
  typeof ControlWorkspaceCommandReceiptInputSchema
>;
/** Original receipt identity and resource pointer for one of the two live producers. */
export type WorkspaceCommandReceipt = Extract<
  ControlWorkspaceCommandReceiptInput,
  { receipt: unknown }
>['receipt'];

import {
  CreateThreadRequestSchema,
  RequestIdSchema,
  ThreadIdSchema,
  ThreadSchema,
  TurnIdSchema,
  TurnReadProjectionSchema,
  WorkspaceIdSchema,
  WorkspaceResourcesResponseSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { ListThreadItemsResponseSchema, ThreadDashboardResponseSchema } from './dashboard.js';
import {
  CreateLightAppRecordRequestSchema,
  GetLightAppResponseSchema,
  LightAppRecordSchema,
} from './light-apps.js';
import { NanoHostRuntimeTargetStatusResponseSchema } from './nanohost.js';
import { ListAuthorizedWorkspacesResponseSchema } from './workspace-sharing.js';

/** Current trusted authentication procedures eligible for Kernel operations. */
type KernelCredential =
  | 'local-user'
  | 'user-session'
  | 'user-bearer'
  | 'deployment-administrator'
  | 'worker-package';

/** Closed descriptors used by this slice; implementations remain on the server. */
export interface KernelOperationDefinition {
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly outputSchema: z.ZodType;
  readonly credentials: readonly KernelCredential[];
  readonly scope: { readonly kind: 'body-workspace'; readonly field: 'workspaceId' };
  readonly target: { readonly kind: 'workspace-light-app'; readonly field: 'appId' };
  readonly policyOperation: 'workspace.read' | 'workspace.write';
  readonly mutating: boolean;
}

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
} as const satisfies Record<string, KernelOperationDefinition>;

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

/** One existing administration read used to prove the real internal assembly seam. */
export const ADMINISTRATION_OPERATION_DEFINITIONS = {
  'nanohost.runtime-target': {
    description:
      "Read the configured NanoHost execution-host RuntimeTarget readiness. NanoHost is not an LLM Provider. Input must be an empty object; this Tool cannot select a host, deployment, or scope. The result is Core's stored projection at observedAt, not a live host probe.",
    inputSchema: z.object({}).strict(),
    outputSchema: NanoHostRuntimeTargetStatusResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'configured-runtime-target' },
    policyOperation: 'api.call',
    mutating: false,
  },
} as const;

/** Credentials already used by the public Workspace, Thread and Turn families. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;
const workspaceSelector = { workspaceId: WorkspaceIdSchema };
const threadSelector = { ...workspaceSelector, threadId: ThreadIdSchema };

/** Candidate-first Workspace discovery and its existing resource bundle. */
export const WORKSPACE_OPERATION_DEFINITIONS = {
  'workspace.list': {
    description: 'List authorized Workspaces with effective access and revisions.',
    inputSchema: z.object({}).strict(),
    outputSchema: ListAuthorizedWorkspacesResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'authorized-workspace-set' },
    target: { kind: 'authorized-workspaces' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'workspace.resources': {
    description: 'Read one Workspace resource bundle.',
    inputSchema: z.object(workspaceSelector).strict(),
    outputSchema: WorkspaceResourcesResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
} as const;

/** Creation and audience-scoped Thread reads retain the protocol and dashboard owners. */
export const THREAD_OPERATION_DEFINITIONS = {
  'thread.create': {
    description:
      'Create one Thread; private by default, explicitly workspace-shared for formal work.',
    inputSchema: CreateThreadRequestSchema.strict(),
    outputSchema: ThreadSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.write',
    mutating: true,
  },
  'thread.read': {
    description: 'Read one visible Thread.',
    inputSchema: z.object(threadSelector).strict(),
    outputSchema: ThreadSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'thread.items': {
    description: 'List durable Items for one visible Thread.',
    inputSchema: z
      .object({
        ...threadSelector,
        since: z.number().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    outputSchema: ListThreadItemsResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'thread.read',
    mutating: false,
  },
  'thread.dashboard': {
    description: 'Read one visible Thread dashboard.',
    inputSchema: z.object(threadSelector).strict(),
    outputSchema: ThreadDashboardResponseSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'thread.read',
    mutating: false,
  },
} as const;

/** Turn detail keeps the ordinary product projection and verified Context Package evidence. */
export const TURN_OPERATION_DEFINITIONS = {
  'turn.read': {
    description: 'Read one Turn in its visible Thread.',
    inputSchema: z.object({ ...threadSelector, turnId: TurnIdSchema }).strict(),
    outputSchema: TurnReadProjectionSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: {
      kind: 'addressed-turn',
      threadField: 'threadId',
      turnField: 'turnId',
      missing: 'not-found',
    },
    policyOperation: 'thread.read',
    mutating: false,
  },
} as const;

/** JSON product operations; administration's private Tool retains its separate public transport. */
export const PRODUCT_OPERATION_DEFINITIONS = {
  ...KERNEL_OPERATION_DEFINITIONS,
  ...WORKSPACE_OPERATION_DEFINITIONS,
  ...THREAD_OPERATION_DEFINITIONS,
  ...TURN_OPERATION_DEFINITIONS,
} as const;

/** Static composition of the implemented families; this is not a registration surface. */
export const OPERATION_DEFINITIONS = {
  ...PRODUCT_OPERATION_DEFINITIONS,
  ...ADMINISTRATION_OPERATION_DEFINITIONS,
} as const;
/** JSON product ids inferred from the static public composition. */
export type ProductOperationId = keyof typeof PRODUCT_OPERATION_DEFINITIONS;
/** Exact implemented ids inferred from the definitions. */
export type OperationId = keyof typeof OPERATION_DEFINITIONS;
/** Complete logical input of an implemented operation. */
export type OperationInput<K extends OperationId> = z.infer<
  (typeof OPERATION_DEFINITIONS)[K]['inputSchema']
>;
/** Validated output of an implemented operation. */
export type OperationOutput<K extends OperationId> = z.infer<
  (typeof OPERATION_DEFINITIONS)[K]['outputSchema']
>;

/** Derives the canonical one-route JSON binding without a second path catalog. */
export function operationHttpPath<K extends string>(id: K): `/api/app/operations/${K}` {
  return `/api/app/operations/${id}`;
}
/** Derives the provider/MCP spelling; assemblers check collisions across supplied Tools. */
export function operationToolName(id: string): string {
  return id.replaceAll('.', '_').replaceAll('-', '_');
}
/** Mechanically omits context-bound fields while preserving the remaining schema objects. */
export function operationModelInput(
  schema: z.ZodObject,
  boundFields: readonly string[]
): z.ZodObject {
  const mask = Object.fromEntries(
    boundFields.filter((key) => key in schema.shape).map((key) => [key, true])
  ) as Parameters<typeof schema.omit>[0];
  return schema.omit(mask);
}

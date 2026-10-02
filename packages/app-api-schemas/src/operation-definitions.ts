import { RequestIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  CreateLightAppRecordRequestSchema,
  GetLightAppResponseSchema,
  LightAppRecordSchema,
} from './light-apps.js';
import { NanoHostRuntimeTargetStatusResponseSchema } from './nanohost.js';

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

/** Static composition of the implemented families; this is not a registration surface. */
export const OPERATION_DEFINITIONS = {
  ...KERNEL_OPERATION_DEFINITIONS,
  ...ADMINISTRATION_OPERATION_DEFINITIONS,
} as const;
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

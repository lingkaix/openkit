import type {
  OPERATION_DEFINITIONS,
  OperationId,
  OperationInput,
  OperationOutput,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import type { Actor } from './auth/identity.js';
import { OperationError } from './operation-error.js';
import type { SchedulerLeaseTokenBindingLineage } from './scheduler-records.js';
/** Request-local facts supplied only by trusted entry assembly. */
export interface OperationRequestFacts {
  readonly signal?: AbortSignal;
  readonly delivery?: 'human' | 'model';
  readonly observeSuccessStatus?: (status: 200 | 201 | 202 | 204) => void;
}
/** Trusted entry context, constructed by authentication or Worker supply assembly. */
export type OperationInvocationContext = OperationRequestFacts &
  (
    | { readonly kind: 'bootstrap' }
    | { readonly kind: 'public'; readonly actor: Actor }
    | {
        readonly kind: 'coordinator';
        readonly actor: Actor;
        readonly workspaceId: string;
        readonly threadId: string;
        readonly goalId: string;
        readonly turnId: string;
        readonly requestId: string;
      }
    | {
        readonly kind: 'worker';
        readonly actor: ActorRef;
        readonly lineage: SchedulerLeaseTokenBindingLineage;
        readonly requestId: string;
        readonly bindings: Readonly<
          Partial<Record<'workspaceId' | 'threadId' | 'turnId' | 'requestId', string>>
        >;
      }
  );

/** Scope admission keeps candidate sets distinct from a selected Workspace. */
export type AdmittedOperationScope =
  | { readonly kind: 'server' | 'user' }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'authorized-workspace-set'; readonly workspaceIds: readonly string[] };
/** Internal admission result, never a caller-supplied authorization token. */
export type AdmittedOperationContext = Exclude<
  OperationInvocationContext,
  { kind: 'bootstrap' }
> & {
  readonly actorRef: ActorRef;
  readonly scope: AdmittedOperationScope;
  readonly resolvedLineage?: {
    readonly workspaceId: string;
    readonly threadId?: string;
    readonly ownerUserId?: string;
  };
};
/** Exact operation signatures preserve the concrete family key join. */
export type OperationImplementations = {
  [K in OperationId]: (
    input: OperationInput<K>,
    context: (typeof OPERATION_DEFINITIONS)[K]['credentials'] extends readonly ['bootstrap-secret']
      ? Extract<OperationInvocationContext, { kind: 'bootstrap' }>
      : AdmittedOperationContext
  ) => OperationOutput<K> | Promise<OperationOutput<K>>;
};
/** Family signatures are selected only from the browser-safe table's exact keys. */
export type FamilyImplementations<T> = Pick<
  OperationImplementations,
  Extract<keyof T, OperationId>
>;
/** Requires a human-authenticated entry where the family has no worker projection. */
export function publicOperationActor(context: OperationInvocationContext): Actor {
  if (context.kind === 'worker' || context.kind === 'bootstrap')
    throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
  return context.actor;
}

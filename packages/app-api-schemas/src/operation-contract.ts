import type { z } from 'zod';

/** Release-coupled authentication procedures; actual authority remains server-owned. */
export type OperationCredential =
  | 'local-user'
  | 'user-session'
  | 'user-bearer'
  | 'deployment-administrator'
  | 'worker-package'
  | 'coordinator';
/** Existing policy vocabulary consumed by the server authorizer. */
export type OperationPolicy =
  | 'api.call'
  | 'deployment.recover'
  | 'invitation.respond'
  | 'approval.respond'
  | 'artifact.read'
  | 'artifact.write'
  | 'audit.read'
  | 'knowledge.propose'
  | 'knowledge.read'
  | 'knowledge.write'
  | 'llm.gateway.use'
  | 'membership.manage'
  | 'network.egress'
  | 'review.apply'
  | 'runtime.launch'
  | 'thread.read'
  | 'tool.grant'
  | 'tool.use'
  | 'turn.run'
  | 'vault.admin'
  | 'vault.use'
  | 'workspace.configure'
  | 'workspace.export'
  | 'workspace.leave'
  | 'workspace.lifecycle'
  | 'workspace.read'
  | 'workspace.write';
/** Scope selection never infers a record owner from an input field or operation name. */
export type OperationScope =
  | { readonly kind: 'server' | 'user' | 'authorized-workspace-set' | 'actor-quick-chat-workspace' }
  | { readonly kind: 'body-workspace'; readonly field: string }
  | {
      readonly kind: 'opaque-child-workspace';
      readonly childOwner: 'automation';
      readonly childField: string;
    }
  | {
      readonly kind: 'opaque-child-workspace';
      readonly childOwner: 'pending-request';
      readonly field: string;
      readonly childField: string;
    }
  | {
      readonly kind: 'opaque-child-workspace';
      readonly childOwner: 'turn';
      readonly childField: string;
    };
/** Closed target strategies; record availability and effects remain with each owner. */
export type OperationTarget =
  | {
      readonly kind:
        | 'workspace'
        | 'authorized-workspaces'
        | 'automation'
        | 'workspace-deletion'
        | 'deleted-workspace'
        | 'deployment'
        | 'configured-runtime-target';
    }
  | { readonly kind: 'server' | 'user'; readonly field?: string }
  | {
      readonly kind:
        | 'workspace-light-app'
        | 'invitation'
        | 'workspace-invitation'
        | 'workspace-member'
        | 'scheduler-admission';
      readonly field: string;
    }
  | {
      readonly kind: 'addressed-thread';
      readonly threadField: string;
      readonly missing?: 'not-found';
    }
  | { readonly kind: 'optional-addressed-thread'; readonly threadField: string }
  | ({
      readonly kind: 'addressed-turn';
      readonly threadField: string;
      readonly turnField: string;
    } & (
      | { readonly lineage: 'turn'; readonly missing?: 'not-found' | 'interrupt-failed' }
      | { readonly lineage: 'recovery-checkpoint'; readonly missing?: 'not-found' }
    ));
/** Mutation admission is separate from primary authorization scope. */
export type OperationMutationTarget = {
  readonly kind: 'body-workspace' | 'invitation-workspace';
  readonly field: string;
};
/** Closed response framing facts with current JSON and MCP consumers. */
export interface OperationProjectionFacts {
  readonly binding: 'json' | 'streaming';
  readonly returnsOneTimeSecret: boolean;
  readonly successStatus: 200 | 201 | 202 | 204;
  readonly successStatuses?: readonly (200 | 201 | 202 | 204)[];
  readonly invalidInputCode?: string;
}
/** Browser-safe declaration vocabulary; no live dependencies or authority facts. */
export interface OperationDefinition extends OperationProjectionFacts {
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly outputSchema: z.ZodType;
  readonly credentials: readonly OperationCredential[];
  readonly scope: OperationScope;
  readonly target: OperationTarget;
  readonly mutationTarget?: OperationMutationTarget;
  readonly policyOperation: OperationPolicy;
  readonly mutating: boolean;
  readonly inputSensitivity?: 'secret stdin';
}

/** Concrete intersections preserve every included table's exact keys and signatures. */
type Intersect<T> = (T extends unknown ? (value: T) => void : never) extends (
  value: infer I
) => void
  ? I
  : never;
/** Static composition rejects collisions before any projection or handler can run. */
export function composeOperationTables<const T extends readonly object[]>(
  ...tables: T
): Intersect<T[number]> {
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    for (const [id, value] of Object.entries(table)) {
      if (Object.hasOwn(result, id)) throw new Error(`Duplicate operation id: ${id}`);
      result[id] = value;
    }
  }
  return result as Intersect<T[number]>;
}

/** Result eligibility does not grant admission or widen immutable worker supply. */
export function operationMcpEligible(definition: OperationProjectionFacts): boolean {
  return definition.binding === 'json' && definition.returnsOneTimeSecret === false;
}

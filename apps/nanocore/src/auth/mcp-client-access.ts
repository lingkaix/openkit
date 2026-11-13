import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { PRODUCT_OPERATION_ACCESS_RIGHTS } from '@openkit/config-schema';
import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import type { ActorRef } from '@openkit/protocol';
import type { OpenKitAccessTokenRecord } from './access-token-store.js';
import type { ProductAccessTarget } from './operation-authorizer.js';

/** Existing Integration identity; this adapter issues neither a principal nor a credential. */
export type IntegrationPrincipal = ActorRef & { readonly kind: 'integration' };

/** Current verified owner projections, not a replacement for native verification or issuer reads. */
export interface McpClientAccessInput {
  readonly binding: {
    readonly principal: IntegrationPrincipal;
    readonly principalOwnerUserId: string;
    readonly token: Readonly<
      Pick<OpenKitAccessTokenRecord, 'tokenId' | 'ownerUserId' | 'scope' | 'workspaceIds'>
    >;
  } | null;
  readonly operationId: string;
  readonly target: ProductAccessTarget;
  readonly userKernel: PolicyDecision;
  /** Complete verified credential sequence, immediate issuer through its terminal human. */
  readonly issuerChain:
    | readonly {
        readonly principal: ActorRef;
        readonly active: boolean;
        readonly kernel: PolicyDecision;
      }[]
    | null;
}

/** A known verified client remains the principal even when the Policy calculation refuses it. */
export interface McpClientAccessResult {
  readonly kernel: PolicyDecision;
  readonly principal: IntegrationPrincipal | null;
  readonly onBehalfOfUserId: string | null;
}

/** Adapts credential facts into mandatory existing Kernel classes; never authorizes an effect.
 * Native callers must first verify the usable Token, its actual binding and complete issuer
 * sequence against this same current operation/target. Those native joins remain separate.
 */
export function evaluateMcpClientAccess(input: McpClientAccessInput): McpClientAccessResult {
  const binding = input.binding;
  const principal = binding?.principal ?? null;
  const matchingOwner =
    !!binding &&
    binding.principal.kind === 'integration' &&
    binding.principal.id.length > 0 &&
    binding.token.tokenId.length > 0 &&
    binding.principalOwnerUserId.length > 0 &&
    binding.principalOwnerUserId === binding.token.ownerUserId;
  const onBehalfOfUserId = matchingOwner ? binding!.principalOwnerUserId : null;
  const definition = Object.hasOwn(OPERATION_DEFINITIONS, input.operationId)
    ? OPERATION_DEFINITIONS[input.operationId as keyof typeof OPERATION_DEFINITIONS]
    : null;
  const right = definition ? PRODUCT_OPERATION_ACCESS_RIGHTS[definition.policyOperation] : null;
  const workspaceScoped =
    definition?.scope.kind === 'body-workspace' ||
    definition?.scope.kind === 'opaque-child-workspace' ||
    definition?.scope.kind === 'actor-quick-chat-workspace';
  const chain = input.issuerChain;
  const terminal = chain?.at(-1);
  const facts: readonly (readonly [string, boolean])[] = [
    ['binding', matchingOwner],
    ['registered-operation', definition !== null && right !== null],
    ['current-user', input.userKernel.effect === 'allow'],
    [
      'scope',
      !!binding &&
        workspaceScoped &&
        input.target.kind === 'workspace' &&
        binding.token.workspaceIds.includes(input.target.workspaceId) &&
        (binding.token.scope === 'workspace' ||
          (binding.token.scope === 'workspace-readonly' && definition?.mutating === false)),
    ],
    // The credential owner and its terminal issuer are distinct identities; both remain bounded.
    ['complete-issuers', !!chain?.length && terminal?.principal.kind === 'user'],
    ...(chain ?? []).map(
      (issuer, index) =>
        [`issuer:${index}`, issuer.active && issuer.kernel.effect === 'allow'] as const
    ),
  ];
  // Opaque transient NGAC nodes do not create Protocol principals or retained grants.
  const user = 'mcp-credential-subject';
  const target = 'mcp-requested-target';
  const state: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: target, kind: 'object' },
      ...facts.flatMap(([name]) => [
        { id: `${name}:subject`, kind: 'userAttribute' as const },
        { id: `${name}:target`, kind: 'objectAttribute' as const },
        { id: `${name}:required`, kind: 'policyClass' as const },
      ]),
    ],
    assignments: facts.flatMap(([name]) => [
      { child: user, parent: `${name}:subject` },
      { child: `${name}:subject`, parent: `${name}:required` },
      { child: target, parent: `${name}:target` },
      { child: `${name}:target`, parent: `${name}:required` },
    ]),
    operations: right ? [{ id: input.operationId, accessRights: [right] }] : [],
    associations: facts.flatMap(([name, admitted]) =>
      admitted && right
        ? [
            {
              id: `${name}:current`,
              userAttribute: `${name}:subject`,
              targetAttribute: `${name}:target`,
              accessRights: [right],
            },
          ]
        : []
    ),
  };
  return {
    kernel: evaluateAccess(state, { user, target, operation: input.operationId }),
    principal,
    onBehalfOfUserId,
  };
}

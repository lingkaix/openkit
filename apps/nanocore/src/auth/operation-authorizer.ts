import { isDeepStrictEqual } from 'node:util';
import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import type { ProductOperation } from '@openkit/config-schema';
import { parseWorkspacePolicyDocument } from '@openkit/config-schema';
import type { PolicyDecision } from '@openkit/policy-kernel';
import { type ActorRef, responsibleUserIdForActor } from '@openkit/protocol';
import { HTTPException } from 'hono/http-exception';
import { asApiError } from '../api-errors.js';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { type FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import type {
  AssistantOperationInvocationContext,
  OperationInvocationContext,
} from '../operation-contract.js';
import { OperationError, TurnStartValidationError } from '../operation-error.js';
import {
  evaluatePolicyKernel,
  type ProductAccessTarget,
  type ProductPolicyInput,
} from '../policy/workspace-access.js';
import { assertCurrentWorkerCredentialAuthority } from '../runtime/worker-credential-authority.js';
import {
  type CoreSchedulerQueueEntry,
  findSchedulerAdmissionForTurn,
  findSchedulerAdmissionForWorkerLineage,
  type SchedulerExecutionLineage,
} from '../scheduler-records.js';
import { ControlProductPreconditionError } from '../storage/control-store-product-records.js';
import type { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { ControlVaultInput } from '../storage/vault-native-codecs.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import { readWorkspaceDeletionRequest } from '../workspace-deletion-request.js';
import {
  getWorkspaceInvitation,
  getWorkspaceMember,
  listActiveWorkspaceIds,
  listActiveWorkspaceIdsForActor,
  resolveWorkspaceMembershipRelation,
} from '../workspace-sharing.js';
import { evaluateOpenKitAccessTokenUsability } from './access-token.js';
import type { ThreadPolicyActor } from './identity.js';
import { readThreadPolicyAncestors, readThreadPolicyFacts } from './thread-visibility.js';

/** Canonical target of the existing product-authorization entry, also used by credential adapters. */
export type { ProductAccessTarget } from '../policy/workspace-access.js';

import {
  DeploymentAdminRequiredError,
  getOpenKitAccessTokenRecord,
  type OpenKitAccessTokenRecord,
  readCurrentOpenKitAccessTokenLineage,
  requireCurrentDeploymentAdmin,
  resolveSessionDeploymentAdminTokenId,
} from './access-token-store.js';
import type { Actor } from './identity.js';
import type { PublicOperationAccess } from './operation-access.js';
import { isCanonicalUserActive } from './user-lifecycle.js';

/** Current eligibility cause; ownership remains a separate registry identity. */
export type WorkspaceAuthority = 'member' | 'administrator';

/** Actual Kernel evaluation and current non-secret authority facts for one Workspace effect. */
export interface WorkspaceAuthorityEvaluation {
  /** Decision returned by the existing Policy adapter, before authority effect mapping. */
  readonly decision: PolicyDecision;
  /** Current canonical facts supplied only when evaluation capture is requested. */
  readonly facts: {
    /** Canonical addressed Workspace. */
    readonly workspaceId: string;
    /** Concrete requested product operation. */
    readonly operation: string;
    /** Canonical user responsible for this effect. */
    readonly responsibleUserId: string;
    /** Eligibility cause; this does not grant registry ownership. */
    readonly relation: WorkspaceAuthority;
    /** Exact presented bearer identity, absent for actors without a bearer. */
    readonly presentedTokenId: string | null;
    /** Current canonical membership revision, absent for administrator eligibility. */
    readonly membershipRevision: number | null;
    /** Safe presented Token lifecycle facts; never Token material or hashes. */
    readonly presentedTokenState: Pick<
      OpenKitAccessTokenRecord,
      | 'tokenId'
      | 'ownerUserId'
      | 'scope'
      | 'workspaceIds'
      | 'status'
      | 'expiresAt'
      | 'revokedAt'
      | 'predecessorTokenId'
      | 'rotatedGraceExpiresAt'
    > | null;
  };
}

/** Opt-in failure handling and actual evaluation capture for governed Workspace effects. */
export interface WorkspaceAuthorityOptions {
  /** Evaluates a retained human Policy or invitation author without manufacturing request credentials. */
  readonly retainedPolicyAuthor?: boolean;
  /** Actual caller-owned mutation posture; effect paths default to mutating and reads opt out explicitly. */
  readonly mutating?: boolean;
  /** Propagates resolver and callback failures; omission keeps the existing transient refusal. */
  readonly dependencyFailure?: 'throw';
  /** Admitted human Policy on these exact presented native facts, never another Subject. */
  readonly policy?: Extract<
    Parameters<typeof evaluatePolicyKernel>[0],
    { readonly facts: unknown }
  >['policy'];
  /** Receives a real Kernel result and safe current facts; missing eligibility emits no event. */
  readonly onEvaluation?: (event: WorkspaceAuthorityEvaluation) => void;
}

/** Authorized Workspace context exposed to one guarded handler. */
export type WorkspaceAccess =
  | {
      /** Single-Workspace authorization result. */
      readonly kind: 'workspace';
      /** Canonical authorized Workspace id. */
      readonly workspaceId: string;
      /** Whether the actor is the actual registry owner; eligibility has no owner ceiling. */
      readonly isOwner: boolean;
      /** Product operation allowed by the policy adapter. */
      readonly policyOperation: ProductOperation;
    }
  | {
      /** Multi-Workspace collection authorization result. */
      readonly kind: 'workspace-set';
      /** Canonical authorized Workspace ids. */
      readonly workspaceIds: string[];
      /** Product operation allowed for every returned Workspace. */
      readonly policyOperation: ProductOperation;
    };

export {
  type CurrentDeploymentAdminAuthority,
  DeploymentAdminRequiredError,
  requireCurrentDeploymentAdmin,
} from './access-token-store.js';

/** One successful single-Workspace policy result. */
interface AuthorizedWorkspace {
  /** Actual ownership identity; this does not grant a permission tier. */
  readonly isOwner: boolean;
  /** Canonical Workspace id. */
  readonly workspaceId: string;
}

/**
 * Requires a handler-owned child to belong to its already authorized Workspace.
 *
 * @param access Central authorization result from request context.
 * @param actualWorkspaceId Workspace id read from the child record owner, or null when its scoped owner cannot distinguish missing from mismatched lineage.
 * @throws HTTPException carrying the uniform Workspace access denial response on mismatch.
 */
export function assertAuthorizedWorkspaceLineage(
  access: WorkspaceAccess | undefined,
  actualWorkspaceId: string | null
): asserts access is Extract<WorkspaceAccess, { kind: 'workspace' }> {
  if (access?.kind !== 'workspace' || access.workspaceId !== actualWorkspaceId) {
    throw new HTTPException(403, { res: workspaceAccessDenied() });
  }
}

/**
 * Evaluates an additional Workspace through the same actor and policy intersection as a guarded request.
 *
 * @param coreDb Core Workspace authority.
 * @param actor Authenticated request actor.
 * @param workspaceId Canonical Workspace id.
 * @param access Exact product operation and mutation posture.
 * @returns True only when the central Workspace predicate allows the operation.
 */
export function isWorkspaceOperationAuthorized(
  coreDb: CoreDb,
  actor: Actor,
  workspaceId: string,
  access: Pick<PublicOperationAccess, 'mutating' | 'policyOperation'> & {
    readonly authentication?: PublicOperationAccess['authentication'];
  }
): boolean {
  return authorizeWorkspace(coreDb, actor, workspaceId, access) !== null;
}

/** Reads retained human eligibility facts without presenting a credential for a live effect. */
function currentServerPolicyAuthorEligibility(
  coreDb: CoreDb,
  humanId: string,
  now = Date.now()
): boolean {
  if (!Number.isFinite(now)) return false;
  const author = coreDb.sqlite.prepare('SELECT kind FROM users WHERE id = ?').get(humanId) as
    | { kind: string }
    | undefined;
  if (!author || !['local', 'human'].includes(author.kind)) return false;
  return (
    isCanonicalUserActive(coreDb, humanId) &&
    (author.kind === 'local' ||
      resolveSessionDeploymentAdminTokenId(coreDb, humanId, new Date(now)) !== null)
  );
}

/** Evaluates current retained-human Server authority; it cannot supply a live caller credential. */
export function isCurrentServerPolicyAuthor(
  coreDb: CoreDb,
  humanId: string,
  now = Date.now()
): boolean {
  if (!Number.isFinite(now)) return false;
  return (
    evaluatePolicyKernel({
      facts: {
        userId: humanId,
        activeUser: isCanonicalUserActive(coreDb, humanId),
        administrator: currentServerPolicyAuthorEligibility(coreDb, humanId, now),
        credential: {
          kind: 'retained-author',
          current: true,
          workspaceBound: true,
          readOnly: false,
        },
      },
      target: { kind: 'server' },
      operation: 'workspace.configure',
      mutating: true,
    }).effect === 'allow'
  );
}

/** Rereads current resource Policy authors; lost author authority never makes a boundary unmanaged. */
export function readCurrentWorkspacePolicy(input: {
  readonly coreDb: CoreDb;
  readonly workspaceId: string;
  readonly policy: unknown;
}) {
  const document = parseWorkspacePolicyDocument(input.workspaceId, input.policy);
  for (const statement of document.statements) {
    if (statement.state !== 'active') continue;
    if (
      statement.author.kind !== 'human' ||
      !currentWorkspaceAuthority(
        input.coreDb,
        input.workspaceId,
        { kind: 'user', id: statement.author.id },
        'workspace.configure',
        true,
        undefined,
        { retainedPolicyAuthor: true, dependencyFailure: 'throw' }
      )
    )
      throw new Error('Workspace Policy author no longer has current authority.');
  }
  return document;
}

/**
 * Composes current Workspace authority from one actor, active membership, policy operation, and caller-owned effect authority.
 *
 * @param coreDb Core Workspace authority.
 * @param workspaceId Canonical target Workspace id.
 * @param actor Immutable actor responsible for the effect.
 * @param operation Concrete product operation, including unknown values that must fail closed.
 * @param effectAuthority Whether the caller's existing effect-specific authority remains valid.
 * @param requestActor Actual authenticating actor; only its presented bearer or explicit administrator-session Token projection grants administrator eligibility without membership.
 * @param options Optional actual evaluation capture and propagation of dependency failures.
 * @returns The current effective Workspace eligibility, or null when any authority component denies the effect.
 * @throws The original dependency or capture error when strict failure handling is requested.
 */
export function currentWorkspaceAuthority(
  coreDb: CoreDb,
  workspaceId: string,
  actor: ActorRef,
  operation: string,
  effectAuthority: boolean,
  requestActor?: Actor,
  options?: WorkspaceAuthorityOptions
): WorkspaceAuthority | null {
  try {
    if (!effectAuthority) {
      return null;
    }
    const presentedActor = requestActor;
    // Preserve only the credential explicitly projected by session authentication, never infer one from a User.
    if (requestActor?.kind === 'session' && requestActor.adminTokenId !== undefined)
      requestActor = {
        kind: 'token',
        userId: requestActor.userId,
        tokenId: requestActor.adminTokenId,
        tokenScope: 'server-admin',
      };
    const responsibleUserId = responsibleUserIdForActor(actor);
    if (!responsibleUserId) return null;
    if (requestActor && requestActor.userId !== responsibleUserId) return null;
    const policySubject = options?.policy?.subject;
    const nativeProcess =
      policySubject?.credentialKind === 'worker-package' ? policySubject.process : null;
    const nativeAdmission = nativeProcess
      ? findSchedulerAdmissionForTurn(coreDb, nativeProcess)
      : null;
    const nativeWorkerPolicy = !!(
      nativeAdmission &&
      nativeProcess &&
      policySubject &&
      nativeProcess.workspaceId === workspaceId &&
      sameActorRef(nativeAdmission.triggerActor, actor) &&
      policySubject.principal.kind === 'human' &&
      policySubject.principal.id === responsibleUserId &&
      policySubject.actor.kind === 'agent' &&
      policySubject.actor.responsibleUserId === responsibleUserId &&
      policySubject.responsibleHumanId === responsibleUserId &&
      policySubject.onBehalfOf === null
    );
    if (
      options?.policy &&
      !nativeWorkerPolicy &&
      (!presentedActor ||
        actor.kind !== 'user' ||
        options.policy.subject.principal.kind !== 'human' ||
        options.policy.subject.principal.id !== presentedActor.userId ||
        options.policy.subject.actor.kind !== 'user' ||
        options.policy.subject.actor.id !== presentedActor.userId ||
        options.policy.subject.responsibleHumanId !== presentedActor.userId ||
        options.policy.subject.credentialKind !== presentedActor.kind ||
        options.policy.subject.onBehalfOf !== null ||
        options.policy.subject.process !== null)
    )
      return null;
    if (
      requestActor?.kind === 'token' &&
      requestActor.tokenScope === 'server-admin' &&
      actor.kind !== 'user'
    )
      return null;
    const administrator = requestActor
      ? requestActor.kind === 'token' &&
        requestActor.tokenScope === 'server-admin' &&
        isCurrentDeploymentAdministrator(coreDb, requestActor)
      : !!(
          options?.retainedPolicyAuthor &&
          actor.kind === 'user' &&
          currentServerPolicyAuthorEligibility(coreDb, actor.id)
        );
    const membership = resolveWorkspaceMembershipRelation(coreDb, workspaceId, responsibleUserId);
    const activeUser = isCanonicalUserActive(coreDb, responsibleUserId);
    const activeWorkspace = isActiveRegisteredWorkspace(coreDb, workspaceId);
    const credentialCurrent =
      (!presentedActor || isUsablePresentedCredential(coreDb, presentedActor)) &&
      (!requestActor || isUsablePresentedCredential(coreDb, requestActor));
    const credentialBound =
      !requestActor || tokenIncludesWorkspace(requestActor, workspaceId, undefined);
    const clientAuthority = requestActor
      ? readCurrentClientAuthorityInputs(
          coreDb,
          requestActor,
          { kind: 'workspace', workspaceId },
          operation,
          options?.mutating ?? true,
          new Date()
        )
      : null;
    let decision = evaluatePolicyKernel({
      facts: {
        userId: responsibleUserId,
        activeUser,
        administrator,
        credential: {
          kind: requestActor?.kind ?? 'retained-author',
          current: credentialCurrent,
          workspaceBound: credentialBound,
          readOnly:
            requestActor?.kind === 'token' && requestActor.tokenScope === 'workspace-readonly',
        },
      },
      target: {
        kind: 'workspace',
        workspaceId,
        active: activeWorkspace,
        membership,
      },
      operation,
      // Effect paths cannot obtain a mutation association from a read-only credential.
      mutating: options?.mutating ?? true,
      ...(options?.policy ? { policy: options.policy } : {}),
    });
    if (clientAuthority)
      decision = evaluatePolicyKernel({
        ...clientAuthority,
        userKernel: decision,
        issuerChain:
          clientAuthority.issuerChain?.map(({ input: issuerInput, ...issuer }) => ({
            ...issuer,
            kernel: evaluatePolicyKernel(issuerInput),
          })) ?? null,
      });
    // Missing eligibility facts publish no capture event; the Kernel still decides every complete request.
    if (
      !activeUser ||
      !activeWorkspace ||
      !credentialCurrent ||
      (!administrator && (!membership || !credentialBound))
    )
      return null;
    const relation: WorkspaceAuthority = administrator ? 'administrator' : 'member';
    // A capture callback cannot change the already evaluated authority result.
    const effect = decision.effect;
    if (options?.onEvaluation) {
      const member =
        relation === 'member' ? getWorkspaceMember(coreDb, workspaceId, responsibleUserId) : null;
      if (relation === 'member' && !member) {
        throw new Error('Workspace authority evaluation lost its canonical membership facts.');
      }
      const tokenId = requestActor?.kind === 'token' ? requestActor.tokenId : null;
      const token = tokenId ? getOpenKitAccessTokenRecord(coreDb, tokenId) : null;
      if (requestActor?.kind === 'token' && !token) {
        throw new Error('Workspace authority evaluation lost its presented Token facts.');
      }
      options.onEvaluation({
        decision,
        facts: {
          workspaceId,
          operation,
          responsibleUserId,
          relation,
          presentedTokenId: token?.tokenId ?? null,
          membershipRevision: member?.revision ?? null,
          presentedTokenState: token
            ? {
                tokenId: token.tokenId,
                ownerUserId: token.ownerUserId,
                scope: token.scope,
                workspaceIds: [...token.workspaceIds],
                status: token.status,
                expiresAt: token.expiresAt,
                revokedAt: token.revokedAt,
                predecessorTokenId: token.predecessorTokenId,
                rotatedGraceExpiresAt: token.rotatedGraceExpiresAt,
              }
            : null,
        },
      });
    }
    return effect === 'allow' ? relation : null;
  } catch (error) {
    if (options?.dependencyFailure === 'throw') throw error;
    return null;
  }
}

/**
 * Rechecks one durable admission's exact initiating credential before a scheduler or Worker effect.
 *
 * @param coreDb Core Workspace and Token authority.
 * @param admission Exact originating admission context.
 * @param operation Product operation being attempted now.
 * @param effectAuthority Caller-owned effect authority.
 * @param options Optional actual evaluation capture and strict dependency failure handling.
 * @returns Current Workspace eligibility, or null if a recorded token is no longer usable.
 * @throws The original Workspace authority dependency or capture error in strict mode.
 */
export function currentSchedulerAdmissionWorkspaceAuthority(
  coreDb: CoreDb,
  admission: Pick<
    CoreSchedulerQueueEntry,
    'workspaceId' | 'triggerActor' | 'serverAdminTokenId' | 'credentialRef'
  >,
  operation: string,
  effectAuthority: boolean,
  options?: WorkspaceAuthorityOptions
): WorkspaceAuthority | null {
  if (admission.credentialRef) {
    const userId = responsibleUserIdForActor(admission.triggerActor);
    if (!userId) return null;
    let requestActor: Actor;
    if (admission.credentialRef.kind === 'token') {
      const token = getOpenKitAccessTokenRecord(coreDb, admission.credentialRef.id);
      const principal: ActorRef | null = !token
        ? null
        : token.principalRef
          ? { kind: 'integration', id: token.principalRef.id, responsibleUserId: token.ownerUserId }
          : { kind: 'user', id: token.ownerUserId };
      if (
        !token ||
        token.ownerUserId !== userId ||
        !principal ||
        !sameActorRef(principal, admission.triggerActor)
      )
        return null;
      requestActor = {
        kind: 'token',
        userId,
        tokenId: token.tokenId,
        tokenScope: token.scope,
        tokenWorkspaceIds: token.workspaceIds,
      };
    } else {
      if (admission.triggerActor.kind !== 'user') return null;
      requestActor = {
        kind: 'session',
        userId,
        sessionId: admission.credentialRef.id,
        ...(admission.serverAdminTokenId ? { adminTokenId: admission.serverAdminTokenId } : {}),
      };
    }
    return currentWorkspaceAuthority(
      coreDb,
      admission.workspaceId,
      admission.triggerActor,
      operation,
      effectAuthority,
      requestActor,
      options
    );
  }
  // An Integration admission cannot reconstruct a different Token from its stable principal.
  if (admission.triggerActor.kind === 'integration') return null;
  if (admission.serverAdminTokenId === null) {
    return currentWorkspaceAuthority(
      coreDb,
      admission.workspaceId,
      admission.triggerActor,
      operation,
      effectAuthority,
      undefined,
      options
    );
  }
  if (admission.serverAdminTokenId.length === 0 || admission.triggerActor.kind !== 'user') {
    return null;
  }
  const requestActor: Actor = {
    kind: 'token',
    tokenId: admission.serverAdminTokenId,
    tokenScope: 'server-admin',
    userId: admission.triggerActor.id,
  };
  return currentWorkspaceAuthority(
    coreDb,
    admission.workspaceId,
    admission.triggerActor,
    operation,
    effectAuthority,
    requestActor,
    options
  );
}

/**
 * Rechecks current authority from the exact lease and package that own a Worker effect.
 *
 * @param coreDb Core Workspace, lease, and Token authority.
 * @param lineage Worker package lineage and its immutable trigger actor.
 * @param operation Product operation being attempted now.
 * @param effectAuthority Caller-owned effect authority.
 * @param options Optional actual evaluation capture and strict dependency failure handling.
 * @returns Current Workspace eligibility, or null when lineage or current authority is invalid.
 * @throws The original Workspace authority dependency or capture error in strict mode.
 */
export function currentWorkerLineageWorkspaceAuthority(
  coreDb: CoreDb,
  lineage: SchedulerExecutionLineage & { readonly triggerActor: ActorRef },
  operation: string,
  effectAuthority: boolean,
  options?: WorkspaceAuthorityOptions
): WorkspaceAuthority | null {
  const admission = findSchedulerAdmissionForWorkerLineage(coreDb, lineage);
  if (!admission || !sameActorRef(admission.triggerActor, lineage.triggerActor)) {
    return null;
  }
  const responsibleHumanId = responsibleUserIdForActor(admission.triggerActor);
  if (!responsibleHumanId) return null;
  return currentSchedulerAdmissionWorkspaceAuthority(
    coreDb,
    admission,
    operation,
    effectAuthority,
    options?.policy
      ? {
          ...options,
          policy: {
            ...options.policy,
            subject: {
              ...options.policy.subject,
              principal: { kind: 'human', id: responsibleHumanId },
              onBehalfOf: null,
              responsibleHumanId,
              process: {
                workspaceId: admission.workspaceId,
                threadId: admission.threadId,
                turnId: admission.turnId,
              },
            },
          },
        }
      : options
  );
}

/**
 * Rechecks a product Turn's exact live admission before its Worker lease is created.
 *
 * @param coreDb Core Workspace and admission authority.
 * @param lineage Exact product Turn and trigger actor.
 * @param operation Product operation being attempted now.
 * @param effectAuthority Caller-owned effect authority.
 * @returns Current Workspace eligibility, or null when the live admission or actor differs.
 */
export function currentScheduledTurnWorkspaceAuthority(
  coreDb: CoreDb,
  lineage: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly triggerActor: ActorRef;
  },
  operation: string,
  effectAuthority: boolean
): WorkspaceAuthority | null {
  const admission = findSchedulerAdmissionForTurn(coreDb, lineage);
  if (!admission || !sameActorRef(admission.triggerActor, lineage.triggerActor)) {
    return null;
  }
  return currentSchedulerAdmissionWorkspaceAuthority(coreDb, admission, operation, effectAuthority);
}

/** Compares immutable ActorRef fields without relying on JSON key order. */
function sameActorRef(left: ActorRef, right: ActorRef): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    (left.kind === 'user' ||
      (right.kind !== 'user' && left.responsibleUserId === right.responsibleUserId))
  );
}

/** Reads current facts before the evaluator-only boundary; Server refusals retain their public causes. */
export function evaluateProductAuthorization(
  coreDb: CoreDb | undefined,
  actor: Actor,
  target:
    | { readonly kind: 'user'; readonly userId?: string }
    | { readonly kind: 'invitation'; readonly invitationId: string }
    | { readonly kind: 'server'; readonly family?: string | undefined }
    | { readonly kind: 'workspace'; readonly workspaceId: string; readonly deletedRecovery?: true },
  operation: string,
  mutating = false,
  now = new Date(),
  context?: ProductPolicyInput['context']
): PolicyDecision {
  // The original in-memory local Server projection belongs with the other
  // credential facts here, rather than being duplicated by operation admission.
  if (!coreDb && (actor.kind !== 'local' || target.kind !== 'server'))
    throw new HTTPException(503, { message: 'Operation authority storage is unavailable.' });
  const input = coreDb
    ? readProductAuthorizationInput(coreDb, actor, target, operation, mutating, now)
    : {
        facts: {
          userId: actor.userId,
          activeUser: true,
          administrator: actor.kind === 'local',
          credential: {
            current: actor.kind === 'local',
            workspaceBound: false,
            readOnly: false,
            kind: actor.kind,
          },
        },
        target: {
          kind: 'server' as const,
          family: target.kind === 'server' ? target.family : undefined,
        },
        operation,
        mutating,
      };
  const clientAuthority =
    coreDb && !(target.kind === 'server' && target.family === 'mcp' && operation === 'api.call')
      ? readCurrentClientAuthorityInputs(coreDb, actor, target, operation, mutating, now)
      : null;
  let decision: PolicyDecision;
  try {
    decision = evaluatePolicyKernel({ ...input, ...(context ? { context } : {}) });
    if (clientAuthority)
      decision = evaluatePolicyKernel({
        ...clientAuthority,
        userKernel: decision,
        issuerChain:
          clientAuthority.issuerChain?.map(({ input: issuerInput, ...issuer }) => ({
            ...issuer,
            // Every issuer is bounded by the same actual Thread audience, using its own User facts.
            kernel: evaluatePolicyKernel({ ...issuerInput, ...(context ? { context } : {}) }),
          })) ?? null,
      });
  } catch (error) {
    if (target.kind !== 'server') throw error;
    throw new HTTPException(403, { res: workspaceAccessDenied(), cause: error });
  }
  if (target.kind === 'server' && decision.effect !== 'allow' && !input.facts.administrator)
    throw new DeploymentAdminRequiredError();
  return decision;
}

/** Reads actual client and issuer facts before the evaluator-only refusal boundary. */
function readCurrentClientAuthorityInputs(
  coreDb: CoreDb,
  actor: Actor,
  target: Parameters<typeof evaluateProductAuthorization>[2],
  operation: string,
  mutating: boolean,
  now: Date
) {
  const token =
    actor.kind === 'token' && actor.tokenId
      ? getOpenKitAccessTokenRecord(coreDb, actor.tokenId)
      : null;
  if (!token?.principalRef) return null;
  const lineage = readCurrentOpenKitAccessTokenLineage(coreDb, token, now);
  const issuerChain = lineage?.terminalUserId
    ? [
        ...lineage.issuers.map((issuer) => ({
          principal: issuer.principalRef
            ? {
                kind: 'integration' as const,
                id: issuer.principalRef.id,
                responsibleUserId: issuer.ownerUserId,
              }
            : { kind: 'user' as const, id: issuer.ownerUserId },
          active:
            isCanonicalUserActive(coreDb, issuer.ownerUserId) &&
            evaluateOpenKitAccessTokenUsability(issuer, now).usable,
          input: readProductAuthorizationInput(
            coreDb,
            {
              kind: 'token',
              userId: issuer.ownerUserId,
              tokenId: issuer.tokenId,
              tokenScope: issuer.scope,
              tokenWorkspaceIds: issuer.workspaceIds,
            },
            target,
            operation,
            mutating,
            now
          ),
        })),
        (() => {
          const issuerUserId = lineage.terminalUserId!;
          const current = readProductAuthorizationInput(
            coreDb,
            { kind: 'session', userId: issuerUserId },
            target,
            operation,
            mutating,
            now
          );
          return {
            principal: { kind: 'user' as const, id: issuerUserId },
            active: isCanonicalUserActive(coreDb, issuerUserId),
            // Retained actual issuer authority is not the caller's presented credential;
            // the caller's independent current User/Token Kernel remains mandatory.
            input: {
              ...current,
              facts: {
                ...current.facts,
                administrator: currentServerPolicyAuthorEligibility(
                  coreDb,
                  issuerUserId,
                  now.getTime()
                ),
                credential: {
                  kind: 'retained-author' as const,
                  current: isCanonicalUserActive(coreDb, issuerUserId),
                  workspaceBound: true,
                  readOnly: false,
                },
              },
            },
          };
        })(),
      ]
    : null;
  const current = readProductAuthorizationInput(coreDb, actor, target, operation, mutating, now);
  return {
    binding: {
      principal: {
        kind: 'integration' as const,
        id: token.principalRef.id,
        responsibleUserId: token.ownerUserId,
      },
      principalOwnerUserId: token.ownerUserId,
      token,
    },
    operation,
    target: current.target,
    native: { workspaceScoped: target.kind === 'workspace', mutating },
    issuerChain,
  };
}

/** Keeps current authority-read failures outside the caller's evaluator-only refusal boundary. */
function readProductAuthorizationInput(
  coreDb: CoreDb,
  actor: Actor,
  target:
    | { readonly kind: 'user'; readonly userId?: string }
    | { readonly kind: 'invitation'; readonly invitationId: string }
    | { readonly kind: 'server'; readonly family?: string | undefined }
    | { readonly kind: 'workspace'; readonly workspaceId: string; readonly deletedRecovery?: true },
  operation: string,
  mutating = false,
  now = new Date()
): ProductPolicyInput {
  const administrator = isCurrentDeploymentAdministrator(coreDb, actor, now);
  const currentTarget: ProductAccessTarget =
    target.kind === 'workspace'
      ? {
          kind: 'workspace',
          workspaceId: target.workspaceId,
          active: isActiveRegisteredWorkspace(coreDb, target.workspaceId),
          membership: resolveWorkspaceMembershipRelation(coreDb, target.workspaceId, actor.userId),
          ...(target.deletedRecovery
            ? {
                deletedRecovery: (() => {
                  const row = coreDb.sqlite
                    .prepare(
                      'SELECT owner_user_id,status FROM workspace_registry WHERE workspace_id=?'
                    )
                    .get(target.workspaceId) as
                    | { owner_user_id: string; status: string }
                    | undefined;
                  return {
                    ownerActive:
                      !!row &&
                      ['deleted', 'active'].includes(row.status) &&
                      isCanonicalUserActive(coreDb, row.owner_user_id),
                    originalOwner: row?.owner_user_id === actor.userId,
                  };
                })(),
              }
            : {}),
        }
      : target.kind === 'user'
        ? { ...target, active: isCanonicalUserActive(coreDb, target.userId ?? actor.userId) }
        : target.kind === 'invitation'
          ? {
              ...target,
              inviteeUserId:
                getWorkspaceInvitation(coreDb, target.invitationId)?.inviteeUserId ?? null,
            }
          : target;
  return {
    facts: {
      userId: actor.userId,
      activeUser: isCanonicalUserActive(coreDb, actor.userId),
      administrator,
      credential: {
        kind: actor.kind,
        current: isUsablePresentedCredential(coreDb, actor, now),
        workspaceBound:
          target.kind !== 'workspace' ||
          tokenIncludesWorkspace(actor, target.workspaceId, undefined),
        readOnly: actor.kind === 'token' && actor.tokenScope === 'workspace-readonly',
      },
    },
    target: currentTarget,
    operation,
    mutating,
  };
}

/** Requires the current administrator Kernel association; callers retain their dependency-error mapping. */
export function requireAdministratorOperation(
  coreDb: CoreDb,
  actor: Actor | undefined,
  operation: string,
  now = new Date(),
  family?: string
): void {
  if (!actor) throw new DeploymentAdminRequiredError();
  if (
    evaluateProductAuthorization(coreDb, actor, { kind: 'server', family }, operation, false, now)
      .effect !== 'allow'
  )
    throw new DeploymentAdminRequiredError();
}

/** Evaluates an exact User-owned effect with the actual caller, retaining administrator eligibility. */
export function evaluateOwnedUserOperation(
  coreDb: CoreDb,
  actor: Actor,
  ownerUserId: string,
  operation: string,
  mutating: boolean
): ReturnType<typeof evaluateProductAuthorization> {
  return evaluateProductAuthorization(
    coreDb,
    actor,
    actor.userId === ownerUserId ? { kind: 'user' } : { kind: 'user', userId: ownerUserId },
    operation,
    mutating
  );
}

/**
 * Projects the current exact Core refresh-failure tuple through the User Kernel rule.
 * Main must separately authenticate its invocation-scoped witness; native repeats the original
 * Workspace and separate User decisions. A cause value alone never authenticates a caller.
 */
export function evaluateCoreConfirmedLoginQuarantine(
  coreDb: CoreDb,
  input: {
    readonly binding: NonNullable<
      Extract<ControlVaultInput, { kind: 'receipt-create' }>['record']['loginBinding']
    >;
    readonly failureClass: 'invalid-grant';
  }
) {
  const { binding, failureClass } = input;
  const { consumer, declaration, materialVersion } = binding.binding;
  const proof = binding.policyProof;
  const caller = proof?.caller;
  if (
    failureClass !== 'invalid-grant' ||
    !proof ||
    caller?.kind !== 'worker' ||
    binding.requester.requester.kind !== 'worker' ||
    declaration.visibility !== 'runtime-token' ||
    declaration.consumer !== 'codex-login' ||
    binding.requester.workspaceId !== consumer.scope.workspaceId ||
    caller.lineage.workspaceId !== consumer.scope.workspaceId ||
    !isDeepStrictEqual(binding.requester.requester, {
      kind: 'worker',
      actor: caller.actor,
      lineage: caller.lineage,
    }) ||
    !Number.isSafeInteger(materialVersion) ||
    materialVersion < 1
  )
    throw new ControlProductPreconditionError();
  const responsibleUserId = responsibleUserIdForActor(caller.actor);
  if (
    !responsibleUserId ||
    proof.proposal.subject.responsibleHumanId !== responsibleUserId ||
    proof.proposal.subject.credentialKind !== 'worker-package' ||
    !isDeepStrictEqual(proof.proposal.subject.process, {
      workspaceId: caller.lineage.workspaceId,
      threadId: caller.lineage.threadId,
      turnId: caller.lineage.turnId,
    }) ||
    !currentWorkerLineageWorkspaceAuthority(
      coreDb,
      { ...caller.lineage, triggerActor: caller.actor },
      'vault.use',
      true,
      { dependencyFailure: 'throw', mutating: true }
    )
  )
    throw new ControlProductPreconditionError();
  const selected = (() => {
    try {
      // The existing credential owner supplies the real reviewed grant and exact current family.
      return assertCurrentWorkerCredentialAuthority(
        coreDb,
        consumer,
        () => new Date().toISOString(),
        declaration
      );
    } catch (error) {
      if (error instanceof TurnStartValidationError) throw new ControlProductPreconditionError();
      throw error;
    }
  })();
  const { reference, grant } = selected;
  if (
    !reference.userId ||
    !isCanonicalUserActive(coreDb, reference.userId) ||
    !isDeepStrictEqual(reference, binding.reference) ||
    reference.currentVersion !== materialVersion ||
    grant.issuance !== 'target' ||
    !isTargetIssuedEffectAuthority(grant.approvalId) ||
    grant.policyDecisionId === null
  )
    throw new ControlProductPreconditionError();
  const kernel = evaluatePolicyKernel({
    facts: {
      userId: responsibleUserId,
      activeUser: isCanonicalUserActive(coreDb, responsibleUserId),
      administrator: false,
      // Both current mutating Worker-use reads above established this credential posture.
      credential: {
        kind: 'worker-package',
        current: true,
        workspaceBound: true,
        readOnly: false,
      },
      coreConfirmedLoginQuarantine: {
        operation: 'vault.login-quarantine',
        ownerUserId: reference.userId,
        referenceId: reference.referenceId,
        grantId: grant.grantId,
        materialVersion,
        failureClass,
      },
    },
    target: { kind: 'user', userId: reference.userId, active: true },
    operation: OPERATION_DEFINITIONS['vault.login-quarantine'].policyOperation,
    mutating: OPERATION_DEFINITIONS['vault.login-quarantine'].mutating,
  });
  return { kernel, reference, grant };
}

/** Current canonical User admission is the primary Kernel result; dependency failures remain caller-owned. */
export function isCanonicalUserOperationAuthorized(
  coreDb: CoreDb,
  actor: Actor,
  operation: string = 'api.call'
): boolean {
  const input = readProductAuthorizationInput(
    coreDb,
    actor,
    { kind: 'user' },
    operation,
    false,
    new Date()
  );
  try {
    return evaluatePolicyKernel(input).effect === 'allow';
  } catch {
    return false;
  }
}

/** Checks current initiating-user or administrator retry authority; the deletion owner validates the exact request before effects. */
export function hasWorkspaceDeletionRetryAuthority(
  coreDb: CoreDb,
  actor: Actor,
  workspaceId: string,
  request: { dataRoot: string; requestId: string }
): boolean {
  const current = currentWorkspaceDeletionRetryCoreAuthority(coreDb, actor, workspaceId);
  if (!current) return false;
  // Administrators may inspect a contradictory request through the deletion owner, which returns recovery_required before effects. A malformed record never supplies member authority.
  if (current.administrator) return true;
  let deletion: ReturnType<typeof readWorkspaceDeletionRequest>;
  try {
    deletion = readWorkspaceDeletionRequest(request.dataRoot, workspaceId, request.requestId);
  } catch {
    return false;
  }
  return (
    deletion.originalOwnerUserId === current.ownerUserId &&
    deletion.initiatingUserId === actor.userId
  );
}

/** Reads the original current Core eligibility before any separate file-owned request selection. */
function currentWorkspaceDeletionRetryCoreAuthority(
  coreDb: CoreDb,
  actor: Actor,
  workspaceId: string
): Readonly<{ ownerUserId: string; administrator: boolean }> | null {
  if (!isCanonicalUserActive(coreDb, actor.userId) || !isUsablePresentedCredential(coreDb, actor))
    return null;
  if (actor.kind === 'token' && !isUsablePresentedServerAdminToken(coreDb, actor)) {
    if (actor.tokenScope !== 'workspace' || !actor.tokenWorkspaceIds?.includes(workspaceId)) {
      return null;
    }
  }
  const row = coreDb.sqlite
    .prepare(
      `SELECT registry.owner_user_id AS ownerUserId, registry.status, users.status AS userStatus
       FROM workspace_registry AS registry
       INNER JOIN users ON users.id = registry.owner_user_id
       WHERE registry.workspace_id = ?`
    )
    .get(workspaceId) as
    | { ownerUserId: string; status: 'active' | 'deleting' | 'deleted'; userStatus: string }
    | undefined;
  if (row?.userStatus !== 'active' || (row.status !== 'deleting' && row.status !== 'deleted')) {
    return null;
  }
  return {
    ownerUserId: row.ownerUserId,
    administrator: isCurrentDeploymentAdministrator(coreDb, actor),
  };
}

/** Revalidates the same Core predicates using only the original request facts already selected by its lifecycle owner. */
export function hasWorkspaceDeletionRetryAuthorityForRequest(
  coreDb: CoreDb,
  actor: Actor,
  workspaceId: string,
  request: { readonly originalOwnerUserId: string; readonly initiatingUserId: string }
): boolean {
  const current = currentWorkspaceDeletionRetryCoreAuthority(coreDb, actor, workspaceId);
  return (
    !!current &&
    (current.administrator ||
      (request.originalOwnerUserId === current.ownerUserId &&
        request.initiatingUserId === actor.userId))
  );
}

/**
 * Authorizes one Workspace against current membership, credential, and policy facts.
 *
 * @param coreDb Core Workspace authority.
 * @param actor Authenticated request actor.
 * @param workspaceId Canonical target Workspace id.
 * @param access Exact operation metadata.
 * @returns Authorized Workspace and ownership identity, or null on any denial.
 */
export function authorizeWorkspace(
  coreDb: CoreDb,
  actor: Actor,
  workspaceId: string,
  access: Pick<PublicOperationAccess, 'mutating' | 'policyOperation'> & {
    readonly authentication?: PublicOperationAccess['authentication'];
  }
): AuthorizedWorkspace | null {
  const input = readProductAuthorizationInput(
    coreDb,
    actor,
    { kind: 'workspace', workspaceId },
    access.policyOperation,
    access.mutating,
    new Date()
  );
  try {
    const decision = evaluatePolicyKernel(input);
    return decision.effect === 'allow'
      ? {
          workspaceId,
          isOwner: input.target.kind === 'workspace' && input.target.membership === 'owner',
        }
      : null;
  } catch {
    return null;
  }
}

/** Audience is checked after selected-Workspace authority and before addressed content. */
export function requireThreadAudience(
  store: FsStore,
  coreDb: CoreDb,
  entry:
    | Exclude<OperationInvocationContext, { kind: 'bootstrap' }>
    | AssistantOperationInvocationContext,
  workspaceId: string,
  threadId: string,
  operation = 'thread.read',
  retained?: { readonly quickChatWorkspaceIdForUser: (userId: string) => string }
): void {
  const userId =
    entry.kind === 'worker' ? responsibleUserIdForActor(entry.actor) : entry.actor.userId;
  try {
    const retainedWorkspace = retained ? store.getWorkspace(workspaceId) : undefined;
    let actor: ThreadPolicyActor = { kind: 'user', userId: userId! };
    if (entry.kind === 'worker') {
      const turn = store.getTurnById(entry.lineage.turnId);
      if (!turn.agentId || turn.agentSessionId !== entry.lineage.agentSessionId)
        throw new Error('Thread access denied.');
      actor = {
        kind: 'agent',
        userId: userId!,
        agentId: turn.agentId,
        processId: entry.lineage.agentSessionId,
      };
    }
    const thread = store.getThread(workspaceId, threadId);
    if (
      evaluatePolicyKernel(
        readThreadPolicyFacts({
          workspaceId,
          thread,
          ancestorThreadIds: readThreadPolicyAncestors(store, thread),
          userId: userId!,
          administrator:
            entry.kind !== 'worker' && isCurrentDeploymentAdministrator(coreDb, entry.actor),
          personalWorkspaceId: retained
            ? retainedWorkspace!.kind === 'personal'
              ? retained.quickChatWorkspaceIdForUser(userId!)
              : undefined
            : store.getWorkspace(workspaceId).kind === 'personal'
              ? quickChatWorkspaceIdForUser(userId!, store.getDataRoot())
              : undefined,
          actor,
          operation,
          policy: store.getWorkspaceResourceAccess(workspaceId),
        })
      ).effect !== 'allow'
    )
      throw new Error('Thread access denied.');
  } catch {
    throw new OperationError('not_found', 'Thread not found.', 404);
  }
}

/**
 * True when the actor is a presented usable server-admin bearer token.
 *
 * Session-derived deployment administration does not qualify; only the bearer itself does.
 *
 * @param coreDb Core identity and Token authority.
 * @param actor Authenticated request actor.
 * @param now Current time for Token usability evaluation.
 * @returns True only for a usable presented server-admin Token actor.
 */
export function isUsablePresentedServerAdminToken(
  coreDb: CoreDb,
  actor: Actor,
  now = new Date()
): boolean {
  return (
    actor.kind === 'token' &&
    actor.tokenScope === 'server-admin' &&
    isUsablePresentedCredential(coreDb, actor, now)
  );
}

/**
 * Rechecks current presented Token and AuthSession usability at the original durable owners.
 *
 * Actual browser sessions retain their exact id and expiry. A presented workspace or
 * workspace-readonly Token must still match its owner, exact scope, and current usability.
 *
 * @param coreDb Core identity and Token authority.
 * @param actor Authenticated request actor.
 * @param now Current time for Token usability evaluation.
 * @returns True when the actual presented credential remains current, or no durable credential is presented.
 */
function isUsablePresentedCredential(coreDb: CoreDb, actor: Actor, now = new Date()): boolean {
  if (actor.kind === 'session' && actor.sessionId) {
    const session = coreDb.sqlite
      .prepare('SELECT user_id AS userId, expires_at AS expiresAt FROM session WHERE id = ?')
      .get(actor.sessionId) as { userId: string; expiresAt: number } | undefined;
    return (
      session?.userId === actor.userId &&
      session.expiresAt > now.getTime() &&
      isCanonicalUserActive(coreDb, actor.userId)
    );
  }
  if (actor.kind !== 'token') {
    return true;
  }
  if (!actor.tokenId || !actor.tokenScope) {
    return false;
  }
  if (!isCanonicalUserActive(coreDb, actor.userId)) {
    return false;
  }
  const token = getOpenKitAccessTokenRecord(coreDb, actor.tokenId);
  return (
    token?.ownerUserId === actor.userId &&
    token.scope === actor.tokenScope &&
    evaluateOpenKitAccessTokenUsability(token, now).usable &&
    readCurrentOpenKitAccessTokenLineage(coreDb, token, now) !== null
  );
}

/**
 * True when the Workspace registry currently marks the id as active.
 *
 * @param coreDb Core Workspace authority.
 * @param workspaceId Canonical Workspace id.
 * @returns True only for an active registry row.
 */
function isActiveRegisteredWorkspace(coreDb: CoreDb, workspaceId: string): boolean {
  const row = coreDb.sqlite
    .prepare('SELECT status FROM workspace_registry WHERE workspace_id = ?')
    .get(workspaceId) as { status: string } | undefined;
  return row?.status === 'active';
}

/**
 * Checks one token's exact Workspace binding while leaving session and local actors unbounded.
 *
 * @param actor Authenticated request actor.
 * @param workspaceId Canonical target Workspace id.
 * @returns True when the actor's credential may address the Workspace.
 */
function tokenIncludesWorkspace(
  actor: Actor,
  workspaceId: string,
  authentication: PublicOperationAccess['authentication']
): boolean {
  if (actor.kind !== 'token') {
    return true;
  }
  if (actor.tokenScope === 'server-admin') {
    return authentication === 'deployment-admin';
  }
  if (actor.tokenScope !== 'workspace' && actor.tokenScope !== 'workspace-readonly') {
    return false;
  }
  return actor.tokenWorkspaceIds?.includes(workspaceId) === true;
}

/** Returns the uniform non-enumerating Workspace access failure. */
function workspaceAccessDenied(): Response {
  return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
}

/** Checks the existing current-administrator owner without treating unpresented Tokens as authority. */
export function isCurrentDeploymentAdministrator(
  coreDb: CoreDb,
  actor: Actor,
  now = new Date()
): boolean {
  try {
    requireCurrentDeploymentAdmin(coreDb, actor, now);
    return true;
  } catch (error) {
    if (error instanceof DeploymentAdminRequiredError) return false;
    throw error;
  }
}

/** Candidate-first collection admission shared by catalog guards and native operation invocation. */
export function authorizedWorkspaceSet(
  coreDb: CoreDb,
  actor: Actor,
  access: Pick<PublicOperationAccess, 'mutating' | 'policyOperation'>,
  nativeScope: Pick<ReturnType<typeof getControlStoreWorkerClient>, 'isWorkspaceLifecycleClosed'>
): string[] {
  const candidates = isCurrentDeploymentAdministrator(coreDb, actor)
    ? listActiveWorkspaceIds(coreDb)
    : listActiveWorkspaceIdsForActor(coreDb, actor.userId);
  return candidates.filter(
    (workspaceId) =>
      !nativeScope.isWorkspaceLifecycleClosed(coreDb.dataRoot, workspaceId) &&
      isScopeAdmitted(coreDb.dataRoot, 'workspace', workspaceId) &&
      authorizeWorkspace(coreDb, actor, workspaceId, access) !== null
  );
}

/** The canonical User lifecycle predicate remains owned by User lifecycle. */
export { isCanonicalUserActive } from './user-lifecycle.js';

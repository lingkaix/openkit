import { randomUUID } from 'node:crypto';

import {
  ExecuteGitPushRequestSchema,
  ExecuteGitPushResponseSchema,
  GetGitPushRecordResponseSchema,
  type GitPushRecord,
  ListGitPushRecordsResponseSchema,
  ListWorkspaceRepositoriesResponseSchema,
  RequestGitPushApprovalRequestSchema,
  RequestGitPushApprovalResponseSchema,
  SetWorkspaceRepositoryRequestSchema,
  SetWorkspaceRepositoryResponseSchema,
  WorkspaceRepositoryDiagnosticsResponseSchema,
  WorkspaceRepositoryResourceSchema,
} from '@openkit/app-api-schemas';
import type { OpenKitConfig } from '@openkit/config-schema';
import { isSealedTurnTerminal } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from './auth/operation-authorizer.js';
import { isThreadIdVisible } from './auth/thread-visibility.js';
import { listWorkspaceCapabilityCalls } from './capability/usage-ledger.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import { createPolicyApprovalGate } from './policy/approval-gates.js';
import { readPolicyApprovalDecision } from './policy/permission-decisions.js';
import type { RepoPushCallerAuthority } from './runtime/git-push-executor.js';
import {
  currentRepoPushCallerAuthority,
  executeGitPushAttempt,
  runGitPushCommand,
} from './runtime/git-push-executor.js';
import {
  getGitPushRecord,
  getGitPushRecordByApprovalRowId,
  listGitPushRecords,
} from './runtime/git-push-records.js';
import {
  GitPushSourceUnavailableError,
  inspectGitPushRepository,
} from './runtime/git-push-repository.js';
import {
  commandInputHash,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { isTargetIssuedEffectAuthority } from './storage/workspace-import-authority.js';
import type { VaultBackend } from './vault/vault-backend.js';
import { vaultSecretMaterialToString } from './vault/vault-backend.js';
import { getVaultGrant } from './vault/vault-grants.js';
import { getVaultReference } from './vault/vault-references.js';
import { createVaultUseAuditedBackend } from './vault/vault-use-audited-backend.js';
import { createVaultInjectionPlan } from './vault-injection-plans.js';
import { createVaultInjectionReceipt } from './vault-injection-receipts.js';
import {
  createWorkspaceRepositoryDiagnostic,
  safeWorkspaceRepositoryDisplayName,
} from './workspace/repository-diagnostics.js';
import {
  getDefaultWorkspaceRepositoryResource,
  getWorkspaceRepositoryResource,
  listWorkspaceRepositoryResources,
  upsertWorkspaceRepositoryResource,
  type WorkspaceRepositoryResourceRecord,
} from './workspace/repository-store.js';
import { validateRepositoryPath } from './workspace/repository-validation.js';

/** Immutable repo.push allow decision consumed by one Git push execution. */
const RepoPushApprovalDecisionSchema = z
  .object({
    action: z.literal('repo.push'),
    reasonCode: z.string().min(1),
    contextSummary: z
      .object({
        requestId: z.string().min(1),
        worker: z
          .object({
            agentId: z.string().min(1),
            agentSessionId: z.string().min(1),
            packageSnapshotId: z.string().min(1),
            capabilityCallId: z.string().min(1),
          })
          .strict()
          .optional(),
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        commandTurnId: z.string().min(1),
        workspaceId: z.string().min(1),
      })
      .strict(),
    decisionId: z.string().min(1),
    resourceSummary: z
      .object({
        commitIds: z.array(z.string().min(1)).min(1),
        kind: z.literal('git-push-target'),
        remoteIdentity: z.string().min(1),
        remoteName: z.literal('origin'),
        remoteSummary: z.string().min(1),
        repositoryResourceId: z.string().min(1),
        sourceCommit: z.string().min(1),
        sourceRef: z.string().min(1),
        targetBranch: z.string().min(1),
        workspaceId: z.string().min(1),
      })
      .strict(),
    subjectSummary: z
      .object({
        kind: z.literal('user'),
        userId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/**
 * Registers repository linking, diagnostics, Git push approval, execution, and record routes.
 *
 * @param dependencies Hono app and concrete repository storage, policy, and vault dependencies.
 */
export function registerRepositoryRoutes({
  app,
  assertProjectWorkspace,
  coreDb,
  inflightCommands,
  approvalPolicy,
  repositoryWorkspaceDb,
  requestStore,
  vaultBackend,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly assertProjectWorkspace: (
    workspace: ReturnType<FsStore['getWorkspace']>,
    action: string
  ) => void;
  readonly coreDb: CoreDb | undefined;
  readonly approvalPolicy: OpenKitConfig['policy'];
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly vaultBackend: (() => VaultBackend) | undefined;
}): void {
  registerAppApiRoute(app, 'listWorkspaceRepositories', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        const items = listWorkspaceRepositoryResources(workspaceDb, workspaceId).map((record) =>
          repositoryReadModel(record)
        );
        const defaultResource = getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId);

        return c.json(
          ListWorkspaceRepositoriesResponseSchema.parse({
            items,
            defaultResourceId: defaultResource?.resourceId ?? null,
            defaultResource: defaultResource ? repositoryReadModel(defaultResource) : null,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asRepositoryApiError(error);
    }
  });

  registerAppApiRoute(app, 'getWorkspaceRepositoryDiagnostics', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        const resources = listWorkspaceRepositoryResources(workspaceDb, workspaceId).map((record) =>
          createWorkspaceRepositoryDiagnostic(record)
        );
        const defaultResource = getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId);

        return c.json(
          WorkspaceRepositoryDiagnosticsResponseSchema.parse({
            workspaceId,
            defaultResourceId: defaultResource?.resourceId ?? null,
            defaultResource: defaultResource
              ? createWorkspaceRepositoryDiagnostic(defaultResource)
              : null,
            resources,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asRepositoryApiError(error);
    }
  });

  registerAppApiRoute(app, 'listGitPushRecords', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        return c.json(
          ListGitPushRecordsResponseSchema.parse({
            items: listGitPushRecords(workspaceDb, workspaceId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asRepositoryApiError(error);
    }
  });

  registerAppApiRoute(app, 'requestGitPushApproval', async (c) => {
    const parsed = RequestGitPushApprovalRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const resourceId = c.req.param('resourceId') ?? '';
      const store = requestStore(c);
      const input = parsed.data;
      const workspace = store.getWorkspace(workspaceId);
      const actorId = c.get('actor').userId;

      assertProjectWorkspace(workspace, 'request Git push approval');
      let turn: ReturnType<FsStore['getTurn']> | null = null;
      try {
        turn = store.getTurn(workspaceId, input.threadId, input.turnId);
      } catch {
        // Scoped-only owners use the uniform non-enumerating denial.
      }
      assertAuthorizedWorkspaceLineage(c.get('workspaceAccess'), turn?.workspaceId ?? null);

      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        const repository = getWorkspaceRepositoryResource(workspaceDb, workspaceId, resourceId);
        assertAuthorizedWorkspaceLineage(c.get('workspaceAccess'), repository?.workspaceId ?? null);
        if (!repository) {
          throw new Error(`Repository resource not found: ${resourceId}`);
        }
        const response = await requestRepositoryPushApproval(
          {
            actorId,
            authority: { kind: 'request', actor: c.get('actor') },
            approvalPolicy,
            coreDb,
            inflightCommands,
            repository,
            store,
            vaultBackend,
            workspaceDb,
            workspaceId,
          },
          input
        );

        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asCommandError(error, 'git_push_approval_request_failed');
    }
  });

  registerAppApiRoute(app, 'executeGitPush', async (c) => {
    const parsed = ExecuteGitPushRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const resourceId = c.req.param('resourceId') ?? '';
      const store = requestStore(c);
      const input = parsed.data;
      const workspace = store.getWorkspace(workspaceId);
      const actorId = c.get('actor').userId;

      assertProjectWorkspace(workspace, 'execute Git push');
      const approval = store.getApproval(input.approvalRequestId);
      assertAuthorizedWorkspaceLineage(c.get('workspaceAccess'), approval.workspaceId);

      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        const repository = getWorkspaceRepositoryResource(workspaceDb, workspaceId, resourceId);
        assertAuthorizedWorkspaceLineage(c.get('workspaceAccess'), repository?.workspaceId ?? null);
        if (!repository) {
          throw new Error(`Repository resource not found: ${resourceId}`);
        }
        const response = await executeRepositoryPush(
          {
            actorId,
            authority: { kind: 'request', actor: c.get('actor') },
            approvalPolicy,
            coreDb,
            inflightCommands,
            repository,
            store,
            vaultBackend,
            workspaceDb,
            workspaceId,
          },
          input
        );

        return c.json(ExecuteGitPushResponseSchema.parse(response));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asCommandError(error, 'git_push_failed');
    }
  });

  registerAppApiRoute(app, 'getGitPushRecord', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const pushRecordId = c.req.param('pushRecordId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);

      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      let record: GitPushRecord | null;
      try {
        record = getGitPushRecord(workspaceDb, workspaceId, pushRecordId);
      } finally {
        workspaceDb.sqlite.close();
      }
      assertAuthorizedWorkspaceLineage(c.get('workspaceAccess'), record?.workspaceId ?? null);

      if (!record) {
        return asApiError(`Git push record not found: ${pushRecordId}`);
      }

      return c.json(GetGitPushRecordResponseSchema.parse(record));
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asRepositoryApiError(error);
    }
  });

  /**
   * Creates or updates the default repository resource for one workspace.
   *
   * @param c Hono request context.
   * @returns Redacted repository resource response.
   */
  async function setDefaultWorkspaceRepository(
    c: Context<{ Variables: AuthVariables }>
  ): Promise<Response> {
    const parsed = SetWorkspaceRepositoryRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const store = requestStore(c);
      const workspace = store.getWorkspace(workspaceId);

      assertProjectWorkspace(workspace, 'link repositories');

      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        const repository = upsertWorkspaceRepositoryResource(workspaceDb, {
          workspaceExists: (candidateWorkspaceId) => {
            try {
              store.getWorkspace(candidateWorkspaceId);
              return true;
            } catch {
              return false;
            }
          },
          workspaceId,
          displayName: parsed.data.displayName,
          localPath: parsed.data.localPath,
          ...(parsed.data.git ? { git: parsed.data.git } : {}),
          ...(parsed.data.resourceId ? { resourceId: parsed.data.resourceId } : {}),
        });

        return c.json(
          SetWorkspaceRepositoryResponseSchema.parse({
            repository: repositoryReadModel(repository),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asRepositoryApiError(error);
    }
  }

  registerAppApiRoute(app, 'setDefaultWorkspaceRepository', setDefaultWorkspaceRepository);
}

/**
 * Converts a repository storage record to the redacted App API read model.
 *
 * @param record Stored repository resource record.
 * @returns Redacted repository resource payload.
 */
function repositoryReadModel(record: WorkspaceRepositoryResourceRecord): unknown {
  const validation = record.validation ?? validateRepositoryPath(record.localPath);

  return WorkspaceRepositoryResourceSchema.parse({
    workspaceId: record.workspaceId,
    resourceId: record.resourceId,
    type: record.type,
    displayName: safeWorkspaceRepositoryDisplayName(record, validation),
    diagnosticsStatus: validation.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    pathSummary: validation.pathSummary,
    git: record.git,
    validation,
  });
}

/**
 * Resolves host-side Git push credentials through the repository's vault grant.
 *
 * @param input Repository, storage, capability, and vault context.
 * @returns Scrubbed credential env for the GitHub V1 adapter.
 */
function resolveGitPushCredentialEnv(input: {
  readonly actorId: string;
  readonly authority: RepoPushCallerAuthority;
  readonly capabilityCallId: string;
  readonly coreDb: CoreDb | undefined;
  readonly repository: WorkspaceRepositoryResourceRecord;
  readonly vaultBackend: (() => VaultBackend) | undefined;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
}): NodeJS.ProcessEnv | null {
  const grantId = input.repository.git.vaultGrantRef;

  if (!grantId) {
    throw new Error('Git push requires a repository-bound vault grant.');
  }
  if (!input.coreDb) {
    throw new Error('Git push vault credential resolution is unavailable.');
  }

  const grant = getVaultGrant(input.coreDb, grantId);
  const reference = grant ? getVaultReference(input.coreDb, grant.vaultReferenceId) : null;
  if (!grant || !reference) {
    return null;
  }
  const ownerAuthority =
    grant.ownerScope === reference.ownerScope &&
    grant.workspaceId === reference.workspaceId &&
    grant.userId === reference.userId &&
    ((grant.ownerScope === 'server' && grant.workspaceId === null && grant.userId === null) ||
      (grant.ownerScope === 'workspace' &&
        grant.workspaceId === input.workspaceId &&
        grant.userId === null) ||
      (grant.ownerScope === 'user' &&
        grant.workspaceId === null &&
        grant.userId === input.actorId));
  const activeTargetGrant =
    isTargetIssuedEffectAuthority(grant.grantId) &&
    grant.vaultReferenceId === reference.referenceId &&
    ownerAuthority &&
    grant.status === 'active' &&
    (grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.now()) &&
    grant.allowedInjectionPaths.includes('gateway-only') &&
    reference.status === 'active' &&
    grant.targetAgentId === null &&
    grant.targetAgentSessionId === null &&
    (grant.targetCapabilityId === null || grant.targetCapabilityId === 'workspace.git.push') &&
    (grant.approvalId === null ||
      (isTargetIssuedEffectAuthority(grant.approvalId) && grant.policyDecisionId !== null));
  if (
    !currentRepoPushCallerAuthority(
      input.coreDb,
      input.workspaceId,
      input.actorId,
      input.authority,
      'vault.use',
      activeTargetGrant
    )
  ) {
    return null;
  }
  if (!input.vaultBackend) {
    throw new Error('Git push vault credential resolution is unavailable.');
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const planId = `plan_git_push_${id}`;
  const receiptId = `receipt_git_push_${id}`;

  createVaultInjectionPlan(input.coreDb, {
    backendCapabilityRequirement: 'git-push:github-token',
    capabilityId: 'workspace.git.push',
    expirationBehavior: grant.expiresAt ? `expires-at:${grant.expiresAt}` : 'grant-lifetime',
    grantId,
    injectionVisibility: 'gateway-only',
    packageSnapshotId: 'nanocore-host',
    planId,
    redactionRule: 'no-secret-material',
    revocationBehavior: 'host-process-only',
    now: () => now,
  });
  createVaultInjectionReceipt(input.coreDb, {
    agentSessionId: null,
    backendSummary: 'git-push:github-token',
    capabilityCallId: input.capabilityCallId,
    expiresAt: grant.expiresAt,
    grantId,
    injectedAt: now,
    planId,
    receiptId,
    revocationStatus: 'active',
  });

  const token = vaultSecretMaterialToString(
    createVaultUseAuditedBackend({
      backend: input.vaultBackend(),
      capabilityCallId: input.capabilityCallId,
      db: input.workspaceDb,
      grantId,
      ownerScope: 'workspace',
      planId,
      receiptId,
      resolvingPath: 'grant',
      workspaceId: input.workspaceId,
      now: () => now,
    }).resolve({ referenceId: grant.vaultReferenceId })
  );

  return { GITHUB_TOKEN: token };
}

/**
 * Converts repository route failures into stable App API errors.
 *
 * @param error Route failure.
 * @returns Protocol-stamped API error response.
 */
function asRepositoryApiError(error: unknown): Response {
  const message = (error as Error).message;

  if (error instanceof TurnStartValidationError) {
    return asApiError(error.message, error.code, error.status);
  }

  if (message === 'Repository storage is unavailable for this NanoCore instance.') {
    return asApiError(message, 'repository_storage_unavailable', 503);
  }

  if (message.startsWith('Workspace not found:')) {
    return asApiError(message, 'workspace_not_found', 404);
  }

  return asApiError(message, 'repository_resource_failed', 400);
}

/** Reads the immutable decision issued by a push request in either approval mode. */
function readGitPushRequestDecision(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  approvalId: string
) {
  return (
    readPolicyApprovalDecision(workspaceDb, workspaceId, approvalId, 'repo.push') ??
    readPolicyApprovalDecision(workspaceDb, workspaceId, approvalId, 'repo.push', 'allow')
  );
}

/** Exact worker call evidence attached to the original repo.push request, never execution authority. */
export interface RepositoryPushWorkerRequest {
  /** Original selected Agent. */
  readonly agentId: string;
  /** Original AgentSession. */
  readonly agentSessionId: string;
  /** Original immutable environment package. */
  readonly packageSnapshotId: string;
  /** Denied MCP call which owns a human Gate stop. */
  readonly capabilityCallId: string;
}

/** Concrete dependencies shared by App and selected Worker repository commands. */
export interface RepositoryPushContext {
  /** Fresh authenticated responsible user. */
  readonly actorId: string;
  /** Fresh HTTP actor or exact authenticated Worker package lineage. */
  readonly authority: RepoPushCallerAuthority;
  /** Deployment-owned push approval mode. */
  readonly approvalPolicy: OpenKitConfig['policy'];
  /** Current canonical authority. */
  readonly coreDb: CoreDb | undefined;
  /** Existing command duplicate-collapse owner. */
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Already scoped host repository. */
  readonly repository: WorkspaceRepositoryResourceRecord;
  /** Canonical product store. */
  readonly store: FsStore;
  /** Host-only credential resolver. */
  readonly vaultBackend: (() => VaultBackend) | undefined;
  /** Workspace storage. */
  readonly workspaceDb: WorkspaceDb;
  /** Authenticated Workspace. */
  readonly workspaceId: string;
}

/**
 * Requests one exact host push grant through the shared command and policy owners.
 * @param context Authenticated caller and repository dependencies.
 * @param input Exact requested host commit and original Turn.
 * @param worker Optional immutable worker request evidence.
 * @returns Original target-issued Approval, Item and permission identifiers.
 */
export async function requestRepositoryPushApproval(
  context: RepositoryPushContext,
  input: z.infer<typeof RequestGitPushApprovalRequestSchema>,
  worker?: RepositoryPushWorkerRequest
): Promise<z.infer<typeof RequestGitPushApprovalResponseSchema>> {
  const { actorId, approvalPolicy, inflightCommands, repository, store, workspaceDb, workspaceId } =
    context;
  const resourceId = repository.resourceId;
  const commandScope = {
    actorId,
    workspaceId,
    repositoryResourceId: resourceId,
    threadId: input.threadId,
    turnId: input.turnId,
  };
  const ownerDigest = commandInputHash({
    command: 'git_push.approval.request',
    ...commandScope,
    requestId: input.requestId,
  }).slice('sha256:'.length);
  const owner = {
    decisionId: `pd_repo_push_${ownerDigest}`,
    approvalId: `ap_repo_push_${ownerDigest}`,
    approvalItemId: `it_repo_push_${ownerDigest}`,
  };
  let response: z.infer<typeof RequestGitPushApprovalResponseSchema>;
  try {
    response = await runIdempotentCommand({
      store,
      inflightCommands,
      command: 'git_push.approval.request',
      requestId: input.requestId,
      scope: commandScope,
      input,
      responseKind: 'approval',
      execute: () => {
        if (readGitPushRequestDecision(workspaceDb, workspaceId, owner.approvalId)) {
          throw new TurnStartValidationError(
            'recovery_required',
            'The Git push approval exists without its command receipt.',
            409
          );
        }
        let gateTurnId = input.turnId;
        if (!worker) {
          let sourceTurn: ReturnType<FsStore['getTurn']>;
          try {
            sourceTurn = store.getTurn(workspaceId, input.threadId, input.turnId);
          } catch (error) {
            if (error instanceof Error && error.message === `Turn not found: ${input.turnId}`) {
              throw new TurnStartValidationError('not_found', 'Thread not found.', 404);
            }
            throw error;
          }
          if (isSealedTurnTerminal(sourceTurn.status)) {
            const publicationTurnId = `tu_repo_push_${ownerDigest}`;
            if (
              store
                .listThreadTurns(workspaceId, input.threadId)
                .some((turn) => turn.id !== publicationTurnId && !isSealedTurnTerminal(turn.status))
            ) {
              throw new TurnStartValidationError(
                'thread_busy',
                'The Thread already has a non-terminal Turn.',
                409
              );
            }
            gateTurnId = publicationTurnId;
          }
        }
        let inspection: ReturnType<typeof inspectGitPushRepository>;
        try {
          inspection = inspectGitPushRepository(repository.localPath, input.sourceRef);
        } catch (error) {
          if (!worker || !(error instanceof GitPushSourceUnavailableError)) throw error;
          throw new TurnStartValidationError(
            'git_push_source_unavailable',
            'The source ref must exist in the linked NanoCore repository. Collect worker changes through Workspace review/apply, then request approval for the resulting host commit.',
            409
          );
        }

        if (inspection.sourceCommit !== input.commitIds.at(-1)) {
          throw new TurnStartValidationError(
            'git_push_source_unavailable',
            'The requested tip must match the linked NanoCore repository source ref. Use Workspace review/apply before requesting publication.',
            409
          );
        }

        if (!worker && gateTurnId !== input.turnId) {
          try {
            store.getTurnById(gateTurnId);
            throw new TurnStartValidationError(
              'recovery_required',
              'The Git push approval exists without its command receipt.',
              409
            );
          } catch (error) {
            if (error instanceof TurnStartValidationError) throw error;
            if (!(error instanceof Error && error.message === `Turn not found: ${gateTurnId}`)) {
              throw error;
            }
          }
          store.createTurn(
            workspaceId,
            input.threadId,
            `Approve Git push to ${input.targetBranch}`,
            { kind: 'user', id: actorId },
            null,
            { turnId: gateTurnId }
          );
        }

        const gate = createPolicyApprovalGate({
          action: 'repo.push',
          autoAllowTurn: worker ? 'continue' : 'complete',
          mode:
            approvalPolicy?.workspaceApprovalModes?.[workspaceId]?.['repo.push'] ??
            'require_human_approval',
          workspaceDb,
          store,
          workspaceId,
          turnId: gateTurnId,
          ...owner,
          reasonCode: 'repo_push_requires_human_approval',
          title: `Approve Git push to ${input.targetBranch}`,
          description: `Publish ${input.commitIds.join(', ')} from ${input.sourceRef} to ${input.targetBranch} on ${inspection.remoteSummary}.`,
          subjectSummary: { kind: 'user', userId: actorId },
          resourceSummary: {
            kind: 'git-push-target',
            workspaceId,
            repositoryResourceId: resourceId,
            remoteIdentity: inspection.remoteIdentity,
            remoteName: inspection.remoteName,
            sourceRef: input.sourceRef,
            sourceCommit: inspection.sourceCommit,
            targetBranch: input.targetBranch,
            commitIds: input.commitIds,
            remoteSummary: inspection.remoteSummary,
          },
          contextSummary: {
            requestId: input.requestId,
            commandTurnId: input.turnId,
            ...(worker ? { worker } : {}),
            workspaceId,
            threadId: input.threadId,
            turnId: gateTurnId,
          },
        });
        const approval = store.getApproval(gate.approvalId);

        return RequestGitPushApprovalResponseSchema.parse({
          approval,
          approvalItemId: gate.approvalItemId,
          policyDecisionId: gate.decisionId,
        });
      },
      replay: (record) => {
        const approval = store.getApproval(record.response.id);
        if (approval.workspaceId !== workspaceId)
          throw new Error('Git push approval scope mismatch.');
        const decision = readGitPushRequestDecision(workspaceDb, workspaceId, owner.approvalId);
        const approvalItem = store
          .listThreadItems(workspaceId, input.threadId)
          .find((item) => item.id === owner.approvalItemId);

        if (
          approval.id !== owner.approvalId ||
          decision?.decisionId !== owner.decisionId ||
          approvalItem?.type !== 'approval-request' ||
          approvalItem.approvalRequestId !== owner.approvalId
        ) {
          throw new TurnStartValidationError(
            'recovery_required',
            'The Git push approval receipt has no exact durable owner.',
            409
          );
        }

        return RequestGitPushApprovalResponseSchema.parse({
          approval,
          approvalItemId: approvalItem.id,
          policyDecisionId: decision.decisionId,
        });
      },
      responseId: (result) => result.approval.id,
    });
  } catch (error) {
    const receipt = store.getCommandRequest(
      'git_push.approval.request',
      input.requestId,
      commandScope
    );
    const durableOwner = readGitPushRequestDecision(workspaceDb, workspaceId, owner.approvalId);

    if (!receipt && durableOwner) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The Git push approval exists without its command receipt.',
        409
      );
    }
    throw error;
  }
  return response;
}

/**
 * Executes one original grant under the current request or Worker caller without rewriting its lineage.
 * @param context Authenticated caller and repository dependencies.
 * @param input Existing approval identifier and fresh execution request identifier.
 * @returns Durable push outcome.
 */
export async function executeRepositoryPush(
  context: RepositoryPushContext,
  input: z.infer<typeof ExecuteGitPushRequestSchema>
): Promise<GitPushRecord> {
  const {
    actorId,
    authority,
    coreDb,
    inflightCommands,
    repository,
    store,
    vaultBackend,
    workspaceDb,
    workspaceId,
  } = context;
  const resourceId = repository.resourceId;
  let approval: ReturnType<FsStore['getApproval']>;
  try {
    approval = store.getApproval(input.approvalRequestId);
  } catch {
    throw new TurnStartValidationError('not_found', 'Thread not found.', 404);
  }
  if (
    approval.workspaceId !== workspaceId ||
    !isThreadIdVisible(store, workspaceId, approval.threadId, actorId)
  ) {
    throw new TurnStartValidationError('not_found', 'Thread not found.', 404);
  }
  const response = await runIdempotentCommand({
    store,
    inflightCommands,
    command: 'git_push.execute',
    requestId: input.requestId,
    scope: {
      actorId,
      workspaceId,
      repositoryResourceId: resourceId,
    },
    input: { approvalRequestId: input.approvalRequestId },
    responseKind: 'git_push_record',
    execute: () => {
      if (approval.workspaceId !== workspaceId || approval.status !== 'granted') {
        throw new Error(`Git push approval is not granted: ${input.approvalRequestId}`);
      }

      const approvalItem = store
        .listAllItems()
        .find(
          (item) =>
            item.workspaceId === workspaceId &&
            item.type === 'approval-request' &&
            item.approvalRequestId === input.approvalRequestId
        );

      if (!approvalItem) {
        throw new Error(`Git push approval row not found: ${input.approvalRequestId}`);
      }

      const existingRecord = getGitPushRecordByApprovalRowId(
        workspaceDb,
        workspaceId,
        approvalItem.id
      );

      if (existingRecord) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The Git push attempt exists without its command receipt.',
          409
        );
      }

      const interruptedCall = listWorkspaceCapabilityCalls(workspaceDb, workspaceId).some(
        (call) =>
          call.itemId === approvalItem.id &&
          call.capabilityId === 'workspace.git.push' &&
          call.family === 'network' &&
          call.operation === 'git.push'
      );

      if (interruptedCall) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The Git push outcome cannot be proven from local records.',
          409
        );
      }

      const policyDecision = RepoPushApprovalDecisionSchema.parse(
        readPolicyApprovalDecision(
          workspaceDb,
          workspaceId,
          input.approvalRequestId,
          'repo.push',
          'allow'
        )
      );
      const intent = policyDecision.resourceSummary;
      if (
        policyDecision.reasonCode === 'repo_push_auto_allowed' ||
        policyDecision.contextSummary.worker
      ) {
        const originalRequest = RepoPushApprovalDecisionSchema.parse(
          readGitPushRequestDecision(workspaceDb, workspaceId, input.approvalRequestId)
        );
        const receipt = store.getCommandRequest(
          'git_push.approval.request',
          originalRequest.contextSummary.requestId,
          {
            actorId: originalRequest.subjectSummary.userId,
            workspaceId,
            repositoryResourceId: resourceId,
            threadId: approval.threadId,
            turnId: originalRequest.contextSummary.commandTurnId,
          }
        );
        if (receipt?.response.kind !== 'approval' || receipt.response.id !== approval.id) {
          throw new TurnStartValidationError(
            'recovery_required',
            'The Git push grant has no exact command receipt.',
            409
          );
        }
      }
      const inspection = inspectGitPushRepository(repository.localPath, intent.sourceRef);

      if (
        policyDecision.contextSummary.workspaceId !== workspaceId ||
        policyDecision.contextSummary.threadId !== approval.threadId ||
        policyDecision.contextSummary.turnId !== approval.turnId ||
        intent.workspaceId !== workspaceId ||
        intent.repositoryResourceId !== resourceId ||
        intent.remoteIdentity !== inspection.remoteIdentity ||
        intent.remoteName !== inspection.remoteName ||
        intent.remoteSummary !== inspection.remoteSummary ||
        intent.sourceCommit !== inspection.sourceCommit ||
        intent.commitIds.at(-1) !== intent.sourceCommit
      ) {
        throw new Error(`Git push approval scope mismatch: ${input.approvalRequestId}`);
      }

      return executeGitPushAttempt(workspaceDb, {
        attempt: {
          actorId,
          approvalNamesProtectedTarget: true,
          approvalRowId: approvalItem.id,
          commitIds: intent.commitIds,
          git: repository.git,
          hostSessionLinkageExemption: policyDecision.contextSummary.worker === undefined,
          policyDecisionId: policyDecision.decisionId,
          recordId: `gpr_${randomUUID()}`,
          remoteSummary: intent.remoteSummary,
          repositoryResourceId: resourceId,
          requestId: input.requestId,
          sourceRef: intent.sourceRef,
          targetBranch: intent.targetBranch,
          workspaceId,
        },
        authority,
        coreDb,
        objectDirectory: inspection.objectDirectory,
        objectFormat: inspection.objectFormat,
        provider: inspection.provider,
        remoteName: inspection.pushTarget,
        resolveEnv: (capabilityCallId) =>
          resolveGitPushCredentialEnv({
            actorId,
            authority,
            capabilityCallId,
            coreDb,
            repository,
            vaultBackend,
            workspaceDb,
            workspaceId,
          }),
        runner: runGitPushCommand,
        sourceCommit: inspection.sourceCommit,
      });
    },
    replay: (record) => {
      const pushRecord = getGitPushRecord(workspaceDb, workspaceId, record.response.id);
      if (pushRecord?.workspaceId !== workspaceId)
        throw new Error('Git push record scope mismatch.');

      if (!pushRecord) {
        throw new Error(`Git push record not found: ${record.response.id}`);
      }

      return pushRecord;
    },
    responseId: (result) => result.id,
  });
  return response;
}

import { WorkspaceResourcePolicyChangeSchema as ResourcePolicyChangeSchema } from '@openkit/app-api-schemas';

export { WorkspaceResourcePolicyChangeSchema as ResourcePolicyChangeSchema } from '@openkit/app-api-schemas';

import { WORKSPACE_RESOURCE_POLICY_FEATURE, WorkspaceConfigSchema } from '@openkit/config-schema';
import {
  AccessTokenIdSchema,
  AgentSessionIdSchema,
  responsibleUserIdForActor,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import {
  authorizeWorkspace,
  currentWorkerLineageWorkspaceAuthority,
  requireCurrentDeploymentAdmin,
} from '../auth/operation-authorizer.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import type { FsStore } from '../lib/store.js';
import {
  raiseRecordedPendingRequest,
  requireUsableRecord,
} from '../runtime/pending-request-flow.js';
import {
  claimCommandIntentGrant,
  finishPendingExecution,
  PendingRequestCommandError,
  type PendingRequestRecord,
  preflightPendingRequest,
  type RaisePendingRequestInput,
} from '../runtime/pending-requests.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { resolveWorkspaceMembershipRelation } from '../workspace-membership.js';

/** Captured non-secret credential or Worker lineage, rechecked by its existing current authority owners. */
export const ResourcePolicyRequestOriginSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('public'),
      actor: z
        .object({
          userId: UserIdSchema,
          kind: z.enum(['local', 'session', 'token']),
          tokenId: AccessTokenIdSchema.optional(),
          tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
          tokenWorkspaceIds: z.array(WorkspaceIdSchema).optional(),
          adminTokenId: AccessTokenIdSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('worker'),
      lineage: z
        .object({
          workspaceId: WorkspaceIdSchema,
          threadId: ThreadIdSchema,
          turnId: TurnIdSchema,
          agentSessionId: AgentSessionIdSchema,
          packageSnapshotId: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);

const IntentSchema = z
  .object({
    operation: z.literal('workspace.resource-access-change'),
    origin: ResourcePolicyRequestOriginSchema,
    change: ResourcePolicyChangeSchema,
  })
  .strict();

/** Reuses the current configuration and Pending Request owners, without a grant store or runner. */
export interface ResourcePolicyRequestDependencies {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceDb: Pick<WorkspaceDb, 'sqlite'>;
  readonly manager: RuntimeConfigManager;
  readonly files: RuntimeConfigFileService;
  /** The existing requester/Worker authority owner must confirm the captured current responsibility. */
  readonly requesterAuthority: (record: PendingRequestRecord) => boolean | undefined;
}

/** Selects only this governed intent; other requests retain their existing command owners. */
export function isResourcePolicyRequest(record: PendingRequestRecord): boolean {
  return (
    record.kind === 'approval' &&
    record.serverId === null &&
    record.governedIntent?.operation === 'workspace.resource-access-change'
  );
}

/** Captures caller-selected terms without resolving the requested resource or disclosing its metadata. */
export function raiseResourcePolicyRequest(
  dependencies: Pick<ResourcePolicyRequestDependencies, 'store' | 'workspaceDb'>,
  input: Omit<RaisePendingRequestInput, 'kind' | 'approval' | 'governedIntent' | 'call'>,
  change: z.input<typeof ResourcePolicyChangeSchema>,
  origin: z.input<typeof ResourcePolicyRequestOriginSchema>
): PendingRequestRecord {
  const raisedInput: RaisePendingRequestInput = {
    ...input,
    kind: 'approval',
    governedIntent: IntentSchema.parse({
      operation: 'workspace.resource-access-change',
      change,
      origin,
    }),
    approval: {
      kind: 'permission',
      title: 'Workspace resource access change',
      description:
        'Review the captured family, resource, target rights and configuration revision. Approval alone changes no assignment.',
    },
  };
  const prior = preflightPendingRequest(dependencies.workspaceDb.sqlite, raisedInput);
  if (prior) {
    // Existing partial lineage is inspect-only; retry must not reconstruct its missing counterpart.
    return requireUsableRecord(
      dependencies.store,
      dependencies.workspaceDb.sqlite,
      prior.requestId,
      prior.workspaceId,
      prior.threadId
    );
  }
  const record = raiseRecordedPendingRequest(
    dependencies.store,
    dependencies.workspaceDb.sqlite,
    raisedInput
  );
  dependencies.store.createItem({
    id: record.requestItemId,
    workspaceId: record.workspaceId,
    threadId: record.threadId,
    turnId: record.raisingTurnId,
    type: 'approval-request',
    approvalRequestId: record.requestId,
    kind: 'permission',
    status: 'completed',
    title: record.title ?? '',
    description: record.description ?? '',
    createdAt: record.createdAt,
    completedAt: record.createdAt,
  });
  return record;
}

/** Rechecks the original credential or trusted Worker responsibility without replaying its original Turn. */
export function isResourcePolicyRequesterCurrent(
  dependencies: Pick<ResourcePolicyRequestDependencies, 'coreDb' | 'store' | 'manager'>,
  record: PendingRequestRecord
): boolean {
  if (!isResourcePolicyRequest(record)) return false;
  try {
    const { origin } = IntentSchema.parse(record.governedIntent);
    if (origin.kind === 'public') {
      const actor: Actor = {
        kind: origin.actor.kind,
        userId: origin.actor.userId,
        ...(origin.actor.tokenId ? { tokenId: origin.actor.tokenId } : {}),
        ...(origin.actor.tokenScope ? { tokenScope: origin.actor.tokenScope } : {}),
        ...(origin.actor.tokenWorkspaceIds
          ? { tokenWorkspaceIds: origin.actor.tokenWorkspaceIds }
          : {}),
        ...(origin.actor.adminTokenId ? { adminTokenId: origin.actor.adminTokenId } : {}),
      };
      return (
        actor.userId === record.responsibleUserId &&
        authorizeWorkspace(dependencies.coreDb, actor, record.workspaceId, {
          policyOperation: 'workspace.read',
          mutating: false,
        }) !== null
      );
    }
    const turn = dependencies.store.getTurnById(origin.lineage.turnId);
    return (
      turn.workspaceId === record.workspaceId &&
      turn.threadId === record.threadId &&
      turn.id === record.raisingTurnId &&
      turn.agentId === record.agentId &&
      turn.agentSessionId === record.agentSessionId &&
      turn.agentSessionId === origin.lineage.agentSessionId &&
      responsibleUserIdForActor(turn.triggerActor) === record.responsibleUserId &&
      dependencies.manager.current().agentManifests.some((agent) => agent.id === turn.agentId) &&
      currentWorkerLineageWorkspaceAuthority(
        dependencies.coreDb,
        { ...origin.lineage, triggerActor: turn.triggerActor },
        'workspace.read',
        true
      ) !== null
    );
  } catch {
    return false;
  }
}

/** Rechecks current Workspace Policy administration, requester responsibility and canonical target facts. */
export function checkResourcePolicyCommandIntent(
  dependencies: ResourcePolicyRequestDependencies,
  record: PendingRequestRecord,
  actor: Actor
): void {
  if (!isResourcePolicyRequest(record)) return;
  if (actor.kind === 'session' && actor.adminTokenId) {
    try {
      if (requireCurrentDeploymentAdmin(dependencies.coreDb, actor).tokenId !== actor.adminTokenId)
        throw new Error('Administrator credential changed.');
    } catch {
      throw new PendingRequestCommandError(
        'workspace_access_denied',
        'The deciding credential is no longer current.',
        403
      );
    }
  }
  if (
    !authorizeWorkspace(dependencies.coreDb, actor, record.workspaceId, {
      policyOperation: 'workspace.configure',
      mutating: true,
    }) ||
    !(
      dependencies.requesterAuthority(record) ??
      isResourcePolicyRequesterCurrent(dependencies, record)
    )
  ) {
    throw new PendingRequestCommandError(
      'workspace_access_denied',
      'Current Workspace Policy authority is required.',
      403
    );
  }
  const { change } = IntentSchema.parse(record.governedIntent);
  let thread: ReturnType<FsStore['getThread']>;
  try {
    thread = dependencies.store.getThread(record.workspaceId, change.resource.id);
  } catch {
    throw new PendingRequestCommandError(
      'workspace_access_denied',
      'The requested resource is unavailable.',
      403
    );
  }
  if (thread.visibility !== 'workspace' || thread.workspaceId !== record.workspaceId) {
    throw new PendingRequestCommandError(
      'workspace_access_denied',
      'The requested resource is unavailable.',
      403
    );
  }
  for (const allocation of [
    ...(change.replacement?.grants ?? []),
    ...(change.replacement?.prohibitions ?? []),
  ]) {
    const subject = allocation.subject;
    if (
      !resolveWorkspaceMembershipRelation(
        dependencies.coreDb,
        record.workspaceId,
        subject.userId
      ) ||
      (subject.kind === 'agent' &&
        !dependencies.manager
          .current()
          .agentManifests.some((manifest) => manifest.id === subject.agentId))
    ) {
      throw new PendingRequestCommandError(
        'workspace_access_denied',
        'A current allocation target is unavailable.',
        403
      );
    }
  }
  const file = dependencies.files.readFile(`workspaces/${record.workspaceId}/workspace.jsonc`);
  if (file.file.revision !== change.expectedRevision) {
    throw new PendingRequestCommandError(
      'config_revision_conflict',
      'Workspace configuration changed.',
      409
    );
  }
}

/** Applies one unused approved intent under distinct current confirmation through the sole CAS writer. */
export function applyResourcePolicyRequest(
  dependencies: ResourcePolicyRequestDependencies,
  input: {
    readonly requestId: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly actor: Actor;
    readonly confirmation: string;
  }
) {
  const record = requireUsableRecord(
    dependencies.store,
    dependencies.workspaceDb.sqlite,
    input.requestId,
    input.workspaceId,
    input.threadId
  );
  if (
    !isResourcePolicyRequest(record) ||
    input.confirmation !== 'APPLY WORKSPACE RESOURCE POLICY' ||
    record.state !== 'resolved' ||
    record.resolution !== 'granted' ||
    record.claim !== 'unclaimed' ||
    !record.decidingActorContext
  ) {
    throw new PendingRequestCommandError(
      'resource_policy_confirmation_required',
      'An unused approval and distinct confirmation are required.',
      409
    );
  }
  checkResourcePolicyCommandIntent(dependencies, record, input.actor);
  checkResourcePolicyCommandIntent(dependencies, record, record.decidingActorContext);
  const { change } = IntentSchema.parse(record.governedIntent);
  const id = `workspaces/${record.workspaceId}/workspace.jsonc`;
  const file = dependencies.files.readFile(id);
  const config = WorkspaceConfigSchema.parse(parse(file.content));
  const entries = (config.workspace.policy?.resourceAccess ?? []).filter(
    (entry) =>
      entry.resource.family !== change.resource.family || entry.resource.id !== change.resource.id
  );
  if (change.replacement) entries.push(change.replacement);
  let content = applyEdits(
    file.content,
    modify(file.content, ['workspace', 'policy', 'resourceAccess'], entries, {})
  );
  const requiredFeatures = [
    ...new Set([...(config.requiredFeatures ?? []), WORKSPACE_RESOURCE_POLICY_FEATURE]),
  ];
  content = applyEdits(content, modify(content, ['requiredFeatures'], requiredFeatures, {}));
  WorkspaceConfigSchema.parse(parse(content));
  if (
    !claimCommandIntentGrant(
      dependencies.workspaceDb.sqlite,
      record.requestId,
      new Date().toISOString()
    )
  ) {
    throw new PendingRequestCommandError(
      'request_not_pending',
      'This approved change is no longer unused.',
      409
    );
  }
  try {
    const saved = dependencies.files.updateFile({
      id,
      kind: 'workspace',
      content,
      expectedRevision: change.expectedRevision,
    });
    const reload = dependencies.manager.reload({ dryRun: false, mode: 'safe' });
    const result = { saved, reload };
    finishPendingExecution(
      dependencies.workspaceDb.sqlite,
      record.requestId,
      'approved-executed',
      null,
      result,
      new Date().toISOString()
    );
    return result;
  } catch (error) {
    // Configuration storage and loaded state are separate; inspect them instead of replaying an uncertain write.
    finishPendingExecution(
      dependencies.workspaceDb.sqlite,
      record.requestId,
      'outcome-unknown',
      'Inspect saved and effective Workspace configuration before retry.',
      null,
      new Date().toISOString()
    );
    throw error;
  }
}

import {
  WORKSPACE_RESOURCE_POLICY_FEATURE,
  WorkspaceConfigSchema,
  WorkspacePolicyResourceSchema,
  WorkspaceResourceAccessEntrySchema,
} from '@openkit/config-schema';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { authorizeWorkspace } from '../auth/operation-authorizer.js';
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

/** Exact replacement of one managed boundary; null explicitly removes that boundary. */
export const ResourcePolicyChangeSchema = z
  .object({
    resource: WorkspacePolicyResourceSchema,
    replacement: WorkspaceResourceAccessEntrySchema.nullable(),
    expectedRevision: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.replacement &&
      (value.resource.family !== value.replacement.resource.family ||
        value.resource.id !== value.replacement.resource.id)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['replacement', 'resource'],
        message: 'The replacement must identify the captured resource.',
      });
    }
  });
const IntentSchema = z
  .object({
    operation: z.literal('workspace.resource-access-change'),
    change: ResourcePolicyChangeSchema,
  })
  .strict();

/** Reuses the current configuration and Pending Request owners, without a grant store or runner. */
export interface ResourcePolicyRequestDependencies {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
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
  change: z.input<typeof ResourcePolicyChangeSchema>
): PendingRequestRecord {
  const raisedInput: RaisePendingRequestInput = {
    ...input,
    kind: 'approval',
    governedIntent: IntentSchema.parse({ operation: 'workspace.resource-access-change', change }),
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

/** Rechecks current Workspace Policy administration, requester responsibility and canonical target facts. */
export function checkResourcePolicyCommandIntent(
  dependencies: ResourcePolicyRequestDependencies,
  record: PendingRequestRecord,
  actor: Actor
): void {
  if (!isResourcePolicyRequest(record)) return;
  if (
    !authorizeWorkspace(dependencies.coreDb, actor, record.workspaceId, {
      policyOperation: 'workspace.configure',
      mutating: true,
    }) ||
    dependencies.requesterAuthority(record) !== true
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

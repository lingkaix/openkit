import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';

import type { CoreDb } from '../storage/db.js';

/** Fixed image-derived layout admitted for one retained Worker storage association. */
export interface WorkerStorageLayout {
  readonly family: string | null;
  readonly version: string | null;
  readonly uid: number;
  readonly gid: number;
  readonly workingDirectory: string;
  readonly platform: {
    readonly architecture: string;
    readonly os: string;
  };
  readonly targets: readonly { readonly target: string }[];
}

/** One target-to-volume identity retained by Core. */
export interface WorkerStorageTarget {
  /** Whether the current admitted image requests this retained target. */
  readonly active: boolean;
  readonly initialized: boolean;
  readonly target: string;
  readonly volumeRef: string;
}

/** Historical contributor whose current audience gates whole-volume reuse. */
export interface WorkerStorageContributor {
  readonly attachmentGeneration: number;
  readonly contributorRef: string;
  readonly createdAt: string;
  readonly goalId: string | null;
  readonly purpose: 'work' | 'independent-review';
  readonly responsibleUserId: string;
  readonly storageRef: string;
  readonly taskId: string | null;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly workSlotRef: string;
}

/** Private Core association and current attachment certainty. */
export interface WorkerStorageBinding {
  readonly attachmentGeneration: number;
  readonly contributors: readonly WorkerStorageContributor[];
  readonly createdAt: string;
  readonly currentAgentSessionId: string | null;
  readonly currentSandboxBindingRef: string | null;
  readonly currentThreadId: string | null;
  readonly currentWorkSlotRef: string | null;
  readonly deploymentId: string;
  readonly layout: WorkerStorageLayout;
  readonly layoutDigest: string;
  readonly purgedAt: string | null;
  readonly revision: number;
  readonly runtimeTargetId: string;
  readonly scopeDigest: string;
  readonly state: 'idle' | 'reserved' | 'attached' | 'unknown' | 'purge-pending' | 'purged';
  readonly storageRef: string;
  readonly targets: readonly WorkerStorageTarget[];
  readonly updatedAt: string;
  readonly workspaceId: string;
}

/** Current owner check for one historical or proposed contributor. */
export type AuthorizeWorkerStorageContributor = (contributor: WorkerStorageContributor) => boolean;

/** Stable typed refusal from the private storage owner. */
export class WorkerStorageBindingError extends Error {
  public constructor(
    public readonly code:
      | 'authorization_denied'
      | 'cross_workspace_forbidden'
      | 'independent_review_conflict'
      | 'layout_conflict'
      | 'not_found'
      | 'occupied'
      | 'purge_blocked'
      | 'revision_conflict'
      | 'storage_fenced',
    message: string
  ) {
    super(message);
    this.name = 'WorkerStorageBindingError';
  }
}

/** Input shared by explicit selection and attachment reservation. */
export interface WorkerStorageSelectionInput {
  readonly adjudicatedThreadIds?: readonly string[];
  readonly authorizeContributor: AuthorizeWorkerStorageContributor;
  readonly expectedRevision: number;
  readonly goalId?: string | null;
  readonly layout: WorkerStorageLayout;
  readonly purpose: 'work' | 'independent-review';
  readonly responsibleUserId: string;
  readonly storageRef: string;
  readonly taskId?: string | null;
  readonly threadId: string;
  readonly workspaceId: string;
}

interface WorkerStorageBindingRow {
  attachment_generation: number;
  created_at: string;
  current_agent_session_id: string | null;
  current_sandbox_binding_ref: string | null;
  current_thread_id: string | null;
  current_work_slot_ref: string | null;
  deployment_id: string;
  layout_digest: string;
  layout_family: string | null;
  layout_version: string | null;
  owner_gid: number;
  owner_uid: number;
  platform_architecture: string;
  platform_os: string;
  purged_at: string | null;
  revision: number;
  runtime_target_id: string;
  scope_digest: string;
  state: WorkerStorageBinding['state'];
  storage_ref: string;
  targets_json: string;
  updated_at: string;
  working_directory: string;
  workspace_id: string;
}

interface WorkerStorageContributorRow {
  attachment_generation: number;
  contributor_ref: string;
  created_at: string;
  goal_id: string | null;
  purpose: WorkerStorageContributor['purpose'];
  responsible_user_id: string;
  storage_ref: string;
  task_id: string | null;
  thread_id: string;
  workspace_id: string;
  work_slot_ref: string;
}

/** Creates one empty private association before its first host materialization. */
export function createWorkerStorageBinding(
  coreDb: CoreDb,
  input: {
    readonly deploymentId: string;
    readonly layout: WorkerStorageLayout;
    readonly now?: string;
    readonly runtimeTargetId: string;
    readonly workspaceId: string;
  }
): WorkerStorageBinding {
  const deploymentId = requireIdentity(input.deploymentId, 'deployment');
  const runtimeTargetId = requireIdentity(input.runtimeTargetId, 'RuntimeTarget');
  const workspaceId = requireIdentity(input.workspaceId, 'Workspace');
  const layout = normalizeWorkerStorageLayout(input.layout);
  const target = coreDb.sqlite
    .prepare('SELECT deployment_id FROM nanohost_runtime_targets WHERE target_id = ?')
    .get(runtimeTargetId) as { deployment_id: string } | undefined;
  if (!target || target.deployment_id !== deploymentId) {
    throw new WorkerStorageBindingError(
      'authorization_denied',
      'Worker storage RuntimeTarget is unavailable.'
    );
  }
  const storageRef = `wst_${randomUUID().replaceAll('-', '')}`;
  const now = input.now ?? new Date().toISOString();
  const targets: WorkerStorageTarget[] = layout.targets.map(({ target: targetPath }) => ({
    active: true,
    initialized: false,
    target: targetPath,
    volumeRef: opaqueRef('wsv', `${storageRef}\0${targetPath}`),
  }));
  coreDb.sqlite
    .prepare(
      `INSERT INTO worker_storage_bindings (
         storage_ref, runtime_target_id, deployment_id, workspace_id, scope_digest,
         layout_digest, layout_family, layout_version, platform_os, platform_architecture,
         owner_uid, owner_gid, working_directory, targets_json, revision,
         attachment_generation, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'idle', ?, ?)`
    )
    .run(
      storageRef,
      runtimeTargetId,
      deploymentId,
      workspaceId,
      workerStorageScopeDigest(workspaceId),
      workerStorageLayoutDigest(layout),
      layout.family,
      layout.version,
      layout.platform.os,
      layout.platform.architecture,
      layout.uid,
      layout.gid,
      layout.workingDirectory,
      JSON.stringify(targets),
      now,
      now
    );
  return requireWorkerStorageBinding(coreDb, storageRef);
}

/** Reads one exact private association without performing audience admission. */
export function getWorkerStorageBinding(
  coreDb: CoreDb,
  input: { readonly storageRef: string }
): WorkerStorageBinding | null {
  const storageRef = requireIdentity(input.storageRef, 'storage');
  const row = coreDb.sqlite
    .prepare('SELECT * FROM worker_storage_bindings WHERE storage_ref = ?')
    .get(storageRef) as WorkerStorageBindingRow | undefined;
  return row ? bindingFromRow(coreDb, row) : null;
}

/** Reads the sole association currently attached to one exact Sandbox binding. */
export function getWorkerStorageBindingForSandbox(
  coreDb: CoreDb,
  input: { readonly sandboxBindingRef: string }
): WorkerStorageBinding | null {
  const sandboxBindingRef = requireIdentity(input.sandboxBindingRef, 'Sandbox binding');
  const row = coreDb.sqlite
    .prepare('SELECT * FROM worker_storage_bindings WHERE current_sandbox_binding_ref = ?')
    .get(sandboxBindingRef) as WorkerStorageBindingRow | undefined;
  return row ? bindingFromRow(coreDb, row) : null;
}

/** Lists only Workspace associations whose complete contributor audience remains current. */
export function listWorkerStorageBindings(
  coreDb: CoreDb,
  input: {
    readonly authorizeContributor: AuthorizeWorkerStorageContributor;
    readonly workspaceId: string;
  }
): WorkerStorageBinding[] {
  const workspaceId = requireIdentity(input.workspaceId, 'Workspace');
  return (
    coreDb.sqlite
      .prepare(
        `SELECT * FROM worker_storage_bindings
         WHERE workspace_id = ? AND state <> 'purged'
         ORDER BY created_at, storage_ref`
      )
      .all(workspaceId) as WorkerStorageBindingRow[]
  )
    .map((row) => bindingFromRow(coreDb, row))
    .filter((binding) => binding.contributors.every(input.authorizeContributor));
}

/** Rechecks and returns one explicitly selected idle association. */
export function selectWorkerStorageBinding(
  coreDb: CoreDb,
  input: WorkerStorageSelectionInput
): WorkerStorageBinding {
  const binding = requireWorkerStorageBinding(coreDb, input.storageRef);
  assertSelectable(binding, input);
  return binding;
}

/** Authorizes one selected association before its exact attached Sandbox is replaced. */
export function authorizeAttachedWorkerStorageReplacement(
  coreDb: CoreDb,
  input: Omit<WorkerStorageSelectionInput, 'layout'> & {
    readonly reuseWorkSlotRef?: string;
    readonly sandboxBindingRef: string;
  }
): WorkerStorageBinding {
  const binding = requireWorkerStorageBinding(coreDb, input.storageRef);
  assertAdmission(binding, { ...input, layout: binding.layout });
  if (binding.revision !== input.expectedRevision) throw revisionConflict();
  if (
    binding.state !== 'attached' ||
    binding.currentSandboxBindingRef !== requireIdentity(input.sandboxBindingRef, 'Sandbox binding')
  ) {
    throw new WorkerStorageBindingError(
      'occupied',
      'Worker storage is not attached to the Sandbox being replaced.'
    );
  }
  resolveWorkerStorageWorkSlotRef(binding, input);
  return binding;
}

/** Reserves the sole attachment through one revision compare-and-set transaction. */
export function reserveWorkerStorageAttachment(
  coreDb: CoreDb,
  input: WorkerStorageSelectionInput & {
    readonly agentSessionId: string;
    readonly now?: string;
    readonly reuseWorkSlotRef?: string;
    readonly runtimeTargetId: string;
  }
): WorkerStorageBinding {
  const now = input.now ?? new Date().toISOString();
  const transaction = coreDb.sqlite.transaction(() => {
    const binding = selectWorkerStorageBinding(coreDb, input);
    if (binding.runtimeTargetId !== requireIdentity(input.runtimeTargetId, 'RuntimeTarget')) {
      throw new WorkerStorageBindingError(
        'layout_conflict',
        'Worker storage belongs to a different RuntimeTarget.'
      );
    }
    const generation = binding.attachmentGeneration + 1;
    const workSlotRef = resolveWorkerStorageWorkSlotRef(binding, input);
    const nextLayout = normalizeWorkerStorageLayout(input.layout);
    const nextTargets = mergeWorkerStorageTargets(binding.storageRef, binding.targets, nextLayout);
    const contributor: WorkerStorageContributor = {
      attachmentGeneration: generation,
      contributorRef: opaqueRef(
        'wsc',
        `${binding.storageRef}\0${generation}\0${input.responsibleUserId}\0${input.threadId}\0${input.goalId ?? ''}\0${input.taskId ?? ''}\0${input.purpose}`
      ),
      createdAt: now,
      goalId: input.goalId ?? null,
      purpose: input.purpose,
      responsibleUserId: requireIdentity(input.responsibleUserId, 'responsible user'),
      storageRef: binding.storageRef,
      taskId: input.taskId ?? null,
      threadId: requireIdentity(input.threadId, 'Thread'),
      workspaceId: binding.workspaceId,
      workSlotRef,
    };
    if (!input.authorizeContributor(contributor)) {
      throw new WorkerStorageBindingError(
        'authorization_denied',
        'Worker storage contributor is not currently authorized.'
      );
    }
    const changed = coreDb.sqlite
      .prepare(
        `UPDATE worker_storage_bindings
         SET revision = revision + 1, attachment_generation = ?, state = 'reserved',
             layout_digest = ?, layout_family = ?, layout_version = ?, platform_os = ?,
             platform_architecture = ?, owner_uid = ?, owner_gid = ?, working_directory = ?,
             targets_json = ?,
             current_agent_session_id = ?, current_thread_id = ?, current_work_slot_ref = ?,
             current_sandbox_binding_ref = NULL, updated_at = ?
         WHERE storage_ref = ? AND revision = ? AND state = 'idle'`
      )
      .run(
        generation,
        workerStorageLayoutDigest(nextLayout),
        nextLayout.family,
        nextLayout.version,
        nextLayout.platform.os,
        nextLayout.platform.architecture,
        nextLayout.uid,
        nextLayout.gid,
        nextLayout.workingDirectory,
        JSON.stringify(nextTargets),
        requireIdentity(input.agentSessionId, 'AgentSession'),
        contributor.threadId,
        workSlotRef,
        now,
        binding.storageRef,
        binding.revision
      );
    if (changed.changes !== 1) {
      throw new WorkerStorageBindingError(
        'revision_conflict',
        'Worker storage reservation changed concurrently.'
      );
    }
    insertContributor(coreDb, contributor);
  });
  transaction();
  return requireWorkerStorageBinding(coreDb, input.storageRef);
}

/** Adds one authorized contributor to an already attached shared Sandbox generation. */
export function admitWorkerStorageContributor(
  coreDb: CoreDb,
  input: WorkerStorageSelectionInput
): WorkerStorageBinding {
  const now = new Date().toISOString();
  const transaction = coreDb.sqlite.transaction(() => {
    const binding = requireWorkerStorageBinding(coreDb, input.storageRef);
    assertAdmission(binding, input);
    if (binding.layoutDigest !== workerStorageLayoutDigest(input.layout)) {
      throw new WorkerStorageBindingError(
        'layout_conflict',
        'Attached Worker storage cannot change its active target set.'
      );
    }
    if (binding.revision !== input.expectedRevision) throw revisionConflict();
    if (binding.state !== 'attached') {
      throw new WorkerStorageBindingError('occupied', 'Worker storage is not attached.');
    }
    const workSlotRef = resolveWorkerStorageWorkSlotRef(binding, input);
    const contributor: WorkerStorageContributor = {
      attachmentGeneration: binding.attachmentGeneration,
      contributorRef: opaqueRef(
        'wsc',
        `${binding.storageRef}\0${binding.attachmentGeneration}\0${input.responsibleUserId}\0${input.threadId}\0${input.goalId ?? ''}\0${input.taskId ?? ''}\0${input.purpose}`
      ),
      createdAt: now,
      goalId: input.goalId ?? null,
      purpose: input.purpose,
      responsibleUserId: requireIdentity(input.responsibleUserId, 'responsible user'),
      storageRef: binding.storageRef,
      taskId: input.taskId ?? null,
      threadId: requireIdentity(input.threadId, 'Thread'),
      workspaceId: binding.workspaceId,
      workSlotRef,
    };
    if (!input.authorizeContributor(contributor)) {
      throw new WorkerStorageBindingError(
        'authorization_denied',
        'Worker storage contributor is not currently authorized.'
      );
    }
    const existing = coreDb.sqlite
      .prepare('SELECT contributor_ref FROM worker_storage_contributors WHERE contributor_ref = ?')
      .get(contributor.contributorRef);
    if (existing) return;
    const changed = coreDb.sqlite
      .prepare(
        `UPDATE worker_storage_bindings SET revision = revision + 1, updated_at = ?
         WHERE storage_ref = ? AND revision = ? AND state = 'attached'`
      )
      .run(now, binding.storageRef, binding.revision);
    if (changed.changes !== 1) throw revisionConflict();
    insertContributor(coreDb, contributor);
  });
  transaction();
  return requireWorkerStorageBinding(coreDb, input.storageRef);
}

/** Records exact host attachment and per-target initialization proof. */
export function activateWorkerStorageAttachment(
  coreDb: CoreDb,
  input: {
    readonly attachmentGeneration: number;
    readonly expectedRevision: number;
    readonly now?: string;
    readonly sandboxBindingRef: string;
    readonly storageRef: string;
    readonly targets: readonly WorkerStorageTarget[];
  }
): WorkerStorageBinding {
  const binding = requireWorkerStorageBinding(coreDb, input.storageRef);
  assertExactAttachment(binding, input.expectedRevision, input.attachmentGeneration, 'reserved');
  const targets = normalizeStoredTargets(input.targets);
  const activeTargets = binding.targets.filter((target) => target.active);
  if (
    targets.some((target) => !target.initialized) ||
    JSON.stringify(targets.map(withoutInitialization)) !==
      JSON.stringify(activeTargets.map(withoutInitialization))
  ) {
    throw new WorkerStorageBindingError(
      'layout_conflict',
      'Worker storage target initialization does not match the admitted layout.'
    );
  }
  const initializedByTarget = new Map(targets.map((target) => [target.target, target]));
  const retainedTargets = binding.targets.map((target) => {
    const initialized = initializedByTarget.get(target.target);
    return initialized ? { ...target, initialized: initialized.initialized } : target;
  });
  const changed = coreDb.sqlite
    .prepare(
      `UPDATE worker_storage_bindings
       SET revision = revision + 1, state = 'attached', current_sandbox_binding_ref = ?,
           targets_json = ?, updated_at = ?
       WHERE storage_ref = ? AND revision = ? AND attachment_generation = ?
         AND state = 'reserved'`
    )
    .run(
      requireIdentity(input.sandboxBindingRef, 'Sandbox binding'),
      JSON.stringify(retainedTargets),
      input.now ?? new Date().toISOString(),
      binding.storageRef,
      binding.revision,
      binding.attachmentGeneration
    );
  if (changed.changes !== 1) throw revisionConflict();
  return requireWorkerStorageBinding(coreDb, input.storageRef);
}

/** Releases one exact reservation or attachment only after ordinary cleanup proof. */
export function releaseWorkerStorageAttachment(
  coreDb: CoreDb,
  input: {
    readonly attachmentGeneration: number;
    readonly cleanupProved: boolean;
    readonly expectedRevision: number;
    readonly now?: string;
    readonly sandboxBindingRef?: string | null;
    readonly storageRef: string;
  }
): WorkerStorageBinding {
  if (!input.cleanupProved) {
    throw new WorkerStorageBindingError('storage_fenced', 'Worker storage cleanup is not proved.');
  }
  const binding = requireWorkerStorageBinding(coreDb, input.storageRef);
  if (binding.state !== 'reserved' && binding.state !== 'attached' && binding.state !== 'unknown') {
    throw new WorkerStorageBindingError('storage_fenced', 'Worker storage is not releasable.');
  }
  assertExactAttachment(binding, input.expectedRevision, input.attachmentGeneration, binding.state);
  if (
    (binding.state === 'attached' || binding.state === 'unknown') &&
    binding.currentSandboxBindingRef !== (input.sandboxBindingRef ?? null)
  ) {
    throw new WorkerStorageBindingError(
      'storage_fenced',
      'Worker storage Sandbox cleanup proof does not match.'
    );
  }
  const changed = coreDb.sqlite
    .prepare(
      `UPDATE worker_storage_bindings
       SET revision = revision + 1, state = 'idle', current_agent_session_id = NULL,
           current_thread_id = NULL, current_work_slot_ref = NULL,
           current_sandbox_binding_ref = NULL, updated_at = ?
       WHERE storage_ref = ? AND revision = ? AND attachment_generation = ?
         AND state = ?`
    )
    .run(
      input.now ?? new Date().toISOString(),
      binding.storageRef,
      binding.revision,
      binding.attachmentGeneration,
      binding.state
    );
  if (changed.changes !== 1) throw revisionConflict();
  return requireWorkerStorageBinding(coreDb, input.storageRef);
}

/** Fences one association after an uncertain external attachment or detach result. */
export function markWorkerStorageAttachmentUnknown(
  coreDb: CoreDb,
  input: {
    readonly attachmentGeneration: number;
    readonly expectedRevision: number;
    readonly now?: string;
    readonly storageRef: string;
  }
): WorkerStorageBinding {
  const binding = requireWorkerStorageBinding(coreDb, input.storageRef);
  if (binding.state !== 'reserved' && binding.state !== 'attached') {
    throw new WorkerStorageBindingError('storage_fenced', 'Worker storage is not attachable.');
  }
  assertExactAttachment(binding, input.expectedRevision, input.attachmentGeneration, binding.state);
  const changed = coreDb.sqlite
    .prepare(
      `UPDATE worker_storage_bindings
       SET revision = revision + 1, state = 'unknown', updated_at = ?
       WHERE storage_ref = ? AND revision = ? AND attachment_generation = ?
         AND state = ?`
    )
    .run(
      input.now ?? new Date().toISOString(),
      binding.storageRef,
      binding.revision,
      binding.attachmentGeneration,
      binding.state
    );
  if (changed.changes !== 1) throw revisionConflict();
  return requireWorkerStorageBinding(coreDb, input.storageRef);
}

/** Reserves an idle unreferenced association for one explicit whole-ref purge. */
export function markWorkerStoragePurgePending(
  coreDb: CoreDb,
  input: {
    readonly authorizePurge: () => boolean;
    readonly expectedRevision: number;
    readonly hasSurvivingReferences: () => boolean;
    readonly now?: string;
    readonly storageRef: string;
  }
): WorkerStorageBinding {
  const binding = requireWorkerStorageBinding(coreDb, input.storageRef);
  if (!input.authorizePurge()) {
    throw new WorkerStorageBindingError(
      'authorization_denied',
      'Worker storage purge is not authorized.'
    );
  }
  if (binding.revision !== input.expectedRevision) throw revisionConflict();
  if (binding.state !== 'idle' || input.hasSurvivingReferences()) {
    throw new WorkerStorageBindingError(
      'purge_blocked',
      'Worker storage still has an attachment or surviving reference.'
    );
  }
  const changed = coreDb.sqlite
    .prepare(
      `UPDATE worker_storage_bindings
       SET revision = revision + 1, state = 'purge-pending', updated_at = ?
       WHERE storage_ref = ? AND revision = ? AND state = 'idle'`
    )
    .run(input.now ?? new Date().toISOString(), binding.storageRef, binding.revision);
  if (changed.changes !== 1) throw revisionConflict();
  return requireWorkerStorageBinding(coreDb, input.storageRef);
}

/** Settles one exact purge result without widening an uncertain result to success. */
export function settleWorkerStoragePurge(
  coreDb: CoreDb,
  input: {
    readonly expectedRevision: number;
    readonly now?: string;
    readonly outcome: 'purged' | 'retained' | 'unknown';
    readonly storageRef: string;
  }
): WorkerStorageBinding {
  const binding = requireWorkerStorageBinding(coreDb, input.storageRef);
  if (binding.revision !== input.expectedRevision || binding.state !== 'purge-pending') {
    throw revisionConflict();
  }
  const now = input.now ?? new Date().toISOString();
  const state =
    input.outcome === 'purged' ? 'purged' : input.outcome === 'retained' ? 'idle' : 'unknown';
  const changed = coreDb.sqlite
    .prepare(
      `UPDATE worker_storage_bindings
       SET revision = revision + 1, state = ?, purged_at = ?, updated_at = ?
       WHERE storage_ref = ? AND revision = ? AND state = 'purge-pending'`
    )
    .run(state, input.outcome === 'purged' ? now : null, now, binding.storageRef, binding.revision);
  if (changed.changes !== 1) throw revisionConflict();
  return requireWorkerStorageBinding(coreDb, input.storageRef);
}

/** Computes the exact host-verifiable canonical image storage-layout digest. */
export function workerStorageLayoutDigest(layoutInput: WorkerStorageLayout): string {
  const layout = normalizeWorkerStorageLayout(layoutInput);
  return sha256(
    JSON.stringify({
      family: layout.family,
      version: layout.version,
      uid: layout.uid,
      gid: layout.gid,
      workingDirectory: layout.workingDirectory,
      platform: {
        architecture: layout.platform.architecture,
        os: layout.platform.os,
      },
      targets: layout.targets,
    })
  );
}

/** Computes the opaque host scope identity without disclosing Workspace metadata. */
export function workerStorageScopeDigest(workspaceId: string): string {
  return sha256(JSON.stringify({ workspaceId: requireIdentity(workspaceId, 'Workspace') }));
}

/** Derives the default stable mutable-worktree slot for one Workspace Thread. */
export function workerStorageDefaultWorkSlotRef(workspaceId: string, threadId: string): string {
  return opaqueRef(
    'wsl',
    `${requireIdentity(workspaceId, 'Workspace')}\0${requireIdentity(threadId, 'Thread')}`
  );
}

/** Reads one required association. */
function requireWorkerStorageBinding(coreDb: CoreDb, storageRef: string): WorkerStorageBinding {
  const binding = getWorkerStorageBinding(coreDb, { storageRef });
  if (!binding) {
    throw new WorkerStorageBindingError('not_found', 'Worker storage association was not found.');
  }
  return binding;
}

/** Applies all current deterministic reuse gates to one explicit choice. */
function assertSelectable(binding: WorkerStorageBinding, input: WorkerStorageSelectionInput): void {
  assertAdmission(binding, input);
  if (binding.revision !== input.expectedRevision) throw revisionConflict();
  if (
    binding.state === 'unknown' ||
    binding.state === 'purge-pending' ||
    binding.state === 'purged'
  ) {
    throw new WorkerStorageBindingError('storage_fenced', 'Worker storage is fenced.');
  }
  if (binding.state !== 'idle') {
    throw new WorkerStorageBindingError('occupied', 'Worker storage already has an attachment.');
  }
}

/** Applies scope, layout, audience, and adjudication gates independent of occupancy. */
function assertAdmission(binding: WorkerStorageBinding, input: WorkerStorageSelectionInput): void {
  requireIdentity(input.responsibleUserId, 'responsible user');
  requireIdentity(input.threadId, 'Thread');
  if (binding.workspaceId !== requireIdentity(input.workspaceId, 'Workspace')) {
    throw new WorkerStorageBindingError(
      'cross_workspace_forbidden',
      'Worker storage cannot cross Workspaces.'
    );
  }
  if (!workerStorageLayoutsCompatible(binding.layout, input.layout)) {
    throw new WorkerStorageBindingError(
      'layout_conflict',
      'Worker storage layout is incompatible.'
    );
  }
  if (!binding.contributors.every(input.authorizeContributor)) {
    throw new WorkerStorageBindingError(
      'authorization_denied',
      'Worker storage contributor audience is no longer authorized.'
    );
  }
  // ponytail: until adjudication targets are server-derived, reviews reuse only review-only storage.
  const adjudicated = new Set(input.adjudicatedThreadIds ?? []);
  if (
    input.purpose === 'independent-review' &&
    binding.contributors.some(
      (contributor) => contributor.purpose === 'work' || adjudicated.has(contributor.threadId)
    )
  ) {
    throw new WorkerStorageBindingError(
      'independent_review_conflict',
      'Independent review cannot reuse contributor storage.'
    );
  }
}

/** Inserts one append-only contributor row. */
function insertContributor(coreDb: CoreDb, contributor: WorkerStorageContributor): void {
  coreDb.sqlite
    .prepare(
      `INSERT INTO worker_storage_contributors (
         contributor_ref, storage_ref, attachment_generation, workspace_id, responsible_user_id,
         thread_id, goal_id, task_id, purpose, work_slot_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      contributor.contributorRef,
      contributor.storageRef,
      contributor.attachmentGeneration,
      contributor.workspaceId,
      contributor.responsibleUserId,
      contributor.threadId,
      contributor.goalId,
      contributor.taskId,
      contributor.purpose,
      contributor.workSlotRef,
      contributor.createdAt
    );
}

/** Selects an existing authorized slot or derives one stable private slot for a new Thread. */
export function resolveWorkerStorageWorkSlotRef(
  binding: WorkerStorageBinding,
  input: Pick<WorkerStorageSelectionInput, 'threadId' | 'responsibleUserId'> & {
    readonly reuseWorkSlotRef?: string;
  }
): string {
  if (input.reuseWorkSlotRef) {
    const selected = requireIdentity(input.reuseWorkSlotRef, 'work slot');
    if (!binding.contributors.some((contributor) => contributor.workSlotRef === selected)) {
      throw new WorkerStorageBindingError(
        'authorization_denied',
        'Selected Worker storage work slot is unavailable.'
      );
    }
    return selected;
  }
  const sameThread = [...binding.contributors]
    .reverse()
    .find(
      (contributor) =>
        contributor.threadId === input.threadId &&
        contributor.responsibleUserId === input.responsibleUserId
    );
  return (
    sameThread?.workSlotRef ?? workerStorageDefaultWorkSlotRef(binding.workspaceId, input.threadId)
  );
}

/** Projects one strict SQLite row and its append-only contributor rows. */
function bindingFromRow(coreDb: CoreDb, row: WorkerStorageBindingRow): WorkerStorageBinding {
  const targets = normalizeStoredTargets(JSON.parse(row.targets_json) as unknown);
  const layout: WorkerStorageLayout = normalizeWorkerStorageLayout({
    family: row.layout_family,
    version: row.layout_version,
    uid: row.owner_uid,
    gid: row.owner_gid,
    workingDirectory: row.working_directory,
    platform: { architecture: row.platform_architecture, os: row.platform_os },
    targets: targets.filter(({ active }) => active).map(({ target }) => ({ target })),
  });
  if (
    row.layout_digest !== workerStorageLayoutDigest(layout) ||
    row.scope_digest !== workerStorageScopeDigest(row.workspace_id)
  ) {
    throw new WorkerStorageBindingError('storage_fenced', 'Worker storage metadata is invalid.');
  }
  const contributors = (
    coreDb.sqlite
      .prepare(
        `SELECT * FROM worker_storage_contributors
         WHERE storage_ref = ? ORDER BY attachment_generation`
      )
      .all(row.storage_ref) as WorkerStorageContributorRow[]
  ).map(contributorFromRow);
  if (contributors.some((contributor) => contributor.workspaceId !== row.workspace_id)) {
    throw new WorkerStorageBindingError('storage_fenced', 'Worker storage lineage is invalid.');
  }
  return {
    attachmentGeneration: row.attachment_generation,
    contributors,
    createdAt: row.created_at,
    currentAgentSessionId: row.current_agent_session_id,
    currentSandboxBindingRef: row.current_sandbox_binding_ref,
    currentThreadId: row.current_thread_id,
    currentWorkSlotRef: row.current_work_slot_ref,
    deploymentId: row.deployment_id,
    layout,
    layoutDigest: row.layout_digest,
    purgedAt: row.purged_at,
    revision: row.revision,
    runtimeTargetId: row.runtime_target_id,
    scopeDigest: row.scope_digest,
    state: row.state,
    storageRef: row.storage_ref,
    targets,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

/** Projects one contributor row. */
function contributorFromRow(row: WorkerStorageContributorRow): WorkerStorageContributor {
  return {
    attachmentGeneration: row.attachment_generation,
    contributorRef: row.contributor_ref,
    createdAt: row.created_at,
    goalId: row.goal_id,
    purpose: row.purpose,
    responsibleUserId: row.responsible_user_id,
    storageRef: row.storage_ref,
    taskId: row.task_id,
    threadId: row.thread_id,
    workspaceId: row.workspace_id,
    workSlotRef: row.work_slot_ref,
  };
}

/** Validates and canonicalizes an image-derived storage layout. */
function normalizeWorkerStorageLayout(layout: WorkerStorageLayout): WorkerStorageLayout {
  const targets = layout.targets
    .map(({ target }) => ({ target: requireAbsolutePath(target, 'storage target') }))
    .sort((left, right) => left.target.localeCompare(right.target));
  if (
    targets.length === 0 ||
    new Set(targets.map(({ target }) => target)).size !== targets.length
  ) {
    throw new WorkerStorageBindingError('layout_conflict', 'Worker storage targets are invalid.');
  }
  for (let index = 1; index < targets.length; index += 1) {
    if (targets[index]!.target.startsWith(`${targets[index - 1]!.target}/`)) {
      throw new WorkerStorageBindingError('layout_conflict', 'Worker storage targets overlap.');
    }
  }
  if (
    !Number.isSafeInteger(layout.uid) ||
    layout.uid < 0 ||
    !Number.isSafeInteger(layout.gid) ||
    layout.gid < 0
  ) {
    throw new WorkerStorageBindingError('layout_conflict', 'Worker storage ownership is invalid.');
  }
  return {
    family: layout.family === null ? null : requireIdentity(layout.family, 'storage family'),
    version: layout.version === null ? null : requireIdentity(layout.version, 'storage version'),
    uid: layout.uid,
    gid: layout.gid,
    workingDirectory: requireAbsolutePath(layout.workingDirectory, 'working directory'),
    platform: {
      architecture: requireIdentity(layout.platform.architecture, 'platform architecture'),
      os: requireIdentity(layout.platform.os, 'platform operating system'),
    },
    targets,
  };
}

/** Validates canonical stored target records. */
function normalizeStoredTargets(value: unknown): WorkerStorageTarget[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WorkerStorageBindingError('storage_fenced', 'Worker storage targets are invalid.');
  }
  const targets = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new WorkerStorageBindingError('storage_fenced', 'Worker storage target is invalid.');
    }
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'active,initialized,target,volumeRef' ||
      typeof record.active !== 'boolean' ||
      typeof record.initialized !== 'boolean'
    ) {
      throw new WorkerStorageBindingError('storage_fenced', 'Worker storage target is invalid.');
    }
    return {
      active: record.active,
      initialized: record.initialized,
      target: requireAbsolutePath(record.target, 'storage target'),
      volumeRef: requireIdentity(record.volumeRef, 'volume'),
    };
  });
  targets.sort((left, right) => left.target.localeCompare(right.target));
  return targets;
}

/** Returns whether an image can reuse the same physical target identities. */
function workerStorageLayoutsCompatible(
  currentInput: WorkerStorageLayout,
  requestedInput: WorkerStorageLayout
): boolean {
  const current = normalizeWorkerStorageLayout(currentInput);
  const requested = normalizeWorkerStorageLayout(requestedInput);
  return (
    current.family === requested.family &&
    current.version === requested.version &&
    current.uid === requested.uid &&
    current.gid === requested.gid &&
    current.workingDirectory === requested.workingDirectory &&
    current.platform.architecture === requested.platform.architecture &&
    current.platform.os === requested.platform.os
  );
}

/** Retains removed volume identities and initializes only newly admitted targets. */
function mergeWorkerStorageTargets(
  storageRef: string,
  current: readonly WorkerStorageTarget[],
  requestedLayout: WorkerStorageLayout
): WorkerStorageTarget[] {
  const currentByPath = new Map(current.map((target) => [target.target, target]));
  const requestedPaths = new Set(requestedLayout.targets.map((target) => target.target));
  const merged = current.map((target) => ({
    ...target,
    active: requestedPaths.has(target.target),
  }));
  for (const { target } of requestedLayout.targets) {
    if (!currentByPath.has(target)) {
      merged.push({
        active: true,
        initialized: false,
        target,
        volumeRef: opaqueRef('wsv', `${storageRef}\0${target}`),
      });
    }
  }
  return merged.sort((left, right) => left.target.localeCompare(right.target));
}

/** Checks the complete exact attachment identity and expected CAS revision. */
function assertExactAttachment(
  binding: WorkerStorageBinding,
  expectedRevision: number,
  attachmentGeneration: number,
  state: 'reserved' | 'attached' | 'unknown'
): void {
  if (
    binding.revision !== expectedRevision ||
    binding.attachmentGeneration !== attachmentGeneration ||
    binding.state !== state
  ) {
    throw revisionConflict();
  }
}

/** Drops only the initialization fact for exact target identity comparison. */
function withoutInitialization(target: WorkerStorageTarget): { target: string; volumeRef: string } {
  return { target: target.target, volumeRef: target.volumeRef };
}

/** Requires one canonical absolute POSIX path. */
function requireAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length > 4096 ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === '/'
  ) {
    throw new WorkerStorageBindingError('layout_conflict', `Worker ${label} is invalid.`);
  }
  return value;
}

/** Requires one bounded non-empty identity. */
function requireIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new WorkerStorageBindingError('authorization_denied', `Worker ${label} is invalid.`);
  }
  return value;
}

/** Creates one opaque stable private reference. */
function opaqueRef(prefix: 'wsv' | 'wsl' | 'wsc', value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

/** Computes one lowercase canonical SHA-256 digest. */
function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Returns the stable stale-state refusal. */
function revisionConflict(): WorkerStorageBindingError {
  return new WorkerStorageBindingError('revision_conflict', 'Worker storage revision changed.');
}

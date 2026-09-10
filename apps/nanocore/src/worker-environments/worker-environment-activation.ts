import { createHash } from 'node:crypto';

import {
  type ActivateWorkerEnvironmentRequest,
  ActivateWorkerEnvironmentRequestSchema,
  type ActivateWorkerEnvironmentResponse,
  ActivateWorkerEnvironmentResponseSchema,
  type WorkerEnvironmentAffectedStorage,
  type WorkerEnvironmentCandidateRef,
  type WorkerEnvironmentConfiguration,
  type WorkerEnvironmentReplaceNow,
  type WorkerEnvironmentTarget,
} from '@openkit/app-api-schemas';
import { AuthoredAgentConfigSchema } from '@openkit/config-schema';
import { applyEdits, modify, type ParseError, parse } from 'jsonc-parser';
import type { Actor } from '../auth/identity.js';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import type { FsStore } from '../lib/store.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import {
  getWorkerStorageBinding,
  getWorkerStorageBindingForSandbox,
  type WorkerStorageContributor,
} from '../runtime/worker-storage-bindings.js';
import type { CoreDb } from '../storage/db.js';
import { WorkerEnvironmentOperationError } from './worker-environment-operations.js';
import type {
  DeriveWorkerEnvironmentAffectedStorageInput,
  ReadWorkerEnvironmentResolvedCandidate,
  WorkerEnvironmentPreparation,
} from './worker-environment-preparation.js';

type ConfigFiles = Pick<RuntimeConfigFileService, 'readFile' | 'updateFile'>;
type WrittenConfiguration = NonNullable<ActivateWorkerEnvironmentResponse['configuration']>;
type AffectedResult = ActivateWorkerEnvironmentResponse['affected'][number];

/** Current caller context for one Worker environment activation. */
export interface WorkerEnvironmentActivationContext {
  /** Authenticated user whose current administrator and audience authority is rechecked. */
  readonly actor: Actor;
}

/** One current member of the exact resident Sandbox sharing group. */
export interface WorkerEnvironmentResidentMember {
  /** Current active Turn, when the member is executing. */
  readonly turnId: string | null;
  /** Source Thread whose writer belongs to the sharing group. */
  readonly threadId: string;
}

/** Existing runtime-owner input for an immediate ordinary successor Turn. */
export interface ReplaceWorkerEnvironmentResidentWorkInput {
  /** Authenticated administrator responsible for the replacement. */
  readonly actor: Actor;
  /** Exact confirmed association revisions for the complete sharing group. */
  readonly affectedStorage: readonly WorkerEnvironmentAffectedStorage[];
  /** Configuration file revision actually written before runtime replacement. */
  readonly configuration: WrittenConfiguration;
  /** Current resident members derived from runtime binding authority. */
  readonly residentMembers: readonly WorkerEnvironmentResidentMember[];
  /** Confirmed target Thread and actual successor Turn prompt. */
  readonly replaceNow: WorkerEnvironmentReplaceNow;
  /** Caller command identity used by existing interrupt and Turn owners. */
  readonly requestId: string;
  /** Exact resolved candidate that authorized the configuration change. */
  readonly resolvedCandidate: WorkerEnvironmentCandidateRef;
  /** Server Agent selected for the ordinary successor Turn. */
  readonly target: WorkerEnvironmentTarget;
}

/** Existing runtime-owner callback for fencing writers and starting the ordinary successor Turn. */
export type ReplaceWorkerEnvironmentResidentWork = (
  input: ReplaceWorkerEnvironmentResidentWorkInput
) => Promise<readonly AffectedResult[]>;

/** Dependencies for current complete affected-group derivation. */
export interface CreateWorkerEnvironmentAffectedStorageDeriverInput {
  /** Core runtime and retained-storage authority. */
  readonly coreDb: CoreDb;
  /** Existing Workspace and Thread source owner. */
  readonly store: FsStore;
}

/** Dependencies for exact candidate activation. */
export interface CreateWorkerEnvironmentActivationInput {
  /** Core runtime and retained-storage authority. */
  readonly coreDb: CoreDb;
  /** Supplies the existing current-user configuration file service. */
  readonly configFilesForActor: (actor: Actor) => ConfigFiles;
  /** Optional process-local duplicate collapse shared by public commands. */
  readonly inflightCommands?: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Optional deterministic clock for focused tests. */
  readonly now?: () => string;
  /** Exact immutable candidate reader owned by preparation. */
  readonly preparation: Pick<WorkerEnvironmentPreparation, 'readResolved'>;
  /** Rechecks current usable deployment-administrator authority or throws. */
  readonly requireCurrentAdministrator: (actor: Actor) => void;
  /** Existing runtime and ordinary-Turn owner for confirmed immediate replacement. */
  readonly replaceResidentWork: ReplaceWorkerEnvironmentResidentWork;
  /** Reloads runtime configuration through the existing safe-mode owner. */
  readonly reloadRuntimeConfig: () => ReturnType<RuntimeConfigManager['reload']>;
  /** Durable Thread, Item, Artifact, and command-receipt owner. */
  readonly store: FsStore;
}

/** Shared activation operation consumed by the public route owner. */
export interface WorkerEnvironmentActivation {
  /** Applies one exact resolved candidate and reports actual partial outcomes. */
  activate(
    context: WorkerEnvironmentActivationContext,
    request: ActivateWorkerEnvironmentRequest
  ): Promise<ActivateWorkerEnvironmentResponse>;
}

interface ResidentGroup {
  readonly affectedStorage: readonly WorkerEnvironmentAffectedStorage[];
  readonly members: readonly WorkerEnvironmentResidentMember[];
}

interface CandidateHome {
  readonly threadId: string;
  readonly workspaceId: string;
}

/**
 * Creates the exact preparation-time affected-storage projection.
 *
 * The returned callback is directly compatible with the preparation service dependency. A
 * config-only candidate has no resident impact. Immediate replacement resolves the named live
 * Thread through the durable Harness and Sandbox joins, then admits the sole retained association
 * only after every current and historical source audience remains available to the same user.
 */
export function createWorkerEnvironmentAffectedStorageDeriver(
  dependencies: CreateWorkerEnvironmentAffectedStorageDeriverInput
): (
  input: DeriveWorkerEnvironmentAffectedStorageInput
) => readonly WorkerEnvironmentAffectedStorage[] {
  return (input) =>
    input.replaceNow
      ? deriveResidentGroup(dependencies, input.actor, input.replaceNow).affectedStorage
      : [];
}

/** Creates the exact configuration-CAS and ordinary-replacement activation owner. */
export function createWorkerEnvironmentActivation(
  dependencies: CreateWorkerEnvironmentActivationInput
): WorkerEnvironmentActivation {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const inflightCommands =
    dependencies.inflightCommands ?? new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();

  return {
    async activate(context, unsafeRequest) {
      const request = ActivateWorkerEnvironmentRequestSchema.parse(unsafeRequest);
      dependencies.requireCurrentAdministrator(context.actor);
      const candidate = requireExactResolvedCandidate(dependencies, context.actor, request);
      const home = { threadId: candidate.threadId, workspaceId: candidate.workspaceId };
      requireCurrentCandidateAudiences(dependencies, context.actor, request);

      return runIdempotentCommand({
        command: 'worker_environment.activate',
        execute: async () => {
          const turnIdentity = activationTurnIdentity(context.actor, home, request);
          requireNoPartialActivation(dependencies.store, home, turnIdentity, request);

          dependencies.requireCurrentAdministrator(context.actor);
          const currentCandidate = requireExactResolvedCandidate(
            dependencies,
            context.actor,
            request
          );
          requireCurrentCandidateAudiences(dependencies, context.actor, request);
          const group = request.replaceNow
            ? deriveResidentGroup(dependencies, context.actor, request.replaceNow)
            : null;
          requireExactAffectedStorage(request.affectedStorage, group?.affectedStorage ?? []);
          const configFiles = dependencies.configFilesForActor(context.actor);
          const updatedContent = prepareAgentConfigurationUpdate(
            configFiles,
            request.configuration,
            request.target,
            currentCandidate.resolved.image
          );
          const turn = createActivationTurn(
            dependencies.store,
            context.actor,
            home,
            turnIdentity,
            request,
            now()
          );

          let configuration: WrittenConfiguration | null = null;
          let affected = unchangedAffected(request.affectedStorage);
          let reloadApplied = false;
          try {
            dependencies.requireCurrentAdministrator(context.actor);
            requireExactResolvedCandidate(dependencies, context.actor, request);
            requireCurrentCandidateAudiences(dependencies, context.actor, request);
            if (request.replaceNow) {
              const currentGroup = deriveResidentGroup(
                dependencies,
                context.actor,
                request.replaceNow
              );
              requireExactAffectedStorage(request.affectedStorage, currentGroup.affectedStorage);
            }
            const written = configFiles.updateFile({
              content: updatedContent,
              expectedRevision: request.configuration.expectedRevision,
              id: request.configuration.fileId,
              kind: 'agent',
            });
            if (
              written.file.id !== request.configuration.fileId ||
              written.file.kind !== 'agent' ||
              !written.file.revision
            ) {
              throw new Error('Agent configuration write result is inconsistent.');
            }
            configuration = {
              fileId: written.file.id,
              revision: written.file.revision,
            };
            reloadApplied = dependencies.reloadRuntimeConfig().status === 'applied';
          } catch {
            reloadApplied = false;
          }

          if (configuration && reloadApplied && request.replaceNow && group) {
            try {
              dependencies.requireCurrentAdministrator(context.actor);
              requireCurrentCandidateAudiences(dependencies, context.actor, request);
              const currentGroup = deriveResidentGroup(
                dependencies,
                context.actor,
                request.replaceNow
              );
              requireExactAffectedStorage(request.affectedStorage, currentGroup.affectedStorage);
              affected = requireExactAffectedResult(
                request.affectedStorage,
                await dependencies.replaceResidentWork({
                  actor: context.actor,
                  affectedStorage: request.affectedStorage,
                  configuration,
                  residentMembers: currentGroup.members,
                  replaceNow: request.replaceNow,
                  requestId: request.requestId,
                  resolvedCandidate: request.resolvedCandidate,
                  target: request.target,
                })
              );
            } catch {
              affected = unknownAffected(request.affectedStorage);
            }
          }

          const response = ActivateWorkerEnvironmentResponseSchema.parse({
            affected,
            configuration,
            replaceNow: request.replaceNow,
            requestId: request.requestId,
            resolvedCandidate: request.resolvedCandidate,
            target: request.target,
          });
          const artifact = createActivationResultArtifact(
            home,
            turn.id,
            request.requestId,
            response,
            now()
          );
          dependencies.store.createArtifact(artifact);
          dependencies.store.updateTurn(turn.id, {
            completedAt: artifact.createdAt,
            status: 'completed',
          });
          return response;
        },
        inflightCommands,
        input: request,
        replay: (record) => {
          dependencies.requireCurrentAdministrator(context.actor);
          requireExactResolvedCandidate(dependencies, context.actor, request);
          requireCurrentCandidateAudiences(dependencies, context.actor, request);
          if (record.response.kind !== 'artifact') {
            throw recoveryRequired('Activation receipt does not identify its result Artifact.');
          }
          return readActivationResult(
            dependencies.store,
            context.actor,
            home,
            request,
            record.response.id
          );
        },
        requestId: request.requestId,
        responseId: () => activationArtifactId(context.actor, home, request.requestId),
        responseKind: 'artifact',
        scope: {
          actorId: context.actor.userId,
          threadId: home.threadId,
          workspaceId: home.workspaceId,
        },
        store: dependencies.store,
      });
    },
  };
}

/** Resolves the exact durable resident sharing group selected for immediate replacement. */
function deriveResidentGroup(
  dependencies: CreateWorkerEnvironmentAffectedStorageDeriverInput,
  actor: Actor,
  replaceNow: WorkerEnvironmentReplaceNow
): ResidentGroup {
  requireWorkspaceAuthority(dependencies.coreDb, actor, replaceNow.workspaceId);
  requireSourceThread(dependencies.store, replaceNow.workspaceId, replaceNow.threadId);
  const selectedRows = dependencies.coreDb.sqlite
    .prepare(
      `SELECT b.thread_id AS threadId, b.current_turn_id AS turnId,
              s.sandbox_runtime_id AS sandboxRuntimeId,
              s.sandbox_binding_ref AS sandboxBindingRef
       FROM agent_session_runtime_bindings b
       JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
       JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
       WHERE b.workspace_id = ? AND b.thread_id = ?
         AND b.lifecycle_state NOT IN ('closed', 'failed')`
    )
    .all(replaceNow.workspaceId, replaceNow.threadId) as Array<{
    readonly sandboxBindingRef: string;
    readonly sandboxRuntimeId: string;
    readonly threadId: string;
    readonly turnId: string | null;
  }>;
  if (selectedRows.length !== 1) {
    throw unavailable('The selected Thread has no unique resident Worker environment.');
  }
  const selected = selectedRows[0]!;
  const memberRows = dependencies.coreDb.sqlite
    .prepare(
      `SELECT b.workspace_id AS workspaceId, b.thread_id AS threadId,
              b.current_turn_id AS turnId
       FROM agent_session_runtime_bindings b
       JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
       WHERE h.sandbox_runtime_id = ?
         AND b.lifecycle_state NOT IN ('closed', 'failed')
       ORDER BY b.thread_id, b.agent_session_runtime_binding_id`
    )
    .all(selected.sandboxRuntimeId) as Array<{
    readonly threadId: string;
    readonly turnId: string | null;
    readonly workspaceId: string;
  }>;
  if (
    memberRows.length === 0 ||
    memberRows.some((member) => member.workspaceId !== replaceNow.workspaceId) ||
    new Set(memberRows.map((member) => member.threadId)).size !== memberRows.length
  ) {
    throw unavailable('The resident Worker environment sharing group is inconsistent.');
  }
  for (const member of memberRows) {
    requireSourceThread(dependencies.store, member.workspaceId, member.threadId);
  }
  const binding = getWorkerStorageBindingForSandbox(dependencies.coreDb, {
    sandboxBindingRef: selected.sandboxBindingRef,
  });
  if (
    !binding ||
    binding.workspaceId !== replaceNow.workspaceId ||
    !['attached', 'unknown'].includes(binding.state) ||
    binding.currentSandboxBindingRef !== selected.sandboxBindingRef ||
    binding.contributors.length === 0 ||
    !binding.contributors.every((contributor) =>
      contributorIsAuthorized(dependencies.store, actor, replaceNow.workspaceId, contributor)
    ) ||
    memberRows.some(
      (member) =>
        !binding.contributors.some(
          (contributor) =>
            contributor.workspaceId === member.workspaceId &&
            contributor.threadId === member.threadId &&
            contributor.responsibleUserId === actor.userId
        )
    )
  ) {
    throw unavailable('The resident Worker environment source audience is unavailable.');
  }
  return {
    affectedStorage: [{ expectedRevision: binding.revision, storageRef: binding.storageRef }],
    members: memberRows.map(({ threadId, turnId }) => ({ threadId, turnId })),
  };
}

/** Rechecks current access to every source represented by the immutable candidate. */
function requireCurrentCandidateAudiences(
  dependencies: Pick<CreateWorkerEnvironmentActivationInput, 'coreDb' | 'store'>,
  actor: Actor,
  request: ActivateWorkerEnvironmentRequest
): void {
  if (!request.replaceNow) return;
  requireWorkspaceAuthority(dependencies.coreDb, actor, request.replaceNow.workspaceId);
  requireSourceThread(
    dependencies.store,
    request.replaceNow.workspaceId,
    request.replaceNow.threadId
  );
  for (const affected of request.affectedStorage) {
    const binding = getWorkerStorageBinding(dependencies.coreDb, {
      storageRef: affected.storageRef,
    });
    if (
      !binding ||
      binding.workspaceId !== request.replaceNow.workspaceId ||
      binding.state === 'purged' ||
      binding.contributors.length === 0 ||
      !binding.contributors.every((contributor) =>
        contributorIsAuthorized(
          dependencies.store,
          actor,
          request.replaceNow!.workspaceId,
          contributor
        )
      )
    ) {
      throw new WorkerEnvironmentOperationError(
        'workspace_access_denied',
        'Worker environment source access is unavailable.'
      );
    }
  }
}

/** Requires current Workspace membership and policy for technical replacement. */
function requireWorkspaceAuthority(coreDb: CoreDb, actor: Actor, workspaceId: string): void {
  if (
    !isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
      authentication: 'deployment-admin',
      mutating: true,
      policyOperation: 'workspace.configure',
    })
  ) {
    throw new WorkerEnvironmentOperationError(
      'workspace_access_denied',
      'Workspace access denied.'
    );
  }
}

/** Returns whether one historical contributor remains in the current user's source audience. */
function contributorIsAuthorized(
  store: FsStore,
  actor: Actor,
  workspaceId: string,
  contributor: WorkerStorageContributor
): boolean {
  if (contributor.workspaceId !== workspaceId || contributor.responsibleUserId !== actor.userId) {
    return false;
  }
  try {
    return store.getThread(workspaceId, contributor.threadId).workspaceId === workspaceId;
  } catch {
    return false;
  }
}

/** Requires one current source Thread without disclosing foreign lineage. */
function requireSourceThread(store: FsStore, workspaceId: string, threadId: string): void {
  try {
    if (store.getThread(workspaceId, threadId).workspaceId !== workspaceId) throw new Error();
  } catch {
    throw new WorkerEnvironmentOperationError(
      'workspace_access_denied',
      'Workspace access denied.'
    );
  }
}

/** Loads and verifies the exact immutable B/A facts bound by the activation request. */
function requireExactResolvedCandidate(
  dependencies: Pick<CreateWorkerEnvironmentActivationInput, 'preparation'>,
  actor: Actor,
  request: ActivateWorkerEnvironmentRequest
): ReadWorkerEnvironmentResolvedCandidate {
  const candidate = dependencies.preparation.readResolved({ actor }, request.resolvedCandidate);
  const requestFacts = canonicalCandidateFacts(request);
  const resolvedFacts = canonicalCandidateFacts(candidate.resolved);
  const authoredFacts = canonicalCandidateFacts(candidate.authored);
  if (
    JSON.stringify(requestFacts) !== JSON.stringify(resolvedFacts) ||
    JSON.stringify(resolvedFacts) !== JSON.stringify(authoredFacts) ||
    JSON.stringify(candidate.resolved.authoredCandidate) !==
      JSON.stringify(candidate.authoredCandidate) ||
    JSON.stringify(candidate.resolvedCandidate) !== JSON.stringify(request.resolvedCandidate)
  ) {
    throw new WorkerEnvironmentOperationError(
      'candidate_conflict',
      'Activation request does not match its immutable candidate.'
    );
  }
  return candidate;
}

/** Returns deterministic exact candidate facts independent of object insertion order. */
function canonicalCandidateFacts(input: {
  readonly affectedStorage: readonly WorkerEnvironmentAffectedStorage[];
  readonly configuration: WorkerEnvironmentConfiguration;
  readonly replaceNow: WorkerEnvironmentReplaceNow | null;
  readonly target: WorkerEnvironmentTarget;
}) {
  return {
    affectedStorage: canonicalAffectedStorage(input.affectedStorage),
    configuration: {
      expectedRevision: input.configuration.expectedRevision,
      fileId: input.configuration.fileId,
    },
    replaceNow: input.replaceNow
      ? {
          prompt: input.replaceNow.prompt,
          threadId: input.replaceNow.threadId,
          workspaceId: input.replaceNow.workspaceId,
        }
      : null,
    target: { agentId: input.target.agentId, kind: 'agent' as const },
  };
}

/** Reads, validates, and edits only the targeted Agent manifest runtime.image field. */
function prepareAgentConfigurationUpdate(
  configFiles: ConfigFiles,
  configuration: WorkerEnvironmentConfiguration,
  target: WorkerEnvironmentTarget,
  image: ReadWorkerEnvironmentResolvedCandidate['resolved']['image']
): string {
  let read: ReturnType<ConfigFiles['readFile']>;
  try {
    read = configFiles.readFile(configuration.fileId);
  } catch {
    throw new WorkerEnvironmentOperationError(
      'revision_conflict',
      'Agent configuration revision changed before activation.'
    );
  }
  if (
    read.file.id !== configuration.fileId ||
    read.file.kind !== 'agent' ||
    read.file.revision !== configuration.expectedRevision
  ) {
    throw new WorkerEnvironmentOperationError(
      'revision_conflict',
      'Agent configuration revision changed before activation.'
    );
  }
  const current = parseAgentConfiguration(read.content, target);
  const pinnedImage = {
    kind: 'reference' as const,
    pullPolicy: 'never' as const,
    ref: image.digest,
  };
  if (JSON.stringify(current.runtime.image) === JSON.stringify(pinnedImage)) {
    throw new WorkerEnvironmentOperationError(
      'candidate_conflict',
      'Agent configuration already contains the resolved image digest.'
    );
  }
  let content: string;
  try {
    content = applyEdits(
      read.content,
      modify(read.content, ['runtime', 'image'], pinnedImage, {
        formattingOptions: { eol: '\n', insertSpaces: true, tabSize: 2 },
      })
    );
  } catch {
    throw new WorkerEnvironmentOperationError(
      'invalid_request',
      'Agent configuration cannot accept the resolved image digest.'
    );
  }
  const updated = parseAgentConfiguration(content, target);
  if (JSON.stringify(updated.runtime.image) !== JSON.stringify(pinnedImage)) {
    throw new WorkerEnvironmentOperationError(
      'invalid_request',
      'Agent configuration cannot accept the resolved image digest.'
    );
  }
  return content;
}

/** Parses one exact Agent source file and proves it owns the requested target. */
function parseAgentConfiguration(content: string, target: WorkerEnvironmentTarget) {
  const errors: ParseError[] = [];
  const parsedJson = parse(content, errors, { allowTrailingComma: true });
  const parsed = errors.length === 0 ? AuthoredAgentConfigSchema.safeParse(parsedJson) : null;
  if (!parsed?.success || parsed.data.id !== target.agentId) {
    throw new WorkerEnvironmentOperationError(
      'invalid_request',
      'Agent configuration does not match the requested target.'
    );
  }
  return parsed.data;
}

/** Rejects stale or reordered affected groups before any configuration effect. */
function requireExactAffectedStorage(
  expected: readonly WorkerEnvironmentAffectedStorage[],
  current: readonly WorkerEnvironmentAffectedStorage[]
): void {
  if (
    JSON.stringify(canonicalAffectedStorage(expected)) !==
    JSON.stringify(canonicalAffectedStorage(current))
  ) {
    throw new WorkerEnvironmentOperationError(
      'revision_conflict',
      'Affected Worker environment revisions changed before activation.'
    );
  }
}

/** Validates that the runtime owner reported exactly the confirmed association group. */
function requireExactAffectedResult(
  expected: readonly WorkerEnvironmentAffectedStorage[],
  result: readonly AffectedResult[]
): AffectedResult[] {
  const allowedDispositions = new Set(['fenced', 'reattached', 'unchanged', 'unknown']);
  const expectedKeys = canonicalAffectedStorage(expected).map(affectedKey);
  const parsed = result.map((entry) => ({
    disposition: entry.disposition,
    expectedRevision: entry.expectedRevision,
    storageRef: entry.storageRef,
  }));
  if (
    parsed.some((entry) => !allowedDispositions.has(entry.disposition)) ||
    JSON.stringify(expectedKeys) !==
      JSON.stringify(canonicalAffectedResult(parsed).map(affectedKey))
  ) {
    throw new Error('Runtime replacement result does not match the confirmed group.');
  }
  return canonicalAffectedResult(parsed);
}

/** Creates the deterministic private activation Turn and request-digest status Item. */
function createActivationTurn(
  store: FsStore,
  actor: Actor,
  home: CandidateHome,
  identity: { readonly itemId: string; readonly turnId: string },
  request: ActivateWorkerEnvironmentRequest,
  timestamp: string
) {
  requireNoUnrelatedRunningTurn(store, home, identity.turnId);
  const turn = store.createTurn(
    home.workspaceId,
    home.threadId,
    'Activate Worker environment',
    { kind: 'user', id: actor.userId },
    null,
    { startedAt: timestamp, turnId: identity.turnId }
  );
  store.createItem({
    completedAt: timestamp,
    createdAt: timestamp,
    id: identity.itemId,
    level: 'info',
    status: 'completed',
    summary: activationStatusSummary(request),
    threadId: home.threadId,
    title: 'Activating Worker environment',
    turnId: turn.id,
    type: 'status',
    workspaceId: home.workspaceId,
  });
  return turn;
}

/** Rejects missing-receipt partial activation state without repeating any effect. */
function requireNoPartialActivation(
  store: FsStore,
  home: CandidateHome,
  identity: { readonly itemId: string; readonly turnId: string },
  request: ActivateWorkerEnvironmentRequest
): void {
  const turn = store
    .listThreadTurns(home.workspaceId, home.threadId)
    .find((candidate) => candidate.id === identity.turnId);
  if (!turn) return;
  const item = store
    .listThreadItems(home.workspaceId, home.threadId)
    .find((candidate) => candidate.id === identity.itemId && candidate.turnId === turn.id);
  if (item?.type === 'status' && item.summary !== activationStatusSummary(request)) {
    throw new IdempotencyKeyConflictError();
  }
  throw recoveryRequired('Activation has partial durable state without its command receipt.');
}

/** Rejects a new activation while unrelated work owns the private administration Thread. */
function requireNoUnrelatedRunningTurn(
  store: FsStore,
  home: CandidateHome,
  activationTurnId: string
): void {
  const busy = store
    .listThreadTurns(home.workspaceId, home.threadId)
    .some(
      (turn) =>
        turn.id !== activationTurnId &&
        !['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status)
    );
  if (busy) {
    throw new WorkerEnvironmentOperationError(
      'thread_busy',
      'Administration Thread already has active work.'
    );
  }
}

/** Creates one immutable exact activation response Artifact. */
function createActivationResultArtifact(
  home: CandidateHome,
  turnId: string,
  requestId: string,
  response: ActivateWorkerEnvironmentResponse,
  timestamp: string
): Parameters<FsStore['createArtifact']>[0] {
  const body = JSON.stringify(response);
  return {
    content: { body, format: 'json' },
    contentDigest: digest(body),
    createdAt: timestamp,
    id: activationArtifactIdFromTurn(turnId),
    kind: 'report',
    lastMutationRequestId: requestId,
    origin: {
      kind: 'turn-output',
      requestId,
      threadId: home.threadId,
      turnId,
    },
    status: 'ready',
    summary: null,
    threadId: home.threadId,
    title: 'Worker environment activation result',
    turnId,
    updatedAt: timestamp,
    version: 1,
    workspaceId: home.workspaceId,
  };
}

/** Replays exact immutable response bytes only after current authorization succeeds. */
function readActivationResult(
  store: FsStore,
  actor: Actor,
  home: CandidateHome,
  request: ActivateWorkerEnvironmentRequest,
  artifactId: string
): ActivateWorkerEnvironmentResponse {
  const identity = activationTurnIdentity(actor, home, request);
  if (artifactId !== activationArtifactIdFromTurn(identity.turnId)) {
    throw recoveryRequired('Activation receipt result is inconsistent.');
  }
  let artifact: ReturnType<FsStore['getArtifact']>;
  try {
    artifact = store.getArtifact(home.workspaceId, artifactId);
  } catch {
    throw recoveryRequired('Activation result Artifact is unavailable.');
  }
  if (
    artifact.version !== 1 ||
    artifact.kind !== 'report' ||
    artifact.status !== 'ready' ||
    artifact.content.format !== 'json' ||
    artifact.contentDigest !== digest(artifact.content.body) ||
    artifact.lastMutationRequestId !== request.requestId ||
    artifact.origin.kind !== 'turn-output' ||
    artifact.workspaceId !== home.workspaceId ||
    artifact.threadId !== home.threadId ||
    artifact.turnId !== identity.turnId ||
    artifact.origin.threadId !== home.threadId ||
    artifact.origin.turnId !== identity.turnId ||
    artifact.origin.requestId !== request.requestId
  ) {
    throw recoveryRequired('Activation result Artifact is inconsistent.');
  }
  try {
    const turn = store.getTurn(home.workspaceId, home.threadId, identity.turnId);
    if (turn.status !== 'completed') {
      throw recoveryRequired('Activation result Turn is incomplete.');
    }
  } catch (error) {
    if (error instanceof WorkerEnvironmentOperationError) throw error;
    throw recoveryRequired('Activation result Turn is unavailable.');
  }
  let value: unknown;
  try {
    value = JSON.parse(artifact.content.body);
  } catch {
    throw recoveryRequired('Activation result Artifact is invalid.');
  }
  const parsed = ActivateWorkerEnvironmentResponseSchema.safeParse(value);
  if (
    !parsed.success ||
    JSON.stringify(parsed.data) !== artifact.content.body ||
    parsed.data.requestId !== request.requestId ||
    JSON.stringify(parsed.data.resolvedCandidate) !== JSON.stringify(request.resolvedCandidate) ||
    JSON.stringify(parsed.data.target) !== JSON.stringify(request.target) ||
    JSON.stringify(parsed.data.replaceNow) !== JSON.stringify(request.replaceNow) ||
    JSON.stringify(
      canonicalAffectedStorage(
        parsed.data.affected.map(({ expectedRevision, storageRef }) => ({
          expectedRevision,
          storageRef,
        }))
      )
    ) !== JSON.stringify(canonicalAffectedStorage(request.affectedStorage)) ||
    (parsed.data.configuration !== null &&
      parsed.data.configuration.fileId !== request.configuration.fileId)
  ) {
    throw recoveryRequired('Activation result Artifact is inconsistent.');
  }
  return parsed.data;
}

/** Derives deterministic request-owned private Turn and status Item ids. */
function activationTurnIdentity(
  actor: Pick<Actor, 'userId'>,
  home: CandidateHome,
  request: Pick<ActivateWorkerEnvironmentRequest, 'requestId'>
): { readonly itemId: string; readonly turnId: string } {
  const suffix = stableSuffix([actor.userId, home.workspaceId, home.threadId, request.requestId]);
  return {
    itemId: `it_worker_environment_activation_${suffix}`,
    turnId: `tu_worker_environment_activation_${suffix}`,
  };
}

/** Returns the deterministic result Artifact id for one activation command. */
function activationArtifactId(actor: Actor, home: CandidateHome, requestId: string): string {
  return activationArtifactIdFromTurn(activationTurnIdentity(actor, home, { requestId }).turnId);
}

/** Returns the deterministic result Artifact id for one private activation Turn. */
function activationArtifactIdFromTurn(turnId: string): string {
  return `ar_worker_environment_activation_${stableSuffix([turnId])}`;
}

/** Stable status content that proves the exact request owned an existing partial Turn. */
function activationStatusSummary(request: ActivateWorkerEnvironmentRequest): string {
  return `Worker environment activation request ${commandInputHash(request)}.`;
}

/** Sorts association revision facts without weakening exact membership. */
function canonicalAffectedStorage(
  values: readonly WorkerEnvironmentAffectedStorage[]
): WorkerEnvironmentAffectedStorage[] {
  return values
    .map(({ expectedRevision, storageRef }) => ({ expectedRevision, storageRef }))
    .sort((left, right) => left.storageRef.localeCompare(right.storageRef));
}

/** Sorts closed runtime outcomes by their public association identity. */
function canonicalAffectedResult(values: readonly AffectedResult[]): AffectedResult[] {
  return values
    .map(({ disposition, expectedRevision, storageRef }) => ({
      disposition,
      expectedRevision,
      storageRef,
    }))
    .sort((left, right) => left.storageRef.localeCompare(right.storageRef));
}

/** Returns a comparison key that excludes the runtime-owned disposition. */
function affectedKey(value: WorkerEnvironmentAffectedStorage): string {
  return `${value.storageRef}:${value.expectedRevision}`;
}

/** Reports proved absence of a resident replacement effect. */
function unchangedAffected(values: readonly WorkerEnvironmentAffectedStorage[]): AffectedResult[] {
  return canonicalAffectedStorage(values).map((value) => ({ ...value, disposition: 'unchanged' }));
}

/** Reports an uncertain runtime replacement without widening it to success. */
function unknownAffected(values: readonly WorkerEnvironmentAffectedStorage[]): AffectedResult[] {
  return canonicalAffectedStorage(values).map((value) => ({ ...value, disposition: 'unknown' }));
}

/** Exact lowercase SHA-256 digest of immutable Artifact content. */
function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Stable bounded lowercase identifier suffix. */
function stableSuffix(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, 24);
}

/** Creates one closed unavailable failure without exposing runtime internals. */
function unavailable(message: string): WorkerEnvironmentOperationError {
  return new WorkerEnvironmentOperationError('unavailable', message);
}

/** Creates one closed partial-command failure that forbids effect replay. */
function recoveryRequired(message: string): WorkerEnvironmentOperationError {
  return new WorkerEnvironmentOperationError('recovery_required', message);
}

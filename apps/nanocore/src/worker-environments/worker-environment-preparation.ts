import { createHash } from 'node:crypto';

import {
  type PrepareWorkerEnvironmentRequest,
  PrepareWorkerEnvironmentRequestSchema,
  type PrepareWorkerEnvironmentResponse,
  PrepareWorkerEnvironmentResponseSchema,
  type WorkerEnvironmentAuthoredCandidateArtifact,
  WorkerEnvironmentAuthoredCandidateArtifactSchema,
  type WorkerEnvironmentCandidateRef,
  type WorkerEnvironmentConfiguration,
  type WorkerEnvironmentReplaceNow,
  type WorkerEnvironmentResolvedCandidateArtifact,
  WorkerEnvironmentResolvedCandidateArtifactSchema,
  type WorkerEnvironmentTarget,
  workerEnvironmentActivationConfirmation,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  type AuthoredAgentConfig,
  AuthoredAgentConfigSchema,
  AuthoredAgentRuntimeSchema,
} from '@openkit/config-schema';
import { type ParseError, parse } from 'jsonc-parser';
import type { z } from 'zod';

import type { Actor } from '../auth/identity.js';
import type { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import type { FsStore } from '../lib/store.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import type {
  PreparedWorkerEnvironmentImage,
  WorkerEnvironmentRuntimeEffects,
} from '../runtime/worker-environment-runtime-effects.js';
import { WorkerEnvironmentOperationError } from './worker-environment-operations.js';

type ConfigFiles = Pick<RuntimeConfigFileService, 'readFile'>;
type CandidateArtifact = ReturnType<FsStore['getArtifact']>;
type TurnOutputCandidateArtifact = CandidateArtifact & {
  readonly origin: Extract<CandidateArtifact['origin'], { readonly kind: 'turn-output' }>;
};
type RuntimeImage = AgentEnvironmentPackage['runtime']['image'];

/** Current caller context for one private environment preparation operation. */
export interface WorkerEnvironmentPreparationContext {
  /** Authenticated user whose current administrator authority is rechecked. */
  readonly actor: Actor;
  /** Actual running administration Turn when invoked by the private Assistant. */
  readonly administrationTurnId?: string | undefined;
}

/** Current affected association derivation owned by replacement admission. */
export interface DeriveWorkerEnvironmentAffectedStorageInput {
  readonly actor: Actor;
  readonly configuration: WorkerEnvironmentConfiguration;
  readonly replaceNow: WorkerEnvironmentReplaceNow | null;
  readonly target: WorkerEnvironmentTarget;
}

/** Dependencies for immutable Worker environment preparation. */
export interface CreateWorkerEnvironmentPreparationInput {
  /** Rechecks the current usable deployment-administrator authority or throws. */
  readonly requireCurrentAdministrator: (actor: Actor) => void;
  /** Rechecks that one exact Thread/Turn remains in the current user's private home. */
  readonly authorizePrivateHome: (input: {
    readonly actor: Actor;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId: string;
  }) => boolean;
  /** Derives the exact current resident association group selected by replaceNow. */
  readonly deriveAffectedStorage: (
    input: DeriveWorkerEnvironmentAffectedStorageInput
  ) => readonly { readonly expectedRevision: number; readonly storageRef: string }[];
  /** Supplies the existing current-user configuration service. */
  readonly configFilesForActor: (actor: Actor) => ConfigFiles;
  /** Derives the built-in private Quick Chat Workspace from the authenticated user. */
  readonly privateWorkspaceIdForUser: (userId: string) => string;
  /** Existing image preparation and result-only recovery effects. */
  readonly runtimeEffects: WorkerEnvironmentRuntimeEffects;
  /** Durable app-local Artifact, Turn, Item, and command-receipt owner. */
  readonly store: FsStore;
  /** Optional shared process-local duplicate collapse map. */
  readonly inflightCommands?: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Optional deterministic clock for focused tests. */
  readonly now?: () => string;
}

/** Parsed immutable candidate pair and its authorized private home. */
export interface ReadWorkerEnvironmentResolvedCandidate {
  readonly authored: WorkerEnvironmentAuthoredCandidateArtifact;
  readonly authoredCandidate: WorkerEnvironmentCandidateRef;
  readonly resolved: WorkerEnvironmentResolvedCandidateArtifact;
  readonly resolvedCandidate: WorkerEnvironmentCandidateRef;
  readonly threadId: string;
  readonly workspaceId: string;
}

/** Immutable preparation service shared by public and private administration entry points. */
export interface WorkerEnvironmentPreparation {
  /** Creates or recovers one exact authored/resolved candidate pair. */
  prepare(
    context: WorkerEnvironmentPreparationContext,
    request: PrepareWorkerEnvironmentRequest
  ): Promise<PrepareWorkerEnvironmentResponse>;
  /** Reads one exact resolved candidate after current private-home authorization. */
  readResolved(
    context: { readonly actor: Actor },
    resolvedCandidate: WorkerEnvironmentCandidateRef
  ): ReadWorkerEnvironmentResolvedCandidate;
}

/** Reads and validates one exact current Server Agent manifest revision. */
export function readWorkerEnvironmentTargetManifest(
  configFiles: ConfigFiles,
  input: {
    readonly configuration: WorkerEnvironmentConfiguration;
    readonly target: WorkerEnvironmentTarget;
  }
): AuthoredAgentConfig {
  let read: ReturnType<ConfigFiles['readFile']>;
  try {
    read = configFiles.readFile(input.configuration.fileId);
  } catch (error) {
    throw new WorkerEnvironmentOperationError(
      'revision_conflict',
      error instanceof Error ? error.message : 'Agent configuration is unavailable.'
    );
  }
  if (
    read.file.id !== input.configuration.fileId ||
    read.file.kind !== 'agent' ||
    read.file.revision !== input.configuration.expectedRevision
  ) {
    throw new WorkerEnvironmentOperationError(
      'revision_conflict',
      'Agent configuration revision changed before preparation.'
    );
  }
  const errors: ParseError[] = [];
  const value = parse(read.content, errors, { allowTrailingComma: true });
  const parsed = errors.length === 0 ? AuthoredAgentConfigSchema.safeParse(value) : null;
  if (!parsed?.success || parsed.data.id !== input.target.agentId) {
    throw new WorkerEnvironmentOperationError(
      'invalid_request',
      'Agent configuration does not match the requested target.'
    );
  }
  return parsed.data;
}

/** Creates the immutable Worker environment preparation owner. */
export function createWorkerEnvironmentPreparation(
  dependencies: CreateWorkerEnvironmentPreparationInput
): WorkerEnvironmentPreparation {
  const inflightCommands =
    dependencies.inflightCommands ?? new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
  const now = dependencies.now ?? (() => new Date().toISOString());

  const requirePrivateHome = (
    actor: Actor,
    workspaceId: string,
    artifact: TurnOutputCandidateArtifact
  ): void => {
    requirePrivateTurn(actor, workspaceId, artifact.origin.threadId, artifact.origin.turnId, true);
  };

  const requirePrivateTurn = (
    actor: Actor,
    workspaceId: string,
    threadId: string,
    turnId: string,
    requireExistingTurn: boolean
  ): void => {
    try {
      const workspace = dependencies.store.getWorkspace(workspaceId);
      const thread = dependencies.store.getThread(workspaceId, threadId);
      if (requireExistingTurn) dependencies.store.getTurn(workspaceId, threadId, turnId);
      if (
        workspace.kind !== 'quick-chat' ||
        thread.entryPath !== 'administration' ||
        !dependencies.authorizePrivateHome({
          actor,
          threadId,
          turnId,
          workspaceId,
        })
      ) {
        throw new Error();
      }
    } catch {
      throw new WorkerEnvironmentOperationError(
        'not_found',
        'Preparation candidate was not found.'
      );
    }
  };

  const readCandidatePair = (
    actor: Actor,
    resolvedRef: WorkerEnvironmentCandidateRef
  ): ReadWorkerEnvironmentResolvedCandidate => {
    dependencies.requireCurrentAdministrator(actor);
    const workspaceId = dependencies.privateWorkspaceIdForUser(actor.userId);
    const resolvedArtifact = requireCandidateArtifact(
      dependencies.store,
      workspaceId,
      resolvedRef,
      'resolved'
    );
    requirePrivateHome(actor, workspaceId, resolvedArtifact);
    const resolved = parseCandidateBody(
      resolvedArtifact,
      WorkerEnvironmentResolvedCandidateArtifactSchema,
      'resolved'
    );
    if (resolvedArtifact.id !== resolvedArtifactId(resolved.authoredCandidate)) {
      throw candidateConflict('Resolved candidate identity is inconsistent.');
    }
    const authoredArtifact = requireCandidateArtifact(
      dependencies.store,
      workspaceId,
      resolved.authoredCandidate,
      'authored'
    );
    requirePrivateHome(actor, workspaceId, authoredArtifact);
    const authored = parseCandidateBody(
      authoredArtifact,
      WorkerEnvironmentAuthoredCandidateArtifactSchema,
      'authored'
    );
    if (!sameCandidateBaseline(authored, resolved)) {
      throw candidateConflict('Resolved candidate does not match its authored candidate.');
    }
    return {
      authored,
      authoredCandidate: candidateRef(authoredArtifact),
      resolved,
      resolvedCandidate: candidateRef(resolvedArtifact),
      threadId: resolvedArtifact.origin.threadId,
      workspaceId,
    };
  };

  return {
    async prepare(context, unsafeRequest) {
      const request = PrepareWorkerEnvironmentRequestSchema.parse(unsafeRequest);
      dependencies.requireCurrentAdministrator(context.actor);
      const workspaceId = dependencies.privateWorkspaceIdForUser(context.actor.userId);
      requireAdministrationThread(dependencies.store, workspaceId, request.administrationThreadId);

      return runIdempotentCommand({
        command: 'worker_environment.prepare',
        execute: async () => {
          dependencies.requireCurrentAdministrator(context.actor);
          return request.mode === 'prepare'
            ? executeInitialPreparation(context, request, workspaceId)
            : executeRecovery(context, request, workspaceId);
        },
        inflightCommands,
        input: request,
        replay: (record) => {
          if (record.response.kind !== 'artifact') {
            throw recoveryRequired('Preparation receipt does not identify a resolved candidate.');
          }
          const resolvedArtifact = requireArtifactById(
            dependencies.store,
            workspaceId,
            record.response.id
          );
          const pair = readCandidatePair(context.actor, candidateRef(resolvedArtifact));
          return responseFromCandidate(
            request.requestId,
            pair.authoredCandidate,
            pair.resolvedCandidate,
            resolvedArtifact.createdAt,
            pair.resolved
          );
        },
        requestId: request.requestId,
        responseId: (result) => result.resolvedCandidate.artifactId,
        responseKind: 'artifact',
        scope: {
          actorId: context.actor.userId,
          threadId: request.administrationThreadId,
          workspaceId,
        },
        store: dependencies.store,
      });
    },

    readResolved(context, resolvedCandidate) {
      return readCandidatePair(context.actor, resolvedCandidate);
    },
  };

  async function executeInitialPreparation(
    context: WorkerEnvironmentPreparationContext,
    request: Extract<PrepareWorkerEnvironmentRequest, { readonly mode: 'prepare' }>,
    workspaceId: string
  ): Promise<PrepareWorkerEnvironmentResponse> {
    const declaration = requireExactAuthoredImage(request.declaration);
    const authoredId = authoredArtifactId(
      workspaceId,
      request.administrationThreadId,
      request.requestId
    );
    const existingAuthored = findArtifact(dependencies.store, workspaceId, authoredId);
    if (existingAuthored) {
      const artifact = requireTurnOutputArtifact(existingAuthored, 'authored');
      const existingBody = parseCandidateBody(
        artifact,
        WorkerEnvironmentAuthoredCandidateArtifactSchema,
        'authored'
      );
      if (
        artifact.origin.requestId !== request.requestId ||
        !sameAuthoredRequest(existingBody, request, declaration)
      ) {
        throw new IdempotencyKeyConflictError();
      }
      requirePrivateHome(context.actor, workspaceId, artifact);
      const existingResolved = findArtifact(
        dependencies.store,
        workspaceId,
        resolvedArtifactId(candidateRef(artifact))
      );
      if (existingResolved) {
        const pair = readCandidatePair(context.actor, candidateRef(existingResolved));
        return responseFromCandidate(
          request.requestId,
          pair.authoredCandidate,
          pair.resolvedCandidate,
          existingResolved.createdAt,
          pair.resolved
        );
      }
      throw recoveryRequired(
        'The authored candidate exists without a resolved candidate; use explicit recovery.'
      );
    }

    const manifest = readWorkerEnvironmentTargetManifest(
      dependencies.configFilesForActor(context.actor),
      { configuration: request.configuration, target: request.target }
    );
    if (JSON.stringify(manifest.runtime.image) === JSON.stringify(declaration)) {
      throw new WorkerEnvironmentOperationError(
        'invalid_request',
        'Agent configuration already contains the requested image declaration.'
      );
    }
    const affectedStorage = currentAffectedStorage(context.actor, request);
    const authored = WorkerEnvironmentAuthoredCandidateArtifactSchema.parse({
      affectedStorage,
      configuration: request.configuration,
      declaration,
      kind: 'worker-environment-authored-candidate',
      replaceNow: request.replaceNow,
      schemaVersion: 1,
      target: request.target,
    });
    const turn = resolvePublicationTurn(context, {
      causationId: null,
      requestId: request.requestId,
      threadId: request.administrationThreadId,
      workspaceId,
    });
    return runWithPublicationTurn(context, turn, async () => {
      const authoredArtifact = requireTurnOutputArtifact(
        createCandidateArtifact({
          body: authored,
          id: authoredId,
          requestId: request.requestId,
          threadId: turn.threadId,
          title: `Authored environment for ${request.target.agentId}`,
          turnId: turn.id,
          workspaceId,
          timestamp: now(),
        }),
        'authored'
      );
      dependencies.requireCurrentAdministrator(context.actor);
      requirePrivateHome(context.actor, workspaceId, authoredArtifact);
      dependencies.store.createArtifact(authoredArtifact);
      return prepareAndPublish(
        context,
        request.requestId,
        workspaceId,
        authoredArtifact,
        authored,
        turn
      );
    });
  }

  async function executeRecovery(
    context: WorkerEnvironmentPreparationContext,
    request: Extract<PrepareWorkerEnvironmentRequest, { readonly mode: 'recover' }>,
    workspaceId: string
  ): Promise<PrepareWorkerEnvironmentResponse> {
    const authoredArtifact = requireCandidateArtifact(
      dependencies.store,
      workspaceId,
      request.recoverFrom,
      'authored'
    );
    requirePrivateHome(context.actor, workspaceId, authoredArtifact);
    const authored = parseCandidateBody(
      authoredArtifact,
      WorkerEnvironmentAuthoredCandidateArtifactSchema,
      'authored'
    );
    if (authoredArtifact.origin.requestId === request.requestId) {
      throw new WorkerEnvironmentOperationError(
        'invalid_request',
        'Recovery requires a fresh request id distinct from the authored request.'
      );
    }
    const resolvedId = resolvedArtifactId(request.recoverFrom);
    const existingResolved = findArtifact(dependencies.store, workspaceId, resolvedId);
    if (existingResolved) {
      const pair = readCandidatePair(context.actor, candidateRef(existingResolved));
      return responseFromCandidate(
        request.requestId,
        pair.authoredCandidate,
        pair.resolvedCandidate,
        existingResolved.createdAt,
        pair.resolved
      );
    }

    requireRecoverableSourceTurn(context, workspaceId, authoredArtifact);
    requireCurrentBaseline(context.actor, authored);
    const turn = resolvePublicationTurn(context, {
      causationId: authoredArtifact.origin.requestId,
      requestId: request.requestId,
      threadId: request.administrationThreadId,
      workspaceId,
    });
    return runWithPublicationTurn(context, turn, async () => {
      const runtimeImage = materializeRuntimeImage(authored.declaration);
      try {
        await dependencies.runtimeEffects.recoverImageEffect({
          candidate: request.recoverFrom,
          image: runtimeImage,
          operation: runtimeImage.kind === 'build' ? 'image.build' : 'image.acquire',
        });
      } catch (error) {
        if (error instanceof WorkerEnvironmentOperationError) throw error;
        throw recoveryRequired(
          error instanceof Error ? error.message : 'Prepared image settlement is unavailable.'
        );
      }
      return prepareAndPublish(
        context,
        request.requestId,
        workspaceId,
        authoredArtifact,
        authored,
        turn
      );
    });
  }

  async function prepareAndPublish(
    context: WorkerEnvironmentPreparationContext,
    publicationRequestId: string,
    workspaceId: string,
    authoredArtifact: TurnOutputCandidateArtifact,
    authored: WorkerEnvironmentAuthoredCandidateArtifact,
    publicationTurn: ReturnType<FsStore['getTurn']>
  ): Promise<PrepareWorkerEnvironmentResponse> {
    const authoredRef = candidateRef(authoredArtifact);
    requirePrivateTurn(
      context.actor,
      workspaceId,
      publicationTurn.threadId,
      publicationTurn.id,
      true
    );
    let image: PreparedWorkerEnvironmentImage;
    try {
      image = await dependencies.runtimeEffects.prepareImage({
        authorize: () => {
          try {
            dependencies.requireCurrentAdministrator(context.actor);
            requirePrivateHome(context.actor, workspaceId, authoredArtifact);
            requirePrivateTurn(
              context.actor,
              workspaceId,
              publicationTurn.threadId,
              publicationTurn.id,
              true
            );
            return true;
          } catch {
            return false;
          }
        },
        candidate: authoredRef,
        image: materializeRuntimeImage(authored.declaration),
      });
    } catch (error) {
      dependencies.requireCurrentAdministrator(context.actor);
      requirePrivateHome(context.actor, workspaceId, authoredArtifact);
      requirePrivateTurn(
        context.actor,
        workspaceId,
        publicationTurn.threadId,
        publicationTurn.id,
        true
      );
      if (error instanceof WorkerEnvironmentOperationError) throw error;
      throw new WorkerEnvironmentOperationError(
        'effect_failed',
        error instanceof Error ? error.message : 'Worker image preparation failed.'
      );
    }

    dependencies.requireCurrentAdministrator(context.actor);
    requirePrivateHome(context.actor, workspaceId, authoredArtifact);
    requirePrivateTurn(
      context.actor,
      workspaceId,
      publicationTurn.threadId,
      publicationTurn.id,
      true
    );
    requireCurrentBaseline(context.actor, authored);
    const resolvedBody = WorkerEnvironmentResolvedCandidateArtifactSchema.parse({
      affectedStorage: authored.affectedStorage,
      authoredCandidate: authoredRef,
      configuration: authored.configuration,
      image: imageInspection(image),
      kind: 'worker-environment-resolved-candidate',
      replaceNow: authored.replaceNow,
      schemaVersion: 1,
      target: authored.target,
    });
    const resolvedArtifact = createCandidateArtifact({
      body: resolvedBody,
      id: resolvedArtifactId(authoredRef),
      requestId: publicationRequestId,
      threadId: publicationTurn.threadId,
      title: `Resolved environment for ${authored.target.agentId}`,
      turnId: publicationTurn.id,
      workspaceId,
      timestamp: now(),
    });
    dependencies.store.createArtifact(resolvedArtifact);
    if (!context.administrationTurnId && publicationTurn.status === 'running') {
      dependencies.store.updateTurn(publicationTurn.id, {
        completedAt: resolvedArtifact.createdAt,
        status: 'completed',
      });
    }
    return responseFromCandidate(
      publicationRequestId,
      authoredRef,
      candidateRef(resolvedArtifact),
      resolvedArtifact.createdAt,
      resolvedBody
    );
  }

  function resolvePublicationTurn(
    context: WorkerEnvironmentPreparationContext,
    input: {
      readonly causationId: string | null;
      readonly requestId: string;
      readonly threadId: string;
      readonly workspaceId: string;
    }
  ): ReturnType<FsStore['getTurn']> {
    if (context.administrationTurnId) {
      const turn = requireRunningAdministrationTurn(
        dependencies.store,
        input.workspaceId,
        input.threadId,
        context.administrationTurnId
      );
      requirePrivateTurn(context.actor, input.workspaceId, input.threadId, turn.id, true);
      return turn;
    }
    const turnId = preparationTurnId(context.actor.userId, input.threadId, input.requestId);
    const existing = dependencies.store
      .listThreadTurns(input.workspaceId, input.threadId)
      .find((turn) => turn.id === turnId);
    if (existing) {
      throw recoveryRequired('Preparation has partial durable Turn state without its candidate.');
    }
    requirePrivateTurn(context.actor, input.workspaceId, input.threadId, turnId, false);
    requireNoRunningTurn(dependencies.store, input.workspaceId, input.threadId);
    const turn = dependencies.store.createTurn(
      input.workspaceId,
      input.threadId,
      'Prepare Worker environment',
      { kind: 'user', id: context.actor.userId },
      null,
      { turnId, startedAt: now() }
    );
    dependencies.store.createItem({
      ...(input.causationId ? { causationId: input.causationId } : {}),
      completedAt: turn.startedAt,
      createdAt: turn.startedAt ?? now(),
      id: `it_worker_environment_prepare_${stableSuffix([turn.id])}`,
      level: 'info',
      status: 'completed',
      summary: 'Worker environment preparation request accepted.',
      threadId: input.threadId,
      title: 'Preparing Worker environment',
      turnId: turn.id,
      type: 'status',
      workspaceId: input.workspaceId,
    });
    return turn;
  }

  async function runWithPublicationTurn<T>(
    context: WorkerEnvironmentPreparationContext,
    turn: ReturnType<FsStore['getTurn']>,
    run: () => Promise<T>
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!context.administrationTurnId) {
        const current = dependencies.store.getTurn(turn.workspaceId, turn.threadId, turn.id);
        if (current.status === 'running') {
          dependencies.store.updateTurn(current.id, { completedAt: now(), status: 'failed' });
        }
      }
      throw error;
    }
  }

  function requireRecoverableSourceTurn(
    context: WorkerEnvironmentPreparationContext,
    workspaceId: string,
    authoredArtifact: TurnOutputCandidateArtifact
  ): void {
    const sourceTurn = dependencies.store.getTurn(
      workspaceId,
      authoredArtifact.origin.threadId,
      authoredArtifact.origin.turnId
    );
    const sourceIsCurrentInternalTurn =
      context.administrationTurnId === sourceTurn.id && sourceTurn.status === 'running';
    if (
      !sourceIsCurrentInternalTurn &&
      !['completed', 'failed', 'interrupted', 'cancelled'].includes(sourceTurn.status)
    ) {
      throw new WorkerEnvironmentOperationError(
        'thread_busy',
        'The authored candidate Turn must be terminal before recovery on another Turn.'
      );
    }
  }

  function requireCurrentBaseline(
    actor: Actor,
    authored: WorkerEnvironmentAuthoredCandidateArtifact
  ): void {
    readWorkerEnvironmentTargetManifest(dependencies.configFilesForActor(actor), {
      configuration: authored.configuration,
      target: authored.target,
    });
    const current = currentAffectedStorage(actor, authored);
    if (JSON.stringify(current) !== JSON.stringify(authored.affectedStorage)) {
      throw new WorkerEnvironmentOperationError(
        'revision_conflict',
        'Affected Worker environment revisions changed during preparation.'
      );
    }
  }

  function currentAffectedStorage(
    actor: Actor,
    input: Pick<
      WorkerEnvironmentAuthoredCandidateArtifact,
      'configuration' | 'replaceNow' | 'target'
    >
  ) {
    return canonicalAffectedStorage(
      dependencies.deriveAffectedStorage({
        actor,
        configuration: input.configuration,
        replaceNow: input.replaceNow,
        target: input.target,
      })
    );
  }
}

/** Requires one administration Thread from the server-derived private Workspace. */
function requireAdministrationThread(store: FsStore, workspaceId: string, threadId: string): void {
  try {
    const workspace = store.getWorkspace(workspaceId);
    const thread = store.getThread(workspaceId, threadId);
    if (workspace.kind !== 'quick-chat' || thread.entryPath !== 'administration') throw new Error();
  } catch {
    throw new WorkerEnvironmentOperationError('not_found', 'Administration Thread was not found.');
  }
}

/** Requires the actual current private administration Turn used by the internal Assistant. */
function requireRunningAdministrationTurn(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  turnId: string
): ReturnType<FsStore['getTurn']> {
  let turn: ReturnType<FsStore['getTurn']>;
  try {
    turn = store.getTurn(workspaceId, threadId, turnId);
  } catch {
    throw new WorkerEnvironmentOperationError('not_found', 'Administration Turn was not found.');
  }
  if (turn.status !== 'running') {
    throw new WorkerEnvironmentOperationError(
      'thread_busy',
      'Administration Turn is not currently running.'
    );
  }
  return turn;
}

/** Rejects a direct preparation while any work still owns the selected Thread. */
function requireNoRunningTurn(store: FsStore, workspaceId: string, threadId: string): void {
  const busy = store
    .listThreadTurns(workspaceId, threadId)
    .some((turn) => !['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status));
  if (busy) {
    throw new WorkerEnvironmentOperationError(
      'thread_busy',
      'Administration Thread already has active work.'
    );
  }
}

/** Materializes the authored manifest image into the content-addressed runtime effect shape. */
function materializeRuntimeImage(
  image: WorkerEnvironmentAuthoredCandidateArtifact['declaration']
): RuntimeImage {
  if (image.kind === 'reference') return image;
  const argumentsJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(image.arguments).sort(([left], [right]) => left.localeCompare(right))
    )
  );
  return {
    ...image,
    argumentsDigest: digest(argumentsJson),
    input: { ...image.input, digest: digest(image.input.content) },
  };
}

/** Creates one exact immutable JSON Artifact. */
function createCandidateArtifact(input: {
  readonly body:
    | WorkerEnvironmentAuthoredCandidateArtifact
    | WorkerEnvironmentResolvedCandidateArtifact;
  readonly id: string;
  readonly requestId: string;
  readonly threadId: string;
  readonly timestamp: string;
  readonly title: string;
  readonly turnId: string;
  readonly workspaceId: string;
}): CandidateArtifact {
  const body = JSON.stringify(input.body);
  return {
    content: { body, format: 'json' },
    contentDigest: digest(body),
    createdAt: input.timestamp,
    id: input.id,
    kind: 'report',
    lastMutationRequestId: input.requestId,
    origin: {
      kind: 'turn-output',
      requestId: input.requestId,
      threadId: input.threadId,
      turnId: input.turnId,
    },
    status: 'ready',
    summary: null,
    threadId: input.threadId,
    title: input.title,
    turnId: input.turnId,
    updatedAt: input.timestamp,
    version: 1,
    workspaceId: input.workspaceId,
  };
}

/** Reads an exact immutable candidate reference without disclosing foreign private artifacts. */
function requireCandidateArtifact(
  store: FsStore,
  workspaceId: string,
  ref: WorkerEnvironmentCandidateRef,
  label: 'authored' | 'resolved'
): TurnOutputCandidateArtifact {
  const artifact = requireArtifactById(store, workspaceId, ref.artifactId);
  if (
    artifact.version !== ref.artifactVersion ||
    artifact.contentDigest !== ref.contentDigest ||
    artifact.status !== 'ready' ||
    artifact.kind !== 'report' ||
    artifact.content.format !== 'json'
  ) {
    throw candidateConflict(`${label} candidate identity is inconsistent.`);
  }
  return requireTurnOutputArtifact(artifact, label);
}

/** Reads one Artifact by private Workspace and maps absence to non-disclosure. */
function requireArtifactById(
  store: FsStore,
  workspaceId: string,
  artifactId: string
): CandidateArtifact {
  try {
    return store.getArtifact(workspaceId, artifactId);
  } catch {
    throw new WorkerEnvironmentOperationError('not_found', 'Preparation candidate was not found.');
  }
}

/** Narrows one candidate to required Turn-output provenance. */
function requireTurnOutputArtifact(
  artifact: CandidateArtifact,
  label: string
): TurnOutputCandidateArtifact {
  if (artifact.origin.kind !== 'turn-output') {
    throw candidateConflict(`${label} candidate provenance is inconsistent.`);
  }
  return artifact as TurnOutputCandidateArtifact;
}

/** Parses canonical candidate JSON and rejects alternate byte encodings. */
function parseCandidateBody<T>(
  artifact: CandidateArtifact,
  schema: z.ZodType<T>,
  label: string
): T {
  let value: unknown;
  try {
    value = JSON.parse(artifact.content.body);
  } catch {
    throw candidateConflict(`${label} candidate content is invalid.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success || JSON.stringify(parsed.data) !== artifact.content.body) {
    throw candidateConflict(`${label} candidate content is invalid.`);
  }
  return parsed.data;
}

/** Converts one stored immutable Artifact to its bounded public identity. */
function candidateRef(artifact: CandidateArtifact): WorkerEnvironmentCandidateRef {
  return { artifactId: artifact.id, artifactVersion: 1, contentDigest: artifact.contentDigest };
}

/** Projects host image facts into the public inspection contract. */
function imageInspection(image: PreparedWorkerEnvironmentImage) {
  const { platform, ...storageLayout } = image.layout;
  return { digest: image.imageDigest, platform, storageLayout };
}

/** Returns one fully parsed preparation response. */
function responseFromCandidate(
  requestId: string,
  authoredCandidate: WorkerEnvironmentCandidateRef,
  resolvedCandidate: WorkerEnvironmentCandidateRef,
  preparedAt: string,
  resolved: WorkerEnvironmentResolvedCandidateArtifact
): PrepareWorkerEnvironmentResponse {
  return PrepareWorkerEnvironmentResponseSchema.parse({
    activationConfirmation: workerEnvironmentActivationConfirmation({
      affectedStorage: resolved.affectedStorage,
      configuration: resolved.configuration,
      replaceNow: resolved.replaceNow,
      resolvedCandidate,
      target: resolved.target,
    }),
    affectedStorage: resolved.affectedStorage,
    authoredCandidate,
    configuration: resolved.configuration,
    image: resolved.image,
    preparedAt,
    replaceNow: resolved.replaceNow,
    requestId,
    resolvedCandidate,
    target: resolved.target,
  });
}

/** Compares the request-controlled authored candidate fields. */
function sameAuthoredRequest(
  authored: WorkerEnvironmentAuthoredCandidateArtifact,
  request: Extract<PrepareWorkerEnvironmentRequest, { readonly mode: 'prepare' }>,
  declaration: WorkerEnvironmentAuthoredCandidateArtifact['declaration']
): boolean {
  return (
    JSON.stringify({
      configuration: authored.configuration,
      declaration: authored.declaration,
      replaceNow: authored.replaceNow,
      target: authored.target,
    }) ===
    JSON.stringify({
      configuration: request.configuration,
      declaration,
      replaceNow: request.replaceNow,
      target: request.target,
    })
  );
}

/** Revalidates the browser-safe declaration with the authoritative Server Agent schema. */
function requireExactAuthoredImage(
  declaration: WorkerEnvironmentAuthoredCandidateArtifact['declaration']
): WorkerEnvironmentAuthoredCandidateArtifact['declaration'] {
  const parsed = AuthoredAgentRuntimeSchema.shape.image.safeParse(declaration);
  if (!parsed.success) {
    throw new WorkerEnvironmentOperationError(
      'invalid_request',
      'Worker image declaration does not satisfy the Server Agent configuration contract.'
    );
  }
  return parsed.data;
}

/** Compares baseline facts copied from A into B. */
function sameCandidateBaseline(
  authored: WorkerEnvironmentAuthoredCandidateArtifact,
  resolved: WorkerEnvironmentResolvedCandidateArtifact
): boolean {
  return (
    JSON.stringify({
      affectedStorage: resolved.affectedStorage,
      configuration: resolved.configuration,
      replaceNow: resolved.replaceNow,
      target: resolved.target,
    }) ===
    JSON.stringify({
      affectedStorage: authored.affectedStorage,
      configuration: authored.configuration,
      replaceNow: authored.replaceNow,
      target: authored.target,
    })
  );
}

/** Sorts and copies affected storage to make candidate bytes deterministic. */
function canonicalAffectedStorage(
  values: readonly { readonly expectedRevision: number; readonly storageRef: string }[]
) {
  const sorted = values
    .map((value) => ({ ...value }))
    .sort((left, right) => left.storageRef.localeCompare(right.storageRef));
  if (new Set(sorted.map((value) => value.storageRef)).size !== sorted.length) {
    throw candidateConflict('Affected Worker environment identities must be unique.');
  }
  return sorted;
}

/** Finds an Artifact without treating ordinary absence as corruption. */
function findArtifact(store: FsStore, workspaceId: string, artifactId: string) {
  return store.listArtifacts(workspaceId).find((artifact) => artifact.id === artifactId) ?? null;
}

/** Deterministic authored Artifact identity bound to the direct command lineage. */
function authoredArtifactId(workspaceId: string, threadId: string, requestId: string): string {
  return `ar_worker_environment_authored_${stableSuffix([workspaceId, threadId, requestId])}`;
}

/** Deterministic resolved Artifact identity bound only to its immutable authored candidate. */
function resolvedArtifactId(authored: WorkerEnvironmentCandidateRef): string {
  return `ar_worker_environment_resolved_${stableSuffix([
    authored.artifactId,
    authored.artifactVersion,
    authored.contentDigest,
  ])}`;
}

/** Deterministic direct administration Turn identity for one preparation request. */
function preparationTurnId(userId: string, threadId: string, requestId: string): string {
  return `tu_worker_environment_${stableSuffix([userId, threadId, requestId])}`;
}

/** Stable bounded lowercase identifier suffix. */
function stableSuffix(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, 24);
}

/** Exact lowercase SHA-256 digest of canonical content bytes. */
function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Creates one stable candidate-integrity failure. */
function candidateConflict(message: string): WorkerEnvironmentOperationError {
  return new WorkerEnvironmentOperationError('candidate_conflict', message);
}

/** Creates one stable incomplete-preparation failure. */
function recoveryRequired(message: string): WorkerEnvironmentOperationError {
  return new WorkerEnvironmentOperationError('recovery_required', message);
}

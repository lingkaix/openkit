import { createHash, randomUUID } from 'node:crypto';

import {
  type ApplyAdministrationConfigurationRequest,
  ApplyAdministrationConfigurationRequestSchema,
  type ApplyAdministrationConfigurationResponse,
  ApplyAdministrationConfigurationResponseSchema,
  ApplyDelegatedAdministrationConfigurationRequestSchema,
  ConfigurationCandidateArtifactSchema,
  type ProposeAdministrationConfigurationRequest,
  ProposeAdministrationConfigurationRequestSchema,
} from '@openkit/app-api-schemas';
import {
  GatewayConfigSchema,
  GatewayLogicalModelSchema,
  ProviderModelMetadataSchema,
  ProviderProfileSchema,
} from '@openkit/config-schema';
import { z } from 'zod';

import { recordServerAuditEvent } from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import { requireCurrentDeploymentAdmin } from '../auth/operation-authorizer.js';
import {
  CONFIGURATION_APPLY_PENDING_DELAYED_USER_INPUT_ADMISSION,
  type FsStore,
  quickChatWorkspaceIdForUser,
} from '../lib/store.js';
import { recordPermissionDecision } from '../policy/permission-decisions.js';
import { evaluateWorkerGitReadMaintenance } from '../policy/worker-git-read-maintenance.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { parseJsoncObject } from './jsonc.js';
import type { RuntimeConfigManager, RuntimeConfigSnapshot } from './runtime-config.js';
import {
  type RuntimeConfigFileService,
  RuntimeConfigFileServiceError,
} from './runtime-config-files.js';
import { prepareWorkerGitReadCorrection } from './worker-git-read-correction.js';

const providerChanges = z
  .object({
    displayName: z.string().min(1).optional(),
    models: z.array(z.string().min(1)).min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    modelMetadata: ProviderModelMetadataSchema.optional(),
  })
  .strict();
const gatewayChanges = z
  .object({
    logicalModels: z.array(GatewayLogicalModelSchema).optional(),
    defaultLogicalModelId: z.string().min(1).optional(),
  })
  .strict();

/** Shared private catalog candidate dependencies; the file service remains the only writer. */
export interface AdministrationConfigurationOptions {
  readonly actor: Actor;
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly files: Pick<
    RuntimeConfigFileService,
    'listFiles' | 'readFile' | 'validate' | 'updateFile'
  >;
  readonly reload: () => ReturnType<RuntimeConfigManager['reload']>;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
}

/** Creates bounded catalog observation, immutable proposal and human application operations. */
export function createAdministrationConfiguration(options: AdministrationConfigurationOptions) {
  const { actor, coreDb, store, files } = options;
  const workspaceId = quickChatWorkspaceIdForUser(actor.userId);

  /** Authorizes the current user's exact private administration home before observing artifacts. */
  function requireHome(threadId: string, turnId?: string): void {
    requireCurrentDeploymentAdmin(coreDb, actor);
    const workspace = store.getWorkspace(workspaceId);
    const thread = store.getThread(workspaceId, threadId);
    if (workspace.kind !== 'personal' || thread.entryPath !== 'administration')
      fail('configuration_target_not_found');
    if (turnId) store.getTurn(workspaceId, threadId, turnId);
  }

  /** Resolves an existing target by registered identity, never by a caller-selected path. */
  function source(targetFamily: 'provider' | 'gateway', targetId: string) {
    const matches = files
      .listFiles()
      .files.filter((file) => file.kind === targetFamily)
      .flatMap((file) => {
        const read = files.readFile(file.id);
        const parsed = parseJsoncObject(read.content, file.id);
        const value =
          targetFamily === 'provider'
            ? ProviderProfileSchema.parse(parsed)
            : GatewayConfigSchema.parse(parsed);
        const id = targetFamily === 'provider' ? (value as { id: string }).id : 'gateway';
        return id === targetId ? [{ read, value }] : [];
      });
    if (matches.length !== 1) fail('configuration_target_not_found');
    return matches[0]!;
  }

  /** Validates one exact revision and merged candidate using the existing whole-config loader. */
  function prepare(request: ProposeAdministrationConfigurationRequest) {
    if (request.targetFamily === 'agent') {
      const prepared = prepareWorkerGitReadCorrection({
        request,
        actor,
        coreDb,
        store,
        files,
        snapshot: options.runtimeConfig(),
        repositoryWorkspaceDb: options.repositoryWorkspaceDb,
      });
      const validation = files.validate({
        files: [{ id: prepared.current.read.file.id, content: prepared.content }],
        mode: 'safe',
      });
      if (!validation.valid) fail('configuration_validation_failed');
      return { ...prepared, restartRequired: validation.plan.requiresRestart.length > 0 };
    }
    const current = source(request.targetFamily, request.targetId);
    if (current.read.file.revision !== request.expectedRevision) fail('config_revision_conflict');
    const changes = changeSchema(request.targetFamily).parse(request.changes);
    if (Object.keys(changes).length === 0) fail('configuration_changes_required');
    const merged = { ...current.value, ...changes };
    const normalized =
      request.targetFamily === 'provider'
        ? ProviderProfileSchema.parse(merged)
        : GatewayConfigSchema.parse(merged);
    // The loader permits unavailable routes for diagnostics; proposal admission requires resolvable bindings.
    const gateway =
      request.targetFamily === 'gateway'
        ? GatewayConfigSchema.parse(normalized)
        : GatewayConfigSchema.parse(source('gateway', 'gateway').value);
    for (const model of gateway.logicalModels) {
      for (const route of model.routes) {
        const provider =
          request.targetFamily === 'provider' && route.providerProfileId === request.targetId
            ? ProviderProfileSchema.parse(normalized)
            : ProviderProfileSchema.parse(source('provider', route.providerProfileId).value);
        if (!provider.models.includes(route.providerModel))
          fail('configuration_dependency_unavailable');
      }
    }
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    const validation = files.validate({
      files: [{ id: current.read.file.id, content }],
      mode: 'safe',
    });
    if (!validation.valid) fail('configuration_validation_failed');
    return {
      current,
      changes,
      content,
      after: project(request.targetFamily, normalized),
      restartRequired: validation.plan.requiresRestart.length > 0,
    };
  }

  /** Stores and presents immutable JSON with existing Artifact and Item authority. */
  function publish(
    body: unknown,
    threadId: string,
    turnId: string,
    requestId: string,
    id = `artifact_configuration_${randomUUID()}`
  ) {
    const timestamp = new Date().toISOString();
    const text = JSON.stringify(body);
    const artifact = store.createArtifact({
      id,
      workspaceId,
      threadId,
      turnId,
      kind: 'report',
      status: 'ready',
      version: 1,
      title: 'Configuration candidate and outcome',
      summary: null,
      content: { body: text, format: 'json' },
      contentDigest: digest(text),
      origin: { kind: 'turn-output', threadId, turnId, requestId },
      lastMutationRequestId: requestId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return {
      artifactId: artifact.id,
      artifactVersion: 1 as const,
      contentDigest: artifact.contentDigest,
    };
  }

  /** Applies one exact candidate through the shared receipt and sole file writer. */
  async function applyCandidate(
    request:
      | ApplyAdministrationConfigurationRequest
      | z.infer<typeof ApplyDelegatedAdministrationConfigurationRequestSchema>,
    invocation?: { threadId: string; turnId: string; signal?: AbortSignal }
  ): Promise<ApplyAdministrationConfigurationResponse> {
    requireCurrentDeploymentAdmin(coreDb, actor);
    const artifact = store.getArtifact(workspaceId, request.candidate.artifactId);
    if (artifact.origin.kind !== 'turn-output') fail('configuration_candidate_conflict');
    const { threadId } = artifact.origin;
    const turnId = invocation?.turnId ?? artifact.origin.turnId;
    if (invocation && invocation.threadId !== threadId) fail('configuration_candidate_conflict');
    requireHome(artifact.origin.threadId, artifact.origin.turnId);
    if (invocation?.signal?.aborted) fail('configuration_cancelled');
    requireHome(threadId, turnId);
    if (
      artifact.version !== 1 ||
      artifact.contentDigest !== request.candidate.contentDigest ||
      digest(artifact.content.body) !== artifact.contentDigest
    )
      fail('configuration_candidate_conflict');
    const body = ConfigurationCandidateArtifactSchema.parse(JSON.parse(artifact.content.body));
    if (invocation && body.targetFamily !== 'agent') fail('configuration_delegation_required');
    const outcomeId = `artifact_configuration_result_${digest(JSON.stringify({ userId: actor.userId, request })).slice(7)}`;
    return runIdempotentCommand({
      store,
      inflightCommands: options.inflightCommands,
      command: 'administration.configuration.apply',
      requestId: request.requestId,
      scope: { actorId: actor.userId, workspaceId, threadId },
      input: request,
      responseKind: 'artifact',
      responseId: () => outcomeId,
      replay: (record) => {
        const outcome = store.getArtifact(workspaceId, record.response.id);
        if (
          record.response.id !== outcomeId ||
          outcome.version !== 1 ||
          digest(outcome.content.body) !== outcome.contentDigest
        )
          fail('configuration_recovery_required');
        const result = ApplyAdministrationConfigurationResponseSchema.parse(
          JSON.parse(outcome.content.body)
        );
        if (JSON.stringify(result.candidate) !== JSON.stringify(request.candidate))
          fail('configuration_recovery_required');
        return result;
      },
      execute: () => {
        requireHome(threadId, turnId);
        const markerId = `it_configuration_apply_${digest(JSON.stringify({ actorId: actor.userId, requestId: request.requestId })).slice(7)}`;
        if (store.listThreadItems(workspaceId, threadId).some((item) => item.id === markerId))
          fail('configuration_recovery_required');
        const prepared = prepare(body);
        if (
          JSON.stringify(prepared.after) !== JSON.stringify(body.after) ||
          prepared.restartRequired !== body.restartRequired
        )
          fail('configuration_candidate_conflict');
        if (
          body.targetFamily === 'agent' &&
          (!('failureEvidence' in prepared) ||
            JSON.stringify(prepared.failureEvidence) !== JSON.stringify(body.failureEvidence))
        )
          fail('configuration_candidate_conflict');
        let permissionDecisionId: string | null = null;
        if (invocation) {
          if (
            !('failureEvidence' in prepared) ||
            body.targetFamily !== 'agent' ||
            JSON.stringify(prepared.failureEvidence) !== JSON.stringify(body.failureEvidence)
          )
            fail('configuration_candidate_conflict');
          requireHome(invocation.threadId, invocation.turnId);
          if (
            store.getTurn(workspaceId, invocation.threadId, invocation.turnId).status !==
              'running' ||
            invocation.signal?.aborted
          )
            fail('configuration_cancelled');
          const snapshot = options.runtimeConfig();
          const now = new Date();
          const decision = evaluateWorkerGitReadMaintenance(
            snapshot.openKitConfig.policy?.workerGitReadMaintenance ?? [],
            { ...prepared.facts, now }
          );
          permissionDecisionId = randomUUID();
          recordPermissionDecision({
            coreDb,
            decisionId: permissionDecisionId,
            ownerScope: 'server',
            policyDecision: decision,
            policyEngineVersion: 'nanocore-worker-git-read-maintenance:v1',
            policySnapshotId: snapshot.contentHash,
            subjectSummary: { userId: actor.userId },
            action: body.command,
            resourceSummary: { targetFamily: 'agent', targetId: body.targetId, scope: 'server' },
            contextSummary: {
              threadId,
              turnId,
              requestId: request.requestId,
              candidate: request.candidate,
              baseRevision: body.expectedRevision,
              failure: body.failure,
              failureEvidence: body.failureEvidence,
              purpose: 'git-read',
              configVersion: snapshot.version,
              configContentHash: snapshot.contentHash,
              entry: 'administration',
              effectScope: 'server',
              effectFacts: prepared.facts,
              assignments: (snapshot.openKitConfig.policy?.workerGitReadMaintenance ?? []).filter(
                (entry) =>
                  entry.responsibleUserId === actor.userId &&
                  entry.agentId === body.targetId &&
                  entry.networkGrantId === prepared.facts.networkGrantId
              ),
            },
            enforcementPoint: 'administration.configuration.apply',
            auditActor: { kind: 'user', id: actor.userId },
            now,
          });
          if (decision.effect !== 'allow') fail('configuration_delegation_required');
        }
        const timestamp = new Date().toISOString();
        store.createItem(
          {
            id: markerId,
            workspaceId,
            threadId,
            turnId,
            type: 'status',
            status: 'completed',
            level: 'info',
            title: 'Configuration application started',
            summary: `Request ${request.requestId} admitted candidate ${request.candidate.contentDigest}.`,
            createdAt: timestamp,
            completedAt: timestamp,
          },
          CONFIGURATION_APPLY_PENDING_DELAYED_USER_INPUT_ADMISSION
        );
        let persisted = false;
        let revision: string | null = null;
        let reload: ApplyAdministrationConfigurationResponse['reload'] = 'not-attempted';
        let restartRequired = body.restartRequired;
        try {
          requireCurrentDeploymentAdmin(coreDb, actor);
          const written = files.updateFile({
            id: prepared.current.read.file.id,
            kind: body.targetFamily,
            content: prepared.content,
            expectedRevision: body.expectedRevision,
          });
          persisted = true;
          revision = written.file.revision;
          reload = 'failed';
          const result = options.reload();
          reload = result.status === 'dry-run' ? 'failed' : result.status;
          restartRequired = result.plan.requiresRestart.length > 0;
        } catch {
          // An interrupted write has no verified result; its start Item fences retries.
          if (!persisted) fail('configuration_recovery_required');
        }
        const result = ApplyAdministrationConfigurationResponseSchema.parse({
          candidate: request.candidate,
          persisted,
          revision,
          reload,
          restartRequired,
        });
        recordServerAuditEvent({
          coreDb,
          actor: { kind: 'user', id: actor.userId },
          requestId: request.requestId,
          ...(permissionDecisionId ? { permissionDecisionId } : {}),
          action: body.command,
          category: 'system',
          resource: `${body.targetFamily}:${body.targetId}`,
          outcome: persisted && reload === 'applied' ? 'succeeded' : 'failed',
          summary: `Candidate ${request.candidate.contentDigest}; base ${body.expectedRevision}; persisted ${persisted}; reload ${reload}; restart required ${restartRequired}.`,
        });
        publish(result, threadId, turnId, request.requestId, outcomeId);
        return result;
      },
    });
  }

  return {
    /** Reads only editable, non-secret catalog fields and exact source revisions. */
    read(targetFamily: 'provider' | 'gateway', targetId?: string) {
      requireCurrentDeploymentAdmin(coreDb, actor);
      if (!targetId) {
        return {
          targetFamily,
          targets: files
            .listFiles()
            .files.filter((file) => file.kind === targetFamily)
            .map((file) => {
              const read = files.readFile(file.id);
              const parsed = parseJsoncObject(read.content, file.id);
              return {
                targetId:
                  targetFamily === 'gateway' ? 'gateway' : ProviderProfileSchema.parse(parsed).id,
                expectedRevision: read.file.revision,
              };
            }),
        };
      }
      const current = source(targetFamily, targetId);
      return {
        targetFamily,
        targetId,
        expectedRevision: current.read.file.revision,
        configuration: project(targetFamily, current.value),
      };
    },
    /** Returns only editable fields derived from the registered schema owner. */
    schema(targetFamily: 'provider' | 'gateway') {
      requireCurrentDeploymentAdmin(coreDb, actor);
      return {
        targetFamily,
        schema: z.toJSONSchema(changeSchema(targetFamily), {
          override: ({ zodSchema, jsonSchema }) => {
            if (!(zodSchema instanceof z.ZodObject)) return;
            // The administration schema advertises editable fields, not excluded carriers.
            // Admission still rejects these fields, and output objects remain closed.
            for (const [name, field] of Object.entries(zodSchema.shape)) {
              if (field instanceof z.ZodOptional && field.unwrap() instanceof z.ZodNever)
                delete jsonSchema.properties?.[name];
            }
          },
        }),
        operation: 'update',
        excludedFields: ['credentials', 'extensions', 'endpoint', 'policy'],
      };
    },
    /** Proposes an exact catalog patch in an already admitted private administration Turn. */
    propose(unsafeRequest: unknown, home: { threadId: string; turnId: string; requestId: string }) {
      requireHome(home.threadId, home.turnId);
      const request = ProposeAdministrationConfigurationRequestSchema.parse(unsafeRequest);
      const prepared = prepare(request);
      const body = ConfigurationCandidateArtifactSchema.parse({
        ...request,
        changes: prepared.changes,
        kind: 'administration-configuration-candidate',
        before:
          'before' in prepared
            ? prepared.before
            : project(request.targetFamily as 'provider' | 'gateway', prepared.current.value),
        after: prepared.after,
        restartRequired: prepared.restartRequired,
        command: 'administration.configuration.apply',
        operation: 'update',
        ...('failureEvidence' in prepared ? { failureEvidence: prepared.failureEvidence } : {}),
      });
      const candidate = publish(body, home.threadId, home.turnId, home.requestId);
      return {
        candidate,
        preview: body,
        confirmation: { action: body.command, contentDigest: candidate.contentDigest },
      };
    },
    /** Applies one exact human-confirmed candidate through the native shared command. */
    async apply(unsafeRequest: ApplyAdministrationConfigurationRequest) {
      return applyCandidate(ApplyAdministrationConfigurationRequestSchema.parse(unsafeRequest));
    },
    /** Applies only a finite Worker candidate from a trusted current private invocation. */
    async applyDelegated(
      unsafeRequest: unknown,
      invocation: { threadId: string; turnId: string; signal?: AbortSignal }
    ) {
      return applyCandidate(
        ApplyDelegatedAdministrationConfigurationRequestSchema.parse(unsafeRequest),
        invocation
      );
    },
  };
}

/** Editable fields deliberately exclude secret references, account bindings and open extensions. */
function changeSchema(family: 'gateway' | 'provider') {
  return family === 'provider' ? providerChanges : gatewayChanges;
}
/** Projects only the catalog fields accepted by this entry, preserving private fields on disk. */
function project(family: 'gateway' | 'provider', value: object): Record<string, unknown> {
  const keys =
    family === 'provider'
      ? ['displayName', 'models', 'defaultModel', 'modelMetadata']
      : ['logicalModels', 'defaultLogicalModelId'];
  return Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
}
/** Computes the exact Artifact byte identity. */
function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
/** Emits a fixed, value-free failure so validation cannot disclose private source content. */
function fail(code: string): never {
  throw new RuntimeConfigFileServiceError(
    code,
    'Configuration request cannot be applied; inspect the current target and candidate.',
    409
  );
}

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeMaintenanceResponseSchema } from '@openkit/app-api-schemas';
import {
  type ActorRef,
  allocateEntityId,
  type Item,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import { auditAuthenticationFromActor } from '../auth/audit-attribution.js';
import type { Actor } from '../auth/identity.js';
import { requireAdministratorOperation } from '../auth/operation-authorizer.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import type { ServerKnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { internalContextDigest } from '../internal-agents/rolling-context.js';
import { createServerRunHistory } from '../internal-agents/server-history.js';
import type { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import {
  commandInputHash,
  type IdempotentCommandReceipt,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import { assertAgentWorkNotPaused } from '../security/agent-work-pause.js';
import { ControlKnowledgeAdmissionInputSchema } from '../storage/control-store-admission-codecs.js';
import { frameControlScalarText } from '../storage/control-store-input.js';
import type { CoreDb } from '../storage/db.js';
import {
  requireAppliedServerWork,
  serverWorkUnavailable,
  settleStagedServerWorkCommand,
  withServerWorkProducer,
} from '../storage/server-work-command.js';
import type { StorageResult } from '../storage/storage-owner.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import {
  createNotebookAgentEditing,
  NOTEBOOK_EDITING_LIMITS,
  notebookEditingDeadline,
} from './notebook-agent-editing.js';
import { notebookAuthoringGuidance } from './notebook-authoring-guidance.js';
import { boundedNotebookDiff } from './notebook-history.js';
import { publishNotebook } from './notebook-publication.js';
import {
  attributedNotebookPageBytes,
  parseOkfDocument,
  resolveRegisteredKnowledgeSourceReference,
  stringListFrontmatterField,
} from './okf.js';
import {
  initializeScopedNotebookNative,
  pinScopedNotebook,
  readScopedNotebookPublicationFacts,
} from './scoped-notebook-owner.js';
import {
  listServerKnowledgeSources,
  readServerKnowledgeSource,
  registerServerKnowledgeSource,
} from './server-knowledge-owner.js';
import { createServerNotebookProposal } from './server-notebook-proposals.js';
import { readPublishedSourcePointers } from './source-publication.js';

/** Existing application owners, shared by requested and fixed daily Server maintenance. */
export interface ServerKnowledgeMaintenanceDependencies {
  readonly store: FsStore;
  readonly pin: (
    run: Pick<ServerKnowledgeManagerAgentRun, 'turn' | 'inputs'>
  ) => void | Promise<void>;
  readonly run: (
    run: ServerKnowledgeManagerAgentRun
  ) => Promise<{ readonly turnId: string; readonly text: string }>;
  readonly coreDb: CoreDb;
  readonly runtimeConfigManager: RuntimeConfigManager;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
}
/** Trusted Server admission, never a Worker/model scope selector. */
export interface ServerKnowledgeMaintenanceInput {
  readonly sourceTurnId?: string | null;
  readonly requestId: string;
  readonly requestActor?: Actor;
  readonly actor: ActorRef;
  readonly trigger: 'request' | 'schedule';
  readonly instructions: string;
  readonly sources: readonly string[];
  readonly tellContent?: string;
  readonly pageIds?: readonly string[];
  readonly startedAt?: string;
  readonly signal: AbortSignal;
  /** Original command facts; Server admission commits these with its native products. */
  readonly receipt?: IdempotentCommandReceipt;
}

/** Uses only the actual local process authority; stored credentials are never presented by a timer. */
export function currentServerMaintenanceActor(
  coreDb: CoreDb,
  localUserId?: string
): Actor | undefined {
  if (!localUserId) return undefined;
  const actor: Actor = { kind: 'local', userId: localUserId };
  try {
    requireAdministratorOperation(coreDb, actor, 'knowledge.write', undefined, 'knowledge');
    return actor;
  } catch {
    return undefined;
  }
}

/** Bounded UTF-8 input; exact notebook/Source identity remains separately retained. */
function prefix(text: string, maximum = 16_384): string {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, maximum);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

/** Acquires every admitted owner needed before a maintenance command can stage or register input. */
function serverMaintenanceBinding(store: FsStore) {
  const binding = store.getServerWorkBinding();
  if (
    !binding?.owner.stageKnowledge ||
    !binding.owner.publishTurnProgress ||
    !binding.owner.appendObservation ||
    !binding.owner.readUsageIds ||
    !binding.owner.writeRouteLineage ||
    !binding.verifyCallAuthority ||
    !binding.callBudgetRef
  )
    throw serverWorkUnavailable();
  return { binding, stage: binding.owner.stageKnowledge.bind(binding.owner) };
}

/** Admits one fresh Server Turn, or an ordinary visible skipped/failed outcome without model replay. */
export async function prepareServerKnowledgeMaintenance(
  dependencies: ServerKnowledgeMaintenanceDependencies,
  input: ServerKnowledgeMaintenanceInput
) {
  assertAgentWorkNotPaused(
    dependencies.runtimeConfigManager.current().openKitConfig.security?.pauseAgentWork
  );
  const { store, coreDb } = dependencies;
  const { binding, stage } = serverMaintenanceBinding(store);
  if (input.trigger === 'request')
    requireAdministratorOperation(
      coreDb,
      input.requestActor,
      'knowledge.write',
      undefined,
      'knowledge'
    );
  input.signal.throwIfAborted();
  frameControlScalarText(input.instructions);
  if (input.tellContent !== undefined) frameControlScalarText(input.tellContent);
  const admitted = await withServerWorkProducer(binding, async () => {
    const staged = await stage({
      deploymentId: binding.deploymentId,
      credentialRef: input.requestActor
        ? auditAuthenticationFromActor(input.requestActor).credentialId
        : null,
      originalInput: JSON.stringify({
        instructions: input.instructions,
        sources: input.sources,
        pageIds: input.pageIds,
        tellContent: input.tellContent,
      }),
      input: ControlKnowledgeAdmissionInputSchema.parse({
        purpose: 'maintenance',
        ownerScope: { kind: 'server' },
        actor: input.actor,
        requestId: input.requestId,
        threadId: allocateEntityId('th'),
        turnId: allocateEntityId('tu'),
        startedAt: input.startedAt ?? new Date().toISOString(),
        trigger: input.trigger,
        instructions: input.instructions,
        captureCoverage: store.getLiveCaptureCoverage(),
        ...(input.receipt ? { receipt: input.receipt } : {}),
      }),
    });
    if (staged.state !== 'ready') throw serverWorkUnavailable();
    const original = staged.value;
    requireAppliedServerWork(
      await settleStagedServerWorkCommand(original.intent, binding.owner, binding.kernel)
    );
    return original;
  });
  if (admitted.replayed) throw new NotebookError('recovery_required');
  const thread = store.getServerThread(admitted.intent.target.threadId);
  const turn = store.getServerTurnById(admitted.intent.target.turnId);
  const history = store.listServerThreadTurns(thread.id).filter((prior) => prior.id !== turn.id);
  const busy = admitted.busy;
  const git = new KnowledgeNotebook({
    repositoryPath: join(coreDb.dataRoot, 'server', 'knowledge', 'notebook.git'),
  });
  let baseRevision = 'unavailable';
  const result = (
    outcome: 'published' | 'review-required' | 'no-change' | 'skipped' | 'failed',
    summary: string,
    extra: { notebookRevision?: string; candidateRevision?: string; proposalId?: string } = {}
  ) =>
    KnowledgeMaintenanceResponseSchema.parse({
      threadId: thread.id,
      turnId: turn.id,
      outcome,
      notebookRevision: baseRevision,
      summary,
      ...extra,
    });
  let outcome: ReturnType<typeof result> | undefined;
  let settled: ReturnType<typeof result> | undefined;
  /** Prepares the Server result before this owner or the shared role seals the Turn. */
  const resultItem = (value: ReturnType<typeof result>): Item => {
    const timestamp = new Date().toISOString();
    return {
      id: allocateEntityId('it'),
      owner: { kind: 'server' },
      threadId: thread.id,
      turnId: turn.id,
      type: 'status',
      level: value.outcome === 'failed' ? 'error' : 'info',
      title: 'Knowledge maintenance',
      summary: value.summary,
      status: value.outcome === 'failed' ? 'failed' : 'completed',
      knowledgeMaintenanceResult: value,
      createdAt: timestamp,
      completedAt: timestamp,
    };
  };
  const retain = async (
    value: ReturnType<typeof result>,
    terminal?: Parameters<FsStore['updateTurn']>[1]
  ) => {
    if (settled) {
      if (terminal) await store.completeTurn(turn.id, terminal);
      return settled;
    }
    const item = resultItem(value);
    if (terminal) await store.completeTurn(turn.id, terminal, { items: [item] });
    else await store.publishSettledTurnItem(item);
    settled = value;
    return value;
  };
  const fail = async () => {
    const current = store.getServerTurnById(turn.id);
    const retained = current.items.findLast(
      (item) => item.type === 'status' && item.knowledgeMaintenanceResult
    );
    const value =
      settled ??
      (retained?.type === 'status' ? retained.knowledgeMaintenanceResult : undefined) ??
      outcome ??
      result(
        'failed',
        current.error?.message ??
          'Server Knowledge maintenance failed. Inspect the retained Turn before a new request.'
      );
    if (current.status === 'running' || current.status === 'pending')
      return retain(value, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: { code: 'knowledge_maintenance_failed', message: value.summary },
      });
    return value;
  };
  if (busy) {
    const value = await retain(
      result('skipped', 'Another Server Knowledge maintenance Turn is active.'),
      {}
    );
    return { turnId: turn.id, fail, execute: async () => value };
  }
  if (input.trigger === 'schedule' && !input.requestActor) {
    outcome = result(
      'failed',
      'Scheduled Server maintenance has no current administration authority.'
    );
    const value = await fail();
    return { turnId: turn.id, fail, execute: async () => value };
  }
  let started = false;
  return {
    turnId: turn.id,
    fail,
    execute: async () => {
      if (started) throw new NotebookError('invalid_request');
      started = true;
      try {
        const actor = input.requestActor;
        requireAdministratorOperation(coreDb, actor, 'knowledge.write', undefined, 'knowledge');
        const context = { coreDb, actor: actor!, target: { kind: 'server' as const } };
        if (!existsSync(join(coreDb.dataRoot, 'server', 'knowledge')))
          await initializeScopedNotebookNative(
            {
              ...context,
              initialization: {
                requestId: input.requestId,
                instructionReference: `knowledge.server.maintain:${input.requestId}`,
              },
            },
            store
          );
        requireAdministratorOperation(coreDb, actor, 'knowledge.write', undefined, 'knowledge');
        input.signal.throwIfAborted();
        baseRevision = git.publishedRevision();
        const canonicalFiles = pinScopedNotebook(context).read().files;
        const paths = input.pageIds
          ? new Set(['index.md', ...input.pageIds.map((id) => `${id}.md`)])
          : undefined;
        if (paths && [...paths].some((path) => canonicalFiles[path] === undefined))
          throw new NotebookError('invalid_request');
        const files = Object.fromEntries(
          Object.entries(canonicalFiles).filter(([path]) => !paths || paths.has(path))
        );
        const originalSources = new Map<string, string>();
        const sources: Record<string, string> = {};
        for (const ref of input.sources) {
          const known = new Map(
            listServerKnowledgeSources(context).map((source) => [source.id, source.contentDigest])
          );
          const selected = resolveRegisteredKnowledgeSourceReference(ref, known);
          if (!selected.resolved || !selected.targetId) throw new NotebookError('invalid_request');
          const source = await readServerKnowledgeSource(context, selected.targetId);
          if (!source) throw new NotebookError('invalid_request');
          sources[source.source.id] = source.content;
          originalSources.set(source.source.id, source.source.contentDigest);
        }

        const historicalRevisions = new Set<string>();
        const assertCurrent = () => {
          input.signal.throwIfAborted();
          requireAdministratorOperation(coreDb, actor, 'knowledge.write', undefined, 'knowledge');
          const current = readScopedNotebookPublicationFacts(
            'server',
            dependencies,
            actor!,
            canonicalFiles
          );
          for (const revision of historicalRevisions)
            readScopedNotebookPublicationFacts(
              'server',
              dependencies,
              actor!,
              git.readRevision(revision).files
            );
          for (const [id, digest] of originalSources)
            if (current.registeredSources.get(id) !== digest)
              throw new NotebookError('recovery_required');
          if (
            input.trigger === 'schedule' &&
            !dependencies.runtimeConfigManager.current().openKitConfig.knowledgeMaintenance
              ?.schedule?.enabled
          )
            throw new NotebookError('invalid_request');
        };
        const previous = history.findLast(
          (old) =>
            old.status === 'completed' &&
            old.internalExecution?.knowledge?.purpose === 'maintenance' &&
            old.items.some(
              (item) =>
                item.type === 'status' &&
                ['published', 'review-required', 'no-change'].includes(
                  item.knowledgeMaintenanceResult?.outcome ?? ''
                )
            )
        );
        const since = previous?.internalExecution?.knowledge?.baseRevision;
        const humanChanges: { path: string; before: string | null; after: string | null }[] = [];
        let cursor: string | null = baseRevision;
        let scanned = 0;
        while (cursor && cursor !== since && scanned++ < 256) {
          const revision = git.readRevision(cursor);
          const parent = revision.parentRevision ? git.readRevision(revision.parentRevision) : null;
          if (revision.metadata.producer.kind === 'user') {
            historicalRevisions.add(revision.revision);
            if (parent) historicalRevisions.add(parent.revision);
            for (const path of new Set([
              ...Object.keys(parent?.files ?? {}),
              ...Object.keys(revision.files),
            ]))
              if (parent?.files[path] !== revision.files[path])
                humanChanges.push({
                  path,
                  before: parent?.files[path] ?? null,
                  after: revision.files[path] ?? null,
                });
          }
          cursor = revision.parentRevision;
        }
        if (cursor && cursor !== since) throw new NotebookError('invalid_request');
        assertCurrent();
        const humanEdits = boundedNotebookDiff(humanChanges, false);
        const authoringGuidance = notebookAuthoringGuidance(
          readScopedNotebookPublicationFacts('server', dependencies, actor!, canonicalFiles)
            .scopeSchemaText,
          { kind: 'server' }
        );
        const editor = createNotebookAgentEditing({
          notebook: git,
          baseRevision,
          requestId: input.requestId,
          files,
          sources,
          signal: input.signal,
          /** The editor exists before pinning; Tool access reads the actual admitted budget. */
          get deadlineMs() {
            return notebookEditingDeadline(store.getServerTurnById(turn.id));
          },
          revalidate: assertCurrent,
          submit: async (edit) => {
            assertCurrent();
            if (edit.changes.length > NOTEBOOK_EDITING_LIMITS.changedFiles)
              throw new NotebookError('invalid_request');
            if (!edit.changes.length) {
              outcome = result('no-change', edit.summary);
              return { outcome: 'no-change', notebookRevision: baseRevision };
            }
            const refs = [
              ...new Set(
                edit.changes.flatMap(({ path, content }) =>
                  content === null
                    ? []
                    : (stringListFrontmatterField(
                        parseOkfDocument({ path, content }).document!,
                        'source_refs'
                      ) ?? [])
                )
              ),
            ];
            const setting = dependencies.runtimeConfigManager.current().openKitConfig
              .knowledgeMaintenance ?? { enabled: false, reviewRequiredPageIds: [] };
            const facts = readScopedNotebookPublicationFacts('server', dependencies, actor!);
            const producer = {
              kind: 'agent' as const,
              id: 'knowledge-manager',
              responsibleUserId: responsibleUserIdForActor(input.actor),
            };
            if (
              setting.enabled &&
              !edit.changes.some(
                ({ path, content }) =>
                  content === null || facts.reviewRequiredPageIds.includes(path.slice(0, -3))
              )
            ) {
              // Pin proofs use the same final attribution bytes as the common publisher.
              const candidateFiles = { ...canonicalFiles };
              for (const { path, content } of edit.changes) {
                if (content === null) delete candidateFiles[path];
                else
                  candidateFiles[path] =
                    canonicalFiles[path] === content
                      ? content
                      : attributedNotebookPageBytes(path, content, { kind: 'server' }, 'delegated');
              }
              const published = await publishNotebook(
                {
                  owner: { kind: 'server', coreDb },
                  store,
                  inflightCommands: dependencies.inflightCommands,
                  notebook: git,
                  sourceTurnId: turn.id,
                  producer,
                  actor: { kind: 'user', id: actor!.userId },
                  publicationAuthority: {
                    kind: 'delegated',
                    settingReference: 'server:knowledgeMaintenance',
                    settingDigest: commandInputHash(setting),
                  },
                  revalidate: () => {
                    assertCurrent();
                    if (
                      commandInputHash(
                        dependencies.runtimeConfigManager.current().openKitConfig
                          .knowledgeMaintenance ?? { enabled: false, reviewRequiredPageIds: [] }
                      ) !== commandInputHash(setting)
                    )
                      throw new NotebookError('review_required');
                    return readScopedNotebookPublicationFacts(
                      'server',
                      dependencies,
                      actor!,
                      candidateFiles
                    );
                  },
                },
                edit
              );
              outcome = result('published', edit.summary, {
                notebookRevision: published.notebookRevision,
              });
              return published;
            }
            const proposal = await createServerNotebookProposal(
              {
                ...dependencies,
                sourceTurnId: turn.id,
                actor: actor!,
                revalidate: (candidateFiles?: Readonly<Record<string, string>>) => {
                  assertCurrent();
                  return readScopedNotebookPublicationFacts(
                    'server',
                    dependencies,
                    actor!,
                    candidateFiles
                  );
                },
              },
              edit,
              producer,
              refs
            );
            outcome = result('review-required', edit.summary, {
              candidateRevision: proposal.candidateRevision,
              proposalId: proposal.id,
            });
            return {
              outcome: 'review_required',
              proposalId: proposal.id,
              candidateRevision: proposal.candidateRevision,
              baseRevision,
            };
          },
        });
        const tool = (
          name: string,
          key: string,
          execute: (value: string) => Promise<unknown>
        ): AgentTool => ({
          name,
          description:
            'Manage only this pinned Server notebook using bounded in-memory files. No network or host execution.',
          inputSchema: {
            type: 'object',
            properties: { [key]: { type: 'string', minLength: 1 } },
            required: [key],
            additionalProperties: false,
          },
          execute: async (value) => {
            assertCurrent();
            const text = (value as Record<string, string>)[key]!;
            return { content: [{ type: 'text', text: JSON.stringify(await execute(text)) }] };
          },
        });
        const tools = [
          createServerRunHistory({ store, turn, assertCurrent }),
          tool('knowledge.notebook-workspace.update', 'script', (script) =>
            editor.workspaceUpdate({ script })
          ),
          tool('knowledge.notebook.update', 'summary', async (summary) => {
            const native = await editor.notebookUpdate({ summary });
            if (native.outcome === 'no_change') outcome = result('no-change', summary);
            if (outcome) await retain(outcome);
            return native;
          }),
        ];
        let remainingSourceBytes = 64 * 1024;
        const selectedSources = Object.entries(sources).map(([id, content]) => {
          const delivered = prefix(content, remainingSourceBytes);
          remainingSourceBytes -= Buffer.byteLength(delivered);
          return {
            file: `/sources/${id}`,
            reference: `source:${id}@${originalSources.get(id)}`,
            content: delivered,
            truncated: delivered.length < content.length,
          };
        });
        const runInput = {
          kind: 'server' as const,
          turn,
          coreDb,
          terminalItems: (patch: Parameters<FsStore['updateTurn']>[1]) =>
            settled
              ? []
              : [
                  resultItem(
                    outcome ??
                      result(
                        'failed',
                        patch.error?.message ??
                          'Server Knowledge maintenance failed. Inspect the retained Turn before a new request.'
                      )
                  ),
                ],
          signal: input.signal,
          inputs: {
            purpose: 'maintenance' as const,
            ownerScope: { kind: 'server' as const },
            baseRevision,
            trigger: input.trigger,
            instructions: input.instructions,
            sourceRange: [],
          },
          messages: [
            {
              role: 'user' as const,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    instructions: input.instructions,
                    notebookRevision: baseRevision,
                    authoringGuidance,
                    files: Object.keys(files),
                    selectedPageIds: input.pageIds ?? [],
                    humanEdits,
                    overview: prefix(files['index.md'] ?? ''),
                    sources: selectedSources,
                    sourceRange: [],
                    sourcePolicy:
                      'Only this explicit request and Server notebook human edits are inputs. Never learn from Workspace or User Threads, or prior Knowledge Manager run records.',
                  }),
                },
              ],
            },
          ],
          tools,
          assertCurrent,
          readEvidence: (items: readonly Item[]) => {
            assertCurrent();
            return internalContextDigest({
              owner: { kind: 'server' },
              baseRevision,
              sources: [...originalSources],
              items: items.map((item) => item.id),
            });
          },
          resultSchema: {
            type: 'object',
            properties: { summary: { type: 'string', minLength: 1 } },
            required: ['summary'],
            additionalProperties: false,
          },
          validateResult: () => {
            assertCurrent();
            if (!outcome)
              return 'Call knowledge.notebook.update first, including for no change. Then call knowledge.result.';
          },
        };

        await dependencies.pin(runInput);
        await dependencies.run(runInput);
        if (!outcome) throw new NotebookError('invalid_request');
        return retain(outcome);
      } catch {
        return fail();
      }
    },
  };
}

/** The existing Core command receipt fixes one requested Turn before inference and replays its retained outcome. */
export async function runServerKnowledgeMaintenanceCommand(
  dependencies: ServerKnowledgeMaintenanceDependencies,
  input: ServerKnowledgeMaintenanceInput
) {
  requireAdministratorOperation(
    dependencies.coreDb,
    input.requestActor,
    'knowledge.write',
    undefined,
    'knowledge'
  );
  serverMaintenanceBinding(dependencies.store);
  const command =
    input.tellContent === undefined ? 'knowledge.server.maintain' : 'knowledge.server.tell';
  const scope = { coreId: 'server' as const, actorId: input.actor.id };
  const canonicalInput = {
    instructions: input.instructions,
    sources: input.sources,
    tellContent: input.tellContent,
    pageIds: input.pageIds,
  };
  return runIdempotentCommand<ReturnType<typeof KnowledgeMaintenanceResponseSchema.parse>>({
    store: dependencies.store,
    inflightCommands: dependencies.inflightCommands,
    command,
    requestId: input.requestId,
    scope,
    input: canonicalInput,
    receiptDb: dependencies.coreDb,
    responseKind: 'turn',
    responseId: (result) => result.turnId,
    execute: async (receipt) => {
      const captured =
        input.tellContent === undefined
          ? undefined
          : await registerServerKnowledgeSource(
              {
                ...dependencies,
                actor: input.requestActor,
                ...(input.sourceTurnId !== undefined ? { sourceTurnId: input.sourceTurnId } : {}),
              },
              {
                requestId: input.requestId,
                kind: 'document',
                title: 'Explicit Server Knowledge request',
                content: input.tellContent,
              }
            );
      const prepared = await prepareServerKnowledgeMaintenance(dependencies, {
        ...input,
        receipt,
        sources: [
          ...input.sources,
          ...(captured ? [`source:${captured.id}@${captured.contentDigest}`] : []),
        ],
      });
      return prepared.execute();
    },
    replay: (receipt) => {
      const turn = dependencies.store.getServerTurnById(receipt.response.id);
      const item = turn.items.findLast(
        (item) => item.type === 'status' && item.knowledgeMaintenanceResult
      );
      if (item?.type === 'status')
        return KnowledgeMaintenanceResponseSchema.parse(item.knowledgeMaintenanceResult);
      throw new OperationError(
        'recovery_required',
        'The retained Server maintenance Turn requires inspection. Use a new request for new work.',
        409
      );
    },
  });
}

/**
 * Admits Server Knowledge at the critical boot boundary.
 *
 * A missing notebook with no established authority is fresh initialization.
 * Unreadable, unsupported, or missing expected authority fails closed.
 */
export function admitServerKnowledgeBoot(coreDb: CoreDb): void {
  readPublishedSourcePointers(
    { dataRoot: coreDb.dataRoot, ownerScope: { kind: 'server' } },
    { kind: 'server', coreDb }
  );
}

/** Boot marks interrupted Server KM work inspect-only; it never replays a model or notebook effect. */
export async function recoverServerKnowledgeManagerTurns(
  store: FsStore
): Promise<StorageResult<'server-work', void>> {
  if (store.getDataRoot())
    return { state: 'unavailable', owner: 'server-work', reason: 'disabled' };
  for (const thread of store.listServerThreads())
    for (const turn of store.listServerThreadTurns(thread.id)) {
      if (turn.agentId !== 'knowledge-manager' || !['pending', 'running'].includes(turn.status))
        continue;
      await store.completeTurn(turn.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: {
          code: 'recovery_required',
          message:
            'Server Knowledge maintenance was interrupted. Inspect its retained work and start a new request.',
        },
      });
    }
  return { state: 'ready', value: undefined };
}

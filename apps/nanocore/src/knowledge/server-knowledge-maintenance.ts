import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeMaintenanceResponseSchema } from '@openkit/app-api-schemas';
import {
  type ActorRef,
  allocateEntityId,
  type Item,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import { requireCurrentDeploymentAdmin } from '../auth/operation-authorizer.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import type { ServerKnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { internalContextDigest } from '../internal-agents/rolling-context.js';
import { createServerRunHistory } from '../internal-agents/server-history.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, type FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import {
  commandInputHash,
  type IdempotentCommandReceipt,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import type { CoreDb } from '../storage/db.js';
import {
  admitControlMaintenance,
  ControlMaintenanceAdmissionInputSchema,
} from './knowledge-agent-maintenance.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { createNotebookAgentEditing, NOTEBOOK_EDITING_LIMITS } from './notebook-agent-editing.js';
import { notebookAuthoringGuidance } from './notebook-authoring-guidance.js';
import { boundedNotebookDiff } from './notebook-history.js';
import {
  attributedNotebookPageBytes,
  type NotebookPublicationAdmission,
  publishNotebook,
} from './notebook-publication.js';
import {
  parseKnowledgePageSourceReference,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  resolveRegisteredKnowledgeSourceReference,
  stringFrontmatterField,
  stringListFrontmatterField,
  validateScopeKnowledgeSchema,
} from './okf.js';
import { initializeScopedNotebook, pinScopedNotebook } from './scoped-notebook-owner.js';
import {
  listServerKnowledgeSources,
  readServerKnowledgeSource,
  readServerKnowledgeSourceMetadata,
  registerServerKnowledgeSource,
} from './server-knowledge-owner.js';
import { createServerNotebookProposal } from './server-notebook-proposals.js';

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
    requireCurrentDeploymentAdmin(coreDb, actor);
    return actor;
  } catch {
    return undefined;
  }
}

/** Rechecks current Server authority and Source closure for the selected immutable tree or current publication. */
export function serverNotebookAdmission(
  dependencies: ServerKnowledgeMaintenanceDependencies,
  actor: Actor,
  selectedFiles?: Readonly<Record<string, string>>
): NotebookPublicationAdmission {
  requireCurrentDeploymentAdmin(dependencies.coreDb, actor);
  const notebook = pinScopedNotebook({
    coreDb: dependencies.coreDb,
    actor,
    target: { kind: 'server' },
  });
  const currentFiles = notebook.read().files;
  const files = selectedFiles ?? currentFiles;
  const pageScopeId = `page/server/${notebook.knowledgeBaseId}`;
  const scopeSchemaText = readFileSync(
    join(dependencies.coreDb.dataRoot, 'server', 'knowledge', 'schema', 'scope-schema.yaml'),
    'utf8'
  );
  const scopeSchema = parseScopeKnowledgeSchema(scopeSchemaText);
  if (!scopeSchema.ok) throw new NotebookError('recovery_required');
  const registeredSources = new Map(
    listServerKnowledgeSources({ coreDb: dependencies.coreDb, actor }).map((source) => [
      source.id,
      source.contentDigest,
    ])
  );
  const resolvedReferences = new Map<string, ReadonlySet<string>>();
  const visiting = new Set<string>();
  const checked = new Set<string>();
  const checkPage = (path: string, selected = files): void => {
    const pageId = path.slice(0, -3);
    const key = `${selected === files ? 'selected' : 'current'}:${pageId}`;
    if (checked.has(key)) return;
    if (visiting.has(key)) throw new NotebookError('invalid_request');
    visiting.add(key);
    const content = selected[path];
    if (content === undefined) throw new NotebookError('invalid_request');
    const parsed = parseOkfDocument({ path, content });
    if (!parsed.ok) throw new NotebookError('recovery_required');
    if (
      !parsed.document.reserved &&
      validateScopeKnowledgeSchema(parsed.document, scopeSchema.schema, { kind: 'server' }).errors
        .length
    )
      throw new NotebookError('invalid_request');
    const refs = stringListFrontmatterField(parsed.document, 'source_refs') ?? [];
    const resolved = new Set<string>();
    for (const ref of refs) {
      if (ref.startsWith('openkit:')) {
        const reference = parseKnowledgePageSourceReference(ref, pageScopeId);
        if (!reference) throw new NotebookError('invalid_request');
        const targetPath = `${reference.reference.objectId}.md`;
        // An older selected target cannot bypass a later current restriction.
        const targetTrees =
          selected !== currentFiles && currentFiles[targetPath] !== undefined
            ? [selected, currentFiles]
            : [selected];
        for (const targetTree of targetTrees) {
          const target = targetTree[targetPath];
          if (
            target === undefined ||
            (targetTree === selected &&
              reference.contentDigest !== undefined &&
              reference.contentDigest !==
                `sha256:${createHash('sha256').update(target).digest('hex')}`)
          )
            throw new NotebookError('invalid_request');
          const document = parseOkfDocument({ path: targetPath, content: target });
          if (
            !document.ok ||
            ['restricted', 'confidential'].includes(
              stringFrontmatterField(document.document, 'sensitivity') ?? ''
            )
          )
            throw new NotebookError('invalid_request');
          checkPage(targetPath, targetTree);
        }
      } else {
        const selected = resolveRegisteredKnowledgeSourceReference(ref, registeredSources);
        if (
          !selected.resolved ||
          !selected.targetId ||
          !readServerKnowledgeSourceMetadata(
            { coreDb: dependencies.coreDb, actor },
            selected.targetId
          )
        )
          throw new NotebookError('recovery_required');
      }
      resolved.add(ref);
    }
    visiting.delete(key);
    checked.add(key);
    if (selected === files) resolvedReferences.set(pageId, resolved);
  };
  for (const path of Object.keys(files)) checkPage(path);
  return {
    pageScopeId,
    scopeSchemaText,
    reviewRequiredPageIds:
      dependencies.runtimeConfigManager.current().openKitConfig.knowledgeMaintenance
        ?.reviewRequiredPageIds ?? [],
    registeredSources,
    resolvedReferences,
  };
}

/** Bounded UTF-8 input; exact notebook/Source identity remains separately retained. */
function prefix(text: string, maximum = 16_384): string {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, maximum);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

/** Admits one fresh Server Turn, or an ordinary visible skipped/failed outcome without model replay. */
export async function prepareServerKnowledgeMaintenance(
  dependencies: ServerKnowledgeMaintenanceDependencies,
  input: ServerKnowledgeMaintenanceInput
) {
  const { store, coreDb } = dependencies;
  if (input.trigger === 'request') requireCurrentDeploymentAdmin(coreDb, input.requestActor);
  input.signal.throwIfAborted();
  const admitted = await admitControlMaintenance(
    coreDb.dataRoot,
    undefined,
    ControlMaintenanceAdmissionInputSchema.parse({
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
    })
  );
  if (admitted.replayed) throw new NotebookError('recovery_required');
  const thread = store.getServerThread(admitted.threadId);
  const turn = store.getServerTurnById(admitted.turnId);
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
    else await store.createServerItem(item, ALREADY_DECIDED_PUBLICATION_ADMISSION);
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
        requireCurrentDeploymentAdmin(coreDb, actor);
        const context = { coreDb, actor: actor!, target: { kind: 'server' as const } };
        if (!existsSync(join(coreDb.dataRoot, 'server', 'knowledge')))
          initializeScopedNotebook({
            ...context,
            initialization: {
              requestId: input.requestId,
              instructionReference: `knowledge.server.maintain:${input.requestId}`,
            },
          });
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
          requireCurrentDeploymentAdmin(coreDb, actor);
          const current = serverNotebookAdmission(dependencies, actor!, canonicalFiles);
          for (const revision of historicalRevisions)
            serverNotebookAdmission(dependencies, actor!, git.readRevision(revision).files);
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
          serverNotebookAdmission(dependencies, actor!, canonicalFiles).scopeSchemaText,
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
            const pinned = store.getServerTurnById(turn.id);
            const limit = pinned.internalExecution?.limits?.deadlineMs;
            if (limit === undefined || pinned.startedAt === null)
              throw new NotebookError('invalid_request');
            return Date.parse(pinned.startedAt) + limit;
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
            const facts = serverNotebookAdmission(dependencies, actor!);
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
                    return serverNotebookAdmission(dependencies, actor!, candidateFiles);
                  },
                },
                edit
              );
              outcome = result('published', edit.summary, {
                notebookRevision: published.notebookRevision,
              });
              return published;
            }
            const proposal = createServerNotebookProposal(
              {
                ...dependencies,
                actor: actor!,
                revalidate: (candidateFiles?: Readonly<Record<string, string>>) => {
                  assertCurrent();
                  return serverNotebookAdmission(dependencies, actor!, candidateFiles);
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
  requireCurrentDeploymentAdmin(dependencies.coreDb, input.requestActor);
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
              { ...dependencies, actor: input.requestActor },
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

/** Boot marks interrupted Server KM work inspect-only; it never replays a model or notebook effect. */
export async function recoverServerKnowledgeManagerTurns(store: FsStore): Promise<void> {
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
}

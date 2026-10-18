import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeMaintenanceResponseSchema } from '@openkit/app-api-schemas';
import {
  type ActorRef,
  allocateEntityId,
  responsibleUserIdForActor,
  type ServerItem,
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
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import type { CoreDb } from '../storage/db.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { createNotebookAgentEditing } from './notebook-agent-editing.js';
import { boundedNotebookDiff } from './notebook-history.js';
import { type NotebookPublicationAdmission, publishNotebook } from './notebook-publication.js';
import {
  parseOkfDocument,
  resolveRegisteredKnowledgeSourceReference,
  stringListFrontmatterField,
} from './okf.js';
import { initializeScopedNotebook, pinScopedNotebook } from './scoped-notebook-owner.js';
import {
  listServerKnowledgeSources,
  readServerKnowledgeSource,
  registerServerKnowledgeSource,
} from './server-knowledge-owner.js';
import { createServerNotebookProposal } from './server-notebook-proposals.js';

/** Existing application owners, shared by requested and fixed daily Server maintenance. */
export interface ServerKnowledgeMaintenanceDependencies {
  readonly store: FsStore;
  readonly pin: (run: Pick<ServerKnowledgeManagerAgentRun, 'turn' | 'inputs'>) => void;
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

/** Current Server notebook/schema and Source bytes are checked at each disclosure/effect boundary. */
export function serverNotebookAdmission(
  dependencies: ServerKnowledgeMaintenanceDependencies,
  actor: Actor
): NotebookPublicationAdmission {
  requireCurrentDeploymentAdmin(dependencies.coreDb, actor);
  const notebook = pinScopedNotebook({
    coreDb: dependencies.coreDb,
    actor,
    target: { kind: 'server' },
  });
  const files = notebook.read().files;
  const registeredSources = new Map(
    listServerKnowledgeSources({ coreDb: dependencies.coreDb, actor }).map((source) => [
      source.id,
      source.contentDigest,
    ])
  );
  for (const [path, content] of Object.entries(files)) {
    const parsed = parseOkfDocument({ path, content });
    if (!parsed.ok) throw new NotebookError('recovery_required');
    const refs = stringListFrontmatterField(parsed.document, 'source_refs') ?? [];
    for (const ref of refs) {
      const selected = resolveRegisteredKnowledgeSourceReference(ref, registeredSources);
      if (
        !selected.resolved ||
        !selected.targetId ||
        !readServerKnowledgeSource({ coreDb: dependencies.coreDb, actor }, selected.targetId)
      )
        throw new NotebookError('recovery_required');
    }
  }
  return {
    scopeSchemaText: readFileSync(
      join(dependencies.coreDb.dataRoot, 'server', 'knowledge', 'schema', 'scope-schema.yaml'),
      'utf8'
    ),
    reviewRequiredPageIds:
      dependencies.runtimeConfigManager.current().openKitConfig.knowledgeMaintenance
        ?.reviewRequiredPageIds ?? [],
    registeredSources,
    resolvedReferences: new Map(),
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
export function prepareServerKnowledgeMaintenance(
  dependencies: ServerKnowledgeMaintenanceDependencies,
  input: ServerKnowledgeMaintenanceInput
) {
  const { store, coreDb } = dependencies;
  if (input.trigger === 'request') requireCurrentDeploymentAdmin(coreDb, input.requestActor);
  const threads = store
    .listServerThreads()
    .filter((thread) => thread.entryPath === 'knowledge-manager');
  if (threads.length > 1) throw new NotebookError('recovery_required');
  const thread = threads[0] ?? store.createServerThread('Server Knowledge maintenance');
  const history = store.listServerThreadTurns(thread.id);
  const busy = history.some((turn) => turn.status === 'running' || turn.status === 'pending');
  const turn = store.createServerTurn(thread.id, input.instructions, input.actor, null, {
    agentId: 'knowledge-manager',
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(busy ? { status: 'completed' as const } : {}),
    triggerSource: {
      kind: input.trigger === 'schedule' ? 'automation' : 'system-input',
      summary:
        input.trigger === 'schedule'
          ? 'Knowledge Manager scheduled maintenance.'
          : 'Knowledge maintenance.',
    },
  });
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
  const retain = (value: ReturnType<typeof result>) => {
    if (settled) return settled;
    settled = value;
    const timestamp = new Date().toISOString();
    store.createServerItem(
      {
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
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    return value;
  };
  const fail = () => {
    const value = retain(
      outcome ??
        result(
          'failed',
          'Server Knowledge maintenance failed. Inspect the retained Turn before a new request.'
        )
    );
    const current = store.getServerTurnById(turn.id);
    if (current.status === 'running' || current.status === 'pending')
      store.updateServerTurn(turn.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: { code: 'knowledge_maintenance_failed', message: value.summary },
      });
    return value;
  };
  if (busy) {
    const value = retain(result('skipped', 'Another Server Knowledge maintenance Turn is active.'));
    return { turnId: turn.id, fail, execute: async () => value };
  }
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
      const source = readServerKnowledgeSource(context, selected.targetId);
      if (!source) throw new NotebookError('invalid_request');
      sources[source.source.id] = source.content;
      originalSources.set(source.source.id, source.source.contentDigest);
    }

    const assertCurrent = () => {
      input.signal.throwIfAborted();
      requireCurrentDeploymentAdmin(coreDb, actor);
      const current = serverNotebookAdmission(dependencies, actor!);
      for (const [id, digest] of originalSources)
        if (current.registeredSources.get(id) !== digest)
          throw new NotebookError('recovery_required');
      if (
        input.trigger === 'schedule' &&
        !dependencies.runtimeConfigManager.current().openKitConfig.knowledgeMaintenance?.schedule
          ?.enabled
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
      if (revision.metadata.producer.kind === 'user')
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
      cursor = revision.parentRevision;
    }
    if (cursor && cursor !== since) throw new NotebookError('invalid_request');
    const humanEdits = boundedNotebookDiff(humanChanges, false);
    const editor = createNotebookAgentEditing({
      notebook: git,
      baseRevision,
      requestId: input.requestId,
      files,
      sources,
      signal: input.signal,
      deadlineMs: Date.now() + 120_000,
      revalidate: assertCurrent,
      submit: async (edit) => {
        assertCurrent();
        if (edit.changes.length > 4) throw new NotebookError('invalid_request');
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
                return serverNotebookAdmission(dependencies, actor!);
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
            revalidate: () => {
              assertCurrent();
              return serverNotebookAdmission(dependencies, actor!);
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
        if (outcome) retain(outcome);
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
      readEvidence: (items: readonly ServerItem[]) => {
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
        retain(outcome);
      },
    };
    dependencies.pin(runInput);
    let started = false;
    return {
      turnId: turn.id,
      fail,
      execute: async () => {
        if (started) throw new NotebookError('invalid_request');
        started = true;
        try {
          await dependencies.run(runInput);
          if (!outcome) throw new NotebookError('invalid_request');
          return retain(outcome);
        } catch {
          return fail();
        }
      },
    };
  } catch {
    const value = fail();
    return { turnId: turn.id, fail, execute: async () => value };
  }
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
  return runIdempotentCommand({
    store: dependencies.store,
    inflightCommands: dependencies.inflightCommands,
    command,
    requestId: input.requestId,
    scope,
    input: canonicalInput,
    receiptDb: dependencies.coreDb,
    responseKind: 'turn',
    responseId: (result) => result.turnId,
    execute: async () => {
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
      const prepared = prepareServerKnowledgeMaintenance(dependencies, {
        ...input,
        sources: [
          ...input.sources,
          ...(captured ? [`source:${captured.id}@${captured.contentDigest}`] : []),
        ],
      });
      dependencies.store.recordCommandRequest(
        {
          command,
          requestId: input.requestId,
          scope,
          inputHash: commandInputHash(canonicalInput),
          response: { kind: 'turn', id: prepared.turnId },
        },
        dependencies.coreDb
      );
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
export function recoverServerKnowledgeManagerTurns(store: FsStore): void {
  for (const thread of store.listServerThreads())
    for (const turn of store.listServerThreadTurns(thread.id)) {
      if (turn.agentId !== 'knowledge-manager' || !['pending', 'running'].includes(turn.status))
        continue;
      store.updateServerTurn(turn.id, {
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

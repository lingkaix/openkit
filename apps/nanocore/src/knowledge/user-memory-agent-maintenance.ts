import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { KnowledgeMaintenanceResponseSchema } from '@openkit/app-api-schemas';
import { allocateEntityId, isSealedTurnTerminal } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { createAssistantHistory } from '../internal-agents/assistant-history.js';
import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import { readInternalContextEvidence } from '../internal-agents/internal-context-evidence.js';
import type { KnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import type { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import {
  commandInputHash,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import type { CoreDb, UserDb, WorkspaceDb } from '../storage/db.js';
import { ensureUserQuickChatWorkspace } from '../workspace-membership.js';
import { admitMemoryContext, type MemoryContext } from './memory-lifecycle.js';
import { readMemorySuppressions } from './memory-maintenance.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { createNotebookAgentEditing, NOTEBOOK_EDITING_LIMITS } from './notebook-agent-editing.js';
import { boundedNotebookDiff } from './notebook-history.js';
import { type NotebookPublicationAdmission, publishNotebook } from './notebook-publication.js';
import {
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  resolveRegisteredKnowledgeSourceReference,
  stringFrontmatterField,
  stringListFrontmatterField,
  validateScopeKnowledgeSchema,
} from './okf.js';
import {
  readUserKnowledgeSource,
  registerUserKnowledgeSource,
} from './scoped-knowledge-sources.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';
import { createUserMemoryProposal } from './user-memory-proposals.js';

/** Trusted self invocation; instructions cannot select an owner, audience or publication authority. */
export interface UserMemoryMaintenanceInput {
  readonly requestId: string;
  readonly requestActor: Actor;
  readonly startedAt?: string;
  readonly trigger: 'request' | 'schedule';
  readonly instructions: string;
  readonly sources: readonly string[];
  readonly pageIds?: readonly string[];
  readonly tellContent?: string;
  readonly askingThreadId?: string;
  readonly askingTurnId?: string;
  readonly signal: AbortSignal;
}

/** Existing User content/receipt owners and ordinary bounded role runner. */
export interface UserMemoryMaintenanceDependencies {
  readonly coreDb: CoreDb;
  readonly userDb: UserDb;
  readonly store: FsStore;
  readonly runtimeConfigManager: RuntimeConfigManager;
  readonly openWorkspace: (workspaceId: string) => WorkspaceDb;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly pin: (input: Pick<KnowledgeManagerAgentRun, 'turn' | 'inputs'>) => void;
  readonly run: (
    input: KnowledgeManagerAgentRun
  ) => Promise<{ readonly turnId: string; readonly text: string }>;
}

/** Reads the current generated-page admission through self, supported sensitivity and exact unsuppressed Source versions. */
export function readUserMemoryNotebookAdmission(
  context: MemoryContext & { readonly runtimeConfigManager: RuntimeConfigManager },
  files: Readonly<Record<string, string>>,
  changedPaths: readonly string[] = []
): NotebookPublicationAdmission {
  const owner = admitMemoryContext(context);
  const suppressions = readMemorySuppressions(owner.notebookRoot, context.userDb.userId);
  const suppressedPageIds = suppressions.map(({ payload }) => payload.pageId);
  if (changedPaths.some((path) => suppressedPageIds.includes(path.slice(0, -3))))
    throw new NotebookError('invalid_request');
  const registeredSources = new Map<string, string | null>();
  for (const [path, content] of Object.entries(files)) {
    // A failed forget cleanup can leave bytes in Git; it must not expose them or fence unrelated edits.
    if (suppressedPageIds.includes(path.slice(0, -3))) continue;
    const parsed = parseOkfDocument({ path, content });
    if (!parsed.ok) throw new NotebookError('recovery_required');
    const refs = stringListFrontmatterField(parsed.document, 'source_refs');
    if (parsed.document.reserved) {
      if (
        refs?.length ||
        (refs === null && Object.hasOwn(parsed.document.frontmatter, 'source_refs'))
      )
        throw new NotebookError('invalid_request');
      continue;
    }
    if (
      !['public', 'normal', 'internal', 'confidential'].includes(
        stringFrontmatterField(parsed.document, 'sensitivity') ?? ''
      ) ||
      !refs
    )
      throw new NotebookError('invalid_request');
    for (const reference of refs) {
      const { targetId } = resolveRegisteredKnowledgeSourceReference(reference, registeredSources);
      if (!targetId) throw new NotebookError('invalid_request');
      if (!registeredSources.has(targetId)) {
        const source = readUserKnowledgeSource(context, targetId, 'model');
        if (!source) throw new NotebookError('invalid_request');
        registeredSources.set(targetId, source.source.contentDigest);
      }
      if (!resolveRegisteredKnowledgeSourceReference(reference, registeredSources).resolved)
        throw new NotebookError('invalid_request');
    }
  }
  let scopeSchemaText: string;
  try {
    scopeSchemaText = readFileSync(join(owner.notebookRoot, 'schema', 'scope-schema.yaml'), 'utf8');
  } catch {
    throw new NotebookError('recovery_required');
  }
  admitMemoryContext(context);
  return {
    scopeSchemaText,
    reviewRequiredPageIds:
      context.runtimeConfigManager
        .current()
        .userConfigs.find(({ userId }) => userId === context.userDb.userId)?.config
        .knowledgeMaintenance?.reviewRequiredPageIds ?? [],
    registeredSources,
    resolvedReferences: new Map(),
    suppressedPageIds,
  };
}

/** Projects a complete UTF-8 prefix while retaining an independent delivered digest. */
function excerpt(text: string, maximum: number) {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, maximum);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  const content = bytes.subarray(0, end).toString('utf8');
  return {
    content,
    truncated: end < bytes.length,
    deliveredDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}

/** Prepares one nonresident private maintenance Turn without starting a Provider. */
export function prepareUserMemoryMaintenance(
  dependencies: UserMemoryMaintenanceDependencies,
  input: UserMemoryMaintenanceInput
) {
  const { store, coreDb, userDb } = dependencies;
  const context = {
    coreDb,
    userDb,
    actor: input.requestActor,
    runtimeConfigManager: dependencies.runtimeConfigManager,
  };
  const owner = admitMemoryContext(context);
  input.signal.throwIfAborted();
  if (!lstatSync(owner.notebookRoot, { throwIfNoEntry: false })) {
    if (
      userDb.sqlite
        .prepare(
          "SELECT 1 FROM audit_events WHERE action = 'knowledge.notebook.initialize' LIMIT 1"
        )
        .get()
    )
      throw new NotebookError('recovery_required');
    initializeScopedNotebook({
      ...context,
      target: { kind: 'user' },
      initialization: {
        requestId: input.requestId,
        instructionReference: `memory-maintenance:${input.requestId}`,
      },
    });
  }
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(owner.notebookRoot, 'notebook.git'),
  });
  const baseRevision = notebook.publishedRevision();
  ensureUserQuickChatWorkspace({ coreDb, store, userId: userDb.userId });
  const workspaceId = store.ensureQuickChatWorkspace(userDb.userId).id;
  const priorRuns = store
    .listThreads(workspaceId)
    .flatMap((thread) => store.listThreadTurns(workspaceId, thread.id))
    .filter((turn) => {
      const knowledge = turn.internalExecution?.knowledge;
      return (
        (knowledge?.purpose === 'maintenance' &&
          knowledge.ownerScope.kind === 'user' &&
          knowledge.ownerScope.userId === userDb.userId) ||
        (turn.agentId === 'knowledge-manager' &&
          turn.triggerSource?.summary === 'User Memory maintenance.')
      );
    });
  const threadIds = new Set(priorRuns.map((turn) => turn.threadId));
  if (threadIds.size > 1) throw new NotebookError('recovery_required');
  const thread = priorRuns[0]
    ? store.getThread(workspaceId, priorRuns[0].threadId)
    : store.createThread(workspaceId, 'Memory maintenance', undefined, 'knowledge-manager', {
        visibility: 'private',
        privateOwnerUserId: userDb.userId,
      });
  if (
    thread.visibility !== 'private' ||
    thread.privateOwnerUserId !== userDb.userId ||
    thread.entryPath !== 'knowledge-manager'
  )
    throw new NotebookError('recovery_required');
  const actor = { kind: 'user', id: userDb.userId } as const;
  const producer = {
    kind: 'agent',
    id: 'knowledge-manager',
    responsibleUserId: userDb.userId,
  } as const;
  const turn = store.createTurn(workspaceId, thread.id, input.instructions, actor, null, {
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    agentId: 'knowledge-manager',
    executorKind: 'assistant',
    triggerSource: {
      kind: input.trigger === 'schedule' ? 'automation' : 'system-input',
      summary: 'User Memory maintenance.',
    },
  });
  const workspaceDb = dependencies.openWorkspace(workspaceId);
  const response = (
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
  let outcome: ReturnType<typeof response> | undefined;
  let recorded = false;
  let closed = false;
  let started = false;
  const close = () => {
    if (!closed) {
      workspaceDb.sqlite.close();
      closed = true;
    }
  };
  const record = (result: ReturnType<typeof response>) => {
    if (recorded) return;
    const now = new Date().toISOString();
    store.createItem({
      id: allocateEntityId('it'),
      workspaceId,
      threadId: thread.id,
      turnId: turn.id,
      type: 'status',
      knowledgeMaintenanceResult: result,
      level: result.outcome === 'failed' ? 'error' : 'info',
      title: 'Memory maintenance',
      summary: result.summary,
      status: result.outcome === 'failed' ? 'failed' : 'completed',
      createdAt: now,
      completedAt: now,
    });
    recorded = true;
  };
  const fail = () => {
    const current = store.getTurnById(turn.id);
    const result =
      outcome ??
      response(
        'failed',
        current.error?.message ?? 'Memory maintenance failed. Inspect its retained Turn.'
      );
    record(result);
    if (!isSealedTurnTerminal(current.status))
      store.updateTurn(turn.id, {
        status: input.signal.aborted ? 'cancelled' : 'failed',
        completedAt: new Date().toISOString(),
        error: { code: 'knowledge_maintenance_failed', message: result.summary },
      });
    close();
    return result;
  };
  const settings = () =>
    dependencies.runtimeConfigManager
      .current()
      .userConfigs.find(({ userId }) => userId === userDb.userId)?.config.knowledgeMaintenance ?? {
      enabled: false,
      reviewRequiredPageIds: [],
    };
  try {
    if (priorRuns.some((turn) => !isSealedTurnTerminal(turn.status))) {
      const result = response('skipped', 'Another User Memory maintenance Turn is still active.');
      record(result);
      store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
      close();
      return { turnId: turn.id, execute: async () => result, fail };
    }
    if (input.trigger === 'schedule' && !settings().enabled) {
      const result = response('skipped', 'Daily User Memory maintenance is disabled.');
      record(result);
      store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
      close();
      return { turnId: turn.id, execute: async () => result, fail };
    }
    const files: Record<string, string> = {};
    const sourceFiles: Record<string, string> = {};
    const sources = new Map<string, { contentDigest: string; content: string }>();
    const admittedReferences = new Set<string>();
    const historyReads: Array<{ revision: string; path: string; content: string }> = [];
    let bytes = 0;
    const admitBytes = (content: string) => {
      bytes += Buffer.byteLength(content);
      if (
        Buffer.byteLength(content) > NOTEBOOK_EDITING_LIMITS.fileBytes ||
        bytes > NOTEBOOK_EDITING_LIMITS.workspaceBytes
      )
        throw new NotebookError('invalid_request');
    };
    const selected = input.pageIds ? new Set([...input.pageIds, 'index']) : undefined;
    const suppressed = () =>
      new Set(
        readMemorySuppressions(owner.notebookRoot, userDb.userId).map(
          ({ payload }) => payload.pageId
        )
      );
    const navigationUnavailable = (path: string) =>
      suppressed().size > 0 && ['index.md', 'log.md'].includes(basename(path));
    const readPage = (revision: string, path: string) => {
      // Reserved navigation can still carry forgotten prose. Keep canonical bytes, withhold all
      // such bodies and historical diffs, and invalidate a run if suppression arrives after read.
      if (navigationUnavailable(path) || suppressed().has(path.slice(0, -3)))
        throw new NotebookError('invalid_request');
      // Current owner/schema and Source authority apply also to historical human diffs.
      admitMemoryContext(context);
      const content = notebook.readRevision(revision, [path]).files[path];
      if (content === undefined) throw new NotebookError('recovery_required');
      const admission = readUserMemoryNotebookAdmission(context, { [path]: content });
      const parsed = parseOkfDocument({ path, content });
      const schema = parseScopeKnowledgeSchema(admission.scopeSchemaText);
      if (!parsed.ok || !schema.ok) throw new NotebookError('recovery_required');
      if (
        !parsed.document.reserved &&
        validateScopeKnowledgeSchema(parsed.document, schema.schema, owner.ownerScope).errors.length
      )
        throw new NotebookError('recovery_required');
      return content;
    };
    for (const path of Object.keys(notebook.inspectRevision(baseRevision).entries).sort()) {
      if (
        navigationUnavailable(path) ||
        suppressed().has(path.slice(0, -3)) ||
        (selected && !selected.has(path.slice(0, -3)))
      )
        continue;
      const content = readPage(baseRevision, path);
      const parsed = parseOkfDocument({ path, content });
      if (!parsed.ok) throw new NotebookError('recovery_required');
      if (
        !selected &&
        path !== 'index.md' &&
        (parsed.document.reserved || parsed.document.frontmatter.openkit_status !== 'active')
      )
        continue;
      admitBytes(content);
      files[path] = content;
      for (const reference of stringListFrontmatterField(parsed.document, 'source_refs') ?? [])
        admittedReferences.add(reference);
    }
    for (const id of input.pageIds ?? [])
      if (!Object.hasOwn(files, `${id}.md`)) throw new NotebookError('invalid_request');
    // Supplied information uses the existing immutable literal Source owner, not conversation crawling.
    const readSource = (sourceId: string) => {
      const retained = readUserKnowledgeSource(context, sourceId, 'model');
      if (!retained) throw new NotebookError('invalid_request');
      return { contentDigest: retained.source.contentDigest, content: retained.content };
    };
    const admitSource = (reference: string) => {
      const normalized = reference.startsWith('source:') ? reference : `source:${reference}`;
      const { targetId } = resolveRegisteredKnowledgeSourceReference(normalized, new Map());
      if (!targetId) throw new NotebookError('invalid_request');
      const source = readSource(targetId);
      if (
        !resolveRegisteredKnowledgeSourceReference(
          normalized,
          new Map([[targetId, source.contentDigest]])
        ).resolved
      )
        throw new NotebookError('invalid_request');
      sources.set(targetId, source);
      admittedReferences.add(normalized);
      admittedReferences.add(`source:${targetId}@${source.contentDigest}`);
    };
    for (const source of input.sources) admitSource(source);
    const assertCurrent = () => {
      input.signal.throwIfAborted();
      admitMemoryContext(context);
      for (const [path, content] of Object.entries(files))
        if (readPage(baseRevision, path) !== content) throw new NotebookError('recovery_required');
      for (const [id, source] of sources)
        if (commandInputHash(readSource(id)) !== commandInputHash(source))
          throw new NotebookError('recovery_required');
      for (const read of historyReads)
        if (readPage(read.revision, read.path) !== read.content)
          throw new NotebookError('recovery_required');
    };
    const controller = new AbortController();
    const createEditor = () =>
      createNotebookAgentEditing({
        notebook,
        baseRevision,
        requestId: input.requestId,
        files,
        sources: sourceFiles,
        signal: AbortSignal.any([input.signal, controller.signal]),
        deadlineMs: Date.now() + 120_000,
        revalidate: assertCurrent,
        submit: async (edit) => {
          if (edit.changes.length > 4) throw new NotebookError('invalid_request');
          assertCurrent();
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
          ].sort();
          if (refs.some((ref) => !admittedReferences.has(ref)))
            throw new NotebookError('invalid_request');
          const resultingFiles = { ...notebook.readRevision(baseRevision).files };
          for (const { path, content } of edit.changes) {
            if (content === null) delete resultingFiles[path];
            else resultingFiles[path] = content;
          }
          const revalidate = (candidateFiles = resultingFiles) => {
            assertCurrent();
            return readUserMemoryNotebookAdmission(
              context,
              candidateFiles,
              edit.changes.map(({ path }) => path)
            );
          };
          const setting = settings();
          const admission = revalidate();
          if (
            setting.enabled &&
            !edit.changes.some(
              ({ path, content }) =>
                admission.reviewRequiredPageIds.includes(path.slice(0, -3)) ||
                (content === null &&
                  Object.hasOwn(notebook.inspectRevision(baseRevision).entries, path))
            )
          ) {
            try {
              const published = await publishNotebook(
                {
                  owner: { kind: 'user', userDb },
                  store,
                  inflightCommands: dependencies.inflightCommands,
                  notebook,
                  producer,
                  actor,
                  publicationAuthority: {
                    kind: 'delegated',
                    settingReference: `user:${userDb.userId}:knowledgeMaintenance:${JSON.stringify(setting)}`,
                    settingDigest: commandInputHash(setting),
                  },
                  revalidate: () => {
                    if (commandInputHash(settings()) !== commandInputHash(setting))
                      throw new NotebookError('review_required');
                    return revalidate();
                  },
                },
                edit
              );
              outcome = response('published', edit.summary, {
                notebookRevision: published.notebookRevision,
              });
              return published;
            } catch (error) {
              if (!(error instanceof NotebookError) || error.code !== 'review_required')
                throw error;
            }
          }
          const proposal = createUserMemoryProposal(
            { ...context, store, inflightCommands: dependencies.inflightCommands, revalidate },
            edit,
            producer,
            refs
          );
          outcome = response('review-required', edit.summary, {
            candidateRevision: proposal.candidateRevision,
            proposalId: proposal.id,
          });
          return {
            outcome: 'review_required',
            proposalId: proposal.id,
            baseRevision,
            candidateRevision: proposal.candidateRevision,
          };
        },
      });
    let editor: ReturnType<typeof createNotebookAgentEditing>;
    const tool = (
      name: string,
      key: string,
      execute: (value: string) => Promise<unknown>
    ): AgentTool => ({
      name,
      description:
        'Edit only the admitted User Memory snapshot. Four changes, 2 MiB per file, 32 MiB total, 64 KiB script/output. Publication requires current native authority.',
      inputSchema: {
        type: 'object',
        properties: { [key]: { type: 'string' } },
        required: [key],
        additionalProperties: false,
      },
      execute: async (value, context) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value) ||
          Object.keys(value).length !== 1 ||
          typeof (value as Record<string, unknown>)[key] !== 'string'
        )
          throw new NotebookError('invalid_request');
        const abort = () => controller.abort();
        if (context.signal.aborted) abort();
        context.signal.addEventListener('abort', abort, { once: true });
        try {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(await execute((value as Record<string, string>)[key]!)),
              },
            ],
          };
        } finally {
          context.signal.removeEventListener('abort', abort);
        }
      },
    });
    const nativeAuthority = { actorRef: actor, requestActor: input.requestActor, assertCurrent };
    const history = createAssistantHistory({
      store,
      coreDb,
      workspaceId,
      threadId: thread.id,
      turnId: turn.id,
      nativeAuthority,
    });
    const tools = [
      history.tool,
      tool('knowledge.notebook-workspace.update', 'script', (script) =>
        editor.workspaceUpdate({ script })
      ),
      tool('knowledge.notebook.update', 'summary', async (summary) => {
        const result = await editor.notebookUpdate({ summary });
        if (result.outcome === 'no_change') outcome = response('no-change', summary);
        if (outcome) record(outcome);
        return result;
      }),
    ];
    const previous = priorRuns.filter((prior) => prior.status === 'completed').at(-1)
      ?.internalExecution?.knowledge?.baseRevision;
    const humanChanges: Array<{ path: string; before: string | null; after: string | null }> = [];
    let cursor: string | null = baseRevision;
    let scanned = 0;
    while (cursor && cursor !== previous && scanned++ < 256) {
      const revision = notebook.inspectRevision(cursor);
      const parent = revision.parentRevision
        ? notebook.inspectRevision(revision.parentRevision)
        : undefined;
      if (revision.metadata.producer.kind === 'user')
        for (const path of new Set([
          ...Object.keys(revision.entries),
          ...Object.keys(parent?.entries ?? {}),
        ])) {
          if (
            navigationUnavailable(path) ||
            suppressed().has(path.slice(0, -3)) ||
            (selected && !selected.has(path.slice(0, -3))) ||
            revision.entries[path] === parent?.entries[path]
          )
            continue;
          const read = (selectedRevision: string | undefined, exists: boolean) => {
            if (!selectedRevision || !exists) return null;
            const content = readPage(selectedRevision, path);
            admitBytes(content);
            historyReads.push({ revision: selectedRevision, path, content });
            return content;
          };
          humanChanges.push({
            path,
            before: read(parent?.revision, Boolean(parent?.entries[path])),
            after: read(revision.revision, Boolean(revision.entries[path])),
          });
          if (humanChanges.length > 256) throw new NotebookError('invalid_request');
        }
      cursor = revision.parentRevision;
    }
    if (cursor && cursor !== previous) throw new NotebookError('invalid_request');
    const makeRun = (): KnowledgeManagerAgentRun => ({
      turn,
      workspaceDb,
      signal: input.signal,
      inputs: {
        purpose: 'maintenance',
        ownerScope: { kind: 'user', userId: userDb.userId },
        baseRevision,
        trigger: input.trigger,
        instructions: input.instructions,
        sourceRange: [],
        ...(input.askingThreadId ? { askingThreadId: input.askingThreadId } : {}),
        ...(input.askingTurnId ? { askingTurnId: input.askingTurnId } : {}),
      },
      tools,
      assertCurrent,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                instructions: input.instructions,
                notebookRevision: baseRevision,
                files: Object.keys(files),
                selectedPageIds: input.pageIds ?? [],
                humanEdits: boundedNotebookDiff(humanChanges, false),
                overview:
                  files['index.md'] === undefined
                    ? { unavailable: true }
                    : excerpt(files['index.md'], 16 * 1024),
                sources: (() => {
                  let remaining = 64 * 1024;
                  return [...sources].map(([id, source]) => {
                    const delivered = excerpt(source.content, remaining);
                    remaining -= Buffer.byteLength(delivered.content);
                    return {
                      reference: `source:${id}@${source.contentDigest}`,
                      file: `/sources/${id}`,
                      ...delivered,
                    };
                  });
                })(),
                sourceHistory:
                  'Only supplied User information, admitted Sources and notebook human edits are learning inputs. Maintenance history is not learning input. thread.history.read accepts only exact current-run compaction ranges.',
              }),
            },
          ],
        },
      ],
      readEvidence: (items) =>
        readInternalContextEvidence({
          store,
          coreDb,
          workspaceId,
          threadId: thread.id,
          nativeAuthority,
          items,
          strategy: 'compaction',
        }),
      resultSchema: {
        type: 'object',
        properties: { summary: { type: 'string', minLength: 1 } },
        required: ['summary'],
        additionalProperties: false,
      },
      validateResult: () => {
        assertCurrent();
        if (!outcome)
          return 'Call knowledge.notebook.update({summary: ...}) first, including when no changes are needed. Then call knowledge.result.';
        history.assertCurrent();
        record(outcome);
      },
    });
    // Pin before returning to a scheduler; literal capture remains within this admitted request execution.
    const pinned = makeRun();
    dependencies.pin(pinned);
    return {
      turnId: turn.id,
      fail,
      execute: async () => {
        if (started || closed) throw new NotebookError('invalid_request');
        started = true;
        try {
          if (input.tellContent !== undefined) {
            const source = await registerUserKnowledgeSource(
              { ...context, store, inflightCommands: dependencies.inflightCommands },
              {
                requestId: input.requestId,
                kind: 'document',
                title: 'Supplied User Memory information',
                content: input.tellContent,
              }
            );
            admitSource(`source:${source.id}@${source.contentDigest}`);
          }
          for (const [id, source] of sources) {
            admitBytes(source.content);
            sourceFiles[id] = source.content;
          }
          editor = createEditor();
          await dependencies.run(makeRun());
          if (!outcome) throw new NotebookError('invalid_request');
          return outcome;
        } catch {
          return fail();
        } finally {
          close();
        }
      },
    };
  } catch {
    const result = fail();
    return { turnId: turn.id, fail, execute: async () => result };
  }
}

/** Executes a fresh bounded run through the existing role runner. */
export async function maintainUserMemoryAgent(
  dependencies: UserMemoryMaintenanceDependencies,
  input: UserMemoryMaintenanceInput
) {
  return prepareUserMemoryMaintenance(dependencies, input).execute();
}

/** Retains request admission before inference and replays the native Status result without another model call. */
export async function runUserMemoryMaintenanceCommand(
  dependencies: UserMemoryMaintenanceDependencies,
  input: UserMemoryMaintenanceInput
) {
  const context = {
    coreDb: dependencies.coreDb,
    userDb: dependencies.userDb,
    actor: input.requestActor,
  };
  admitMemoryContext(context);
  const command = input.tellContent === undefined ? 'knowledge.maintain' : 'knowledge.tell';
  const scope = { userId: dependencies.userDb.userId, actorId: input.requestActor.userId };
  const canonicalInput = {
    ownerScope: { kind: 'user', userId: dependencies.userDb.userId },
    instructions: input.instructions,
    sources: input.sources,
    pageIds: input.pageIds,
    tellContent: input.tellContent,
    askingThreadId: input.askingThreadId,
    askingTurnId: input.askingTurnId,
    trigger: input.trigger,
  };
  return runIdempotentCommand({
    store: dependencies.store,
    receiptDb: dependencies.userDb,
    inflightCommands: dependencies.inflightCommands,
    command,
    requestId: input.requestId,
    scope,
    input: canonicalInput,
    responseKind: 'turn',
    responseId: (result) => result.turnId,
    execute: async () => {
      const prepared = prepareUserMemoryMaintenance(dependencies, input);
      dependencies.store.recordCommandRequest(
        {
          command,
          requestId: input.requestId,
          scope,
          inputHash: commandInputHash(canonicalInput),
          response: { kind: 'turn', id: prepared.turnId },
        },
        dependencies.userDb
      );
      return prepared.execute();
    },
    replay: (receipt) => {
      admitMemoryContext(context);
      const turn = dependencies.store.getTurnById(receipt.response.id);
      const thread = dependencies.store.getThread(turn.workspaceId, turn.threadId);
      if (
        turn.agentId !== 'knowledge-manager' ||
        thread.visibility !== 'private' ||
        thread.privateOwnerUserId !== dependencies.userDb.userId ||
        turn.triggerActor.kind !== 'user' ||
        turn.triggerActor.id !== dependencies.userDb.userId ||
        turn.triggerSource?.summary !== 'User Memory maintenance.' ||
        (turn.internalExecution?.knowledge &&
          (turn.internalExecution.knowledge.ownerScope.kind !== 'user' ||
            turn.internalExecution.knowledge.ownerScope.userId !== dependencies.userDb.userId))
      )
        throw new OperationError(
          'recovery_required',
          'User Memory maintenance requires inspection.',
          409
        );
      const retained = turn.items.findLast(
        (item) => item.type === 'status' && item.knowledgeMaintenanceResult
      );
      if (retained?.type === 'status')
        return KnowledgeMaintenanceResponseSchema.parse(retained.knowledgeMaintenanceResult);
      throw new OperationError(
        'recovery_required',
        'The admitted Memory maintenance Turn has no settled result. Inspect it; use a new request for new work.',
        409
      );
    },
  });
}

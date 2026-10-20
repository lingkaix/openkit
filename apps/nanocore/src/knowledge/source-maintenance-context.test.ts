// openkit-test-platform: posix
// Actual scoped Git, raw Storage and virtual editor surround only the bounded role double.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ContentReferenceSchema } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type {
  KnowledgeManagerAgentRun,
  ServerKnowledgeManagerAgentRun,
} from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { KnowledgeNotebook } from './notebook.js';
import { parseOkfDocument, stringListFrontmatterField } from './okf.js';
import { readUserKnowledgeSource } from './scoped-knowledge-sources.js';
import {
  prepareServerKnowledgeMaintenance,
  type ServerKnowledgeMaintenanceDependencies,
} from './server-knowledge-maintenance.js';
import {
  readServerKnowledgeSource,
  registerServerKnowledgeSource,
} from './server-knowledge-owner.js';
import {
  runUserMemoryMaintenanceCommand,
  type UserMemoryMaintenanceDependencies,
} from './user-memory-agent-maintenance.js';

const original = 'Remember this exact fact.\r\nThe release label is GREEN-ORBIT-7. Ω 雪.\n';
const digest = `sha256:${createHash('sha256').update(Buffer.from(original)).digest('hex')}`;

/** Real current owner, capture, retained Turn and publication; only external role reasoning is replaced. */
function fixture(kind: 'user' | 'server') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'source-maintenance-context-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const userDb = kind === 'user' ? openUserDb(dataRoot, userId) : undefined;
  if (userDb) applyScopedMigrations(userDb);
  const actor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  const scope = kind === 'user' ? { kind: 'user' as const, userId } : { kind: 'server' as const };
  const root =
    kind === 'user'
      ? join(dataRoot, 'users', userId, 'memory')
      : join(dataRoot, 'server', 'knowledge');
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const deliveries: {
    baseRevision: string;
    sourceId: string;
    reference: string;
    content: string;
    editorContent: string;
  }[] = [];
  const run = vi.fn(async (input: KnowledgeManagerAgentRun | ServerKnowledgeManagerAgentRun) => {
    const payload = JSON.parse(
      input.messages[0]!.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(
        ''
      )
    );
    const supplied = payload.sources[0];
    expect(supplied.content).toBe(original);
    expect(supplied.truncated).toBe(false);
    const match = /^source:([^@]+)@(sha256:[0-9a-f]{64})$/.exec(supplied.reference)!;
    expect(match).not.toBeNull();
    expect(match[2]).toBe(digest);
    const sourceId = match[1]!;
    expect(input.inputs?.baseRevision).toBe(notebook.publishedRevision());
    expect(payload.notebookRevision).toBe(input.inputs?.baseRevision);
    expect(notebook.readSourcePointers(input.inputs!.baseRevision)).toHaveProperty(sourceId);
    const execute = (name: string, value: unknown) =>
      input.tools
        .find((tool) => tool.name === name)!
        .execute(value, { callId: randomUUID(), toolOccurrence: 1, signal: input.signal });
    const inspected = await execute('knowledge.notebook-workspace.update', {
      script: `cat /sources/${sourceId}`,
    });
    const text = inspected.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    const editor = JSON.parse(text);
    expect(editor).toMatchObject({ exitCode: 0, stdout: original, truncated: false });
    deliveries.push({
      baseRevision: input.inputs!.baseRevision,
      sourceId,
      reference: supplied.reference,
      content: supplied.content,
      editorContent: editor.stdout,
    });
    const page = serializeKnowledgePageFixture(
      {
        title: 'Release label',
        content: original,
        sourceReferences: [supplied.reference],
        createdAt: '2026-10-19T00:00:00.000Z',
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
      scope
    );
    const edited = await execute('knowledge.notebook-workspace.update', {
      script: `cat > release-label.md <<'PAGE'\n${page}\nPAGE\nprintf '\\n[Release label](release-label.md)\\n' >> index.md`,
    });
    expect(
      JSON.parse(
        edited.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      ).exitCode
    ).toBe(0);
    await execute('knowledge.notebook.update', {
      summary: 'Retain the supplied exact Source fact.',
    });
    expect(input.validateResult('{"summary":"Recorded the release label."}')).toBeUndefined();
    const patch = { status: 'completed' as const, completedAt: new Date().toISOString() };
    if (input.turn.owner.kind === 'server') store.updateServerTurn(input.turn.id, patch);
    else store.updateTurn(input.turn.id, patch);
    return { turnId: input.turn.id, text: '{"summary":"Recorded the release label."}' };
  });
  const pin = (
    input: Pick<KnowledgeManagerAgentRun | ServerKnowledgeManagerAgentRun, 'turn' | 'inputs'>
  ) => {
    const patch = {
      internalExecution: {
        roleId: 'knowledge-manager' as const,
        logicalModelId: 'fixture-model',
        limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 300_000 },
        contextStrategy: 'compaction' as const,
        threshold: 1000,
        knowledge: input.inputs!,
      },
    };
    if (input.turn.owner.kind === 'server') store.updateServerTurn(input.turn.id, patch);
    else store.updateTurn(input.turn.id, patch);
  };
  const runtimeConfigManager = {
    current: () => ({
      userConfigs: [
        { userId, config: { knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] } } },
      ],
      openKitConfig: { knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] } },
    }),
  } as unknown as RuntimeConfigManager;
  const dependencies = {
    coreDb,
    store,
    runtimeConfigManager,
    inflightCommands: new WeakMap(),
    run,
    pin,
  };
  onTestFinished(() => {
    userDb?.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    dataRoot,
    coreDb,
    userDb,
    actor,
    store,
    scope,
    root,
    notebook,
    deliveries,
    run,
    dependencies,
  };
}

/** The published pointer and actual original establish capture independently of any role call. */
function captured(f: ReturnType<typeof fixture>) {
  const revision = f.notebook.publishedRevision();
  const pointers = f.notebook.readSourcePointers(revision);
  expect(Object.keys(pointers)).toHaveLength(1);
  const sourceId = Object.keys(pointers)[0]!;
  const parsed = parseOkfDocument({ path: `sources/${sourceId}.md`, content: pointers[sourceId]! });
  if (!parsed.ok) throw new Error('Expected actual published SourceSummary bytes.');
  expect(parsed.document.frontmatter).toMatchObject({
    type: 'SourceSummary',
    scope: f.scope,
    byteLength: Buffer.byteLength(original),
    captureChannel: 'knowledge.source.register',
  });
  const reference = ContentReferenceSchema.parse(parsed.document.frontmatter.contentRef);
  expect(reference.locator.ownerScope).toEqual(f.scope);
  expect(reference.knowledgeBaseId).toBe(
    readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: f.scope })
  );
  expect(reference.locator.mount).toBe('managed');
  expect(reference.contentDigest).toBe(digest);
  const rawRoot = resolve(f.root, 'raw');
  const rawPath = resolve(rawRoot, reference.locator.path);
  const confined = relative(rawRoot, rawPath);
  expect(isAbsolute(confined) || confined === '..' || confined.startsWith('../')).toBe(false);
  expect(readFileSync(rawPath)).toEqual(Buffer.from(original));
  return {
    revision,
    sourceId,
    reference: `source:${sourceId}@${digest}`,
    content: pointers[sourceId]!,
  };
}

describe('canonical Source inputs to bounded maintenance', () => {
  it('captures User tell before fixing the actual editor base and replays without a second role run', async () => {
    const f = fixture('user');
    const dependencies: UserMemoryMaintenanceDependencies = {
      ...f.dependencies,
      userDb: f.userDb!,
      openWorkspace: (workspaceId) => openWorkspaceDb(f.dataRoot, workspaceId),
    };
    const input = {
      requestId: randomUUID(),
      requestActor: f.actor,
      trigger: 'request' as const,
      instructions: 'Remember this release label.',
      sources: [],
      tellContent: original,
      signal: new AbortController().signal,
    };
    const result = await runUserMemoryMaintenanceCommand(dependencies, input);
    const source = captured(f);
    expect(
      (await readUserKnowledgeSource({ ...dependencies, actor: f.actor }, source.sourceId, 'model'))
        ?.content
    ).toBe(original);
    expect(result.outcome).toBe('published');
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.deliveries).toHaveLength(1);
    const delivered = f.deliveries[0]!;
    expect(delivered).toMatchObject({
      sourceId: source.sourceId,
      reference: source.reference,
      content: original,
      editorContent: original,
    });
    const published = f.notebook.readRevision(result.notebookRevision);
    expect(f.notebook.inspectRevision(result.notebookRevision).parentRevision).toBe(
      delivered.baseRevision
    );
    expect(f.notebook.readSourcePointers(delivered.baseRevision)[source.sourceId]).toBe(
      source.content
    );
    const turn = f.store.getTurnById(result.turnId);
    expect(turn.internalExecution?.knowledge).toMatchObject({
      purpose: 'maintenance',
      ownerScope: f.scope,
      baseRevision: delivered.baseRevision,
    });
    const page = parseOkfDocument({
      path: 'release-label.md',
      content: published.files['release-label.md']!,
    });
    if (!page.ok) throw new Error('Maintenance must publish a governed page.');
    expect(page.document.body).toContain('The release label is GREEN-ORBIT-7. Ω 雪.');
    expect(stringListFrontmatterField(page.document, 'source_refs')).toEqual([source.reference]);
    expect(await runUserMemoryMaintenanceCommand(dependencies, input)).toEqual(result);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.notebook.publishedRevision()).toBe(result.notebookRevision);
    expect(f.notebook.readSourcePointers(result.notebookRevision)[source.sourceId]).toBe(
      source.content
    );
  });

  it('retains a Server Turn synchronously then delivers an existing Source only during execution', async () => {
    const f = fixture('server');
    const writer = { ...f.dependencies, actor: f.actor };
    const registered = await registerServerKnowledgeSource(writer, {
      requestId: randomUUID(),
      kind: 'document',
      title: 'Existing Server fact',
      content: original,
    });
    expect(await readServerKnowledgeSource(writer, registered.id)).toEqual({
      source: registered,
      content: original,
    });
    const source = captured(f);
    const dependencies: ServerKnowledgeMaintenanceDependencies = f.dependencies;
    const prepared = prepareServerKnowledgeMaintenance(dependencies, {
      requestId: randomUUID(),
      requestActor: f.actor,
      actor: { kind: 'user', id: f.actor.userId },
      trigger: 'request',
      instructions: 'Integrate the supplied existing Source.',
      sources: [source.reference],
      signal: new AbortController().signal,
    });
    expect(prepared).not.toHaveProperty('then');
    expect(f.store.getServerTurnById(prepared.turnId).id).toBe(prepared.turnId);
    expect(f.run).not.toHaveBeenCalled();
    const result = await prepared.execute();
    expect(await readServerKnowledgeSource(writer, registered.id)).toEqual({
      source: registered,
      content: original,
    });
    expect(result.outcome).toBe('published');
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.deliveries).toEqual([
      {
        baseRevision: source.revision,
        sourceId: source.sourceId,
        reference: source.reference,
        content: original,
        editorContent: original,
      },
    ]);
    const turn = f.store.getServerTurnById(prepared.turnId);
    expect(turn.internalExecution?.knowledge).toMatchObject({
      ownerScope: f.scope,
      baseRevision: source.revision,
    });
    expect(f.notebook.inspectRevision(result.notebookRevision).parentRevision).toBe(
      source.revision
    );
    const published = f.notebook.readRevision(result.notebookRevision);
    expect(published.files['release-label.md']).toContain('GREEN-ORBIT-7');
    const parsed = parseOkfDocument({
      path: 'release-label.md',
      content: published.files['release-label.md']!,
    });
    if (!parsed.ok) throw new Error('Server maintenance must publish a governed page.');
    expect(stringListFrontmatterField(parsed.document, 'source_refs')).toEqual([source.reference]);
    expect(f.notebook.readSourcePointers(result.notebookRevision)[source.sourceId]).toBe(
      source.content
    );
  });
});

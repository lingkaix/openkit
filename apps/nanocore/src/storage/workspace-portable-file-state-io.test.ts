// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeRetainedV1 } from '@openkit/protocol';

import { describe, expect, it, onTestFinished } from 'vitest';
import { createWorkerContextPackageFiles } from '../context/worker-context-package.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { prepareWorkspaceKnowledgeSelection } from './control-store-knowledge.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { readAdmittedWorkspaceKnowledgeSelection } from './workspace-file-records.js';

import {
  readWorkspacePortableFileState,
  writeWorkspacePortableExportState,
  writeWorkspacePortableFileState,
} from './workspace-portable-file-state.js';

const JULY = '2026-07-01T00:00:00.000Z';
const PORTABLE_TURN = {
  threadId: 'th_00000000-0000-7d57-bb9a-837e048d6465',
  turnId: 'tu_00000000-0000-7533-bc6b-7efa7795a620',
} as const;
/** Authored source config. The comment and spacing must survive the portable write byte for byte. */
function authoredWorkspaceConfig(knowledgeBaseId: string): string {
  return `{\n  // exact comment\n  "schemaVersion": 1,\n  "workspace": { "name": "Portable file fixture", "defaultKnowledgeBaseId": "${knowledgeBaseId}" }\n}\n`;
}

/** Target seed. Same Knowledge Base binding, different bytes, so equality requires the config write. */
function distinctTargetWorkspaceConfig(knowledgeBaseId: string): string {
  return `{\n  "schemaVersion": 1,\n  "workspace": { "name": "Distinct target seed", "defaultKnowledgeBaseId": "${knowledgeBaseId}" }\n}\n`;
}

/** Page bytes the portable reader must return from the selected Notebook commit. */
const PORTABLE_PAGES = {
  'native.md':
    '---\ntype: "RepoConvention"\ntitle: "Native"\nfuture_note: "retained"\n---\nNative page.\n',
  'nested/native.md':
    '---\ntype: "RepoConvention"\ntitle: "Nested native"\n---\nNested native page.\n',
  'nested/index.md': '# Nested authored index\n\nKeep this navigation byte-for-byte.\n',
  'nested/log.md': '# Nested authored log\n\nKeep this history byte-for-byte.\n',
  'kn_owned.md':
    '---\ntype: "KnowledgePage"\ntitle: "Owned"\nopenkit_entry_id: "kn_owned"\n---\nOwned page.\n',
} as const;

/** Valid v4 scope schema. The description is the marker export must keep byte for byte. */
const PORTABLE_SCOPE_SCHEMA_TEXT = `${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.trimEnd()}
description: "Portable export schema marker"
`;

/** Creates one empty directory for a staging or export root. */
function workspaceRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Binds the retained Thread and Turn ids to the Workspace the native owner actually created. */
function portableOwners(workspaceId: string) {
  return {
    workspaceId,
    threads: [{ threadId: PORTABLE_TURN.threadId }],
    turns: [PORTABLE_TURN],
  } as const;
}

/** Opens one real Workspace, including db/workspace.sqlite, through the existing Store owner. */
async function admittedWorkspace(prefix: string): Promise<{
  dataRoot: string;
  workspaceRoot: string;
  workspaceId: string;
  store: FsStore;
}> {
  const dataRoot = mkdtempSync(join(tmpdir(), prefix));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(async () => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    closeWorkspaceProductReadHandles(dataRoot);
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Portable file fixture', {
    requestId: randomUUID(),
    producer: { kind: 'user', id: LOCAL_USER_ID },
    instructionReference: 'test-fixture:portable-files',
  });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: LOCAL_USER_ID,
    workspaceId: workspace.id,
  });
  return {
    dataRoot,
    workspaceRoot: join(dataRoot, 'workspaces', workspace.id),
    workspaceId: workspace.id,
    store,
  };
}

/** Publishes the retained page bytes on the SQL-selected Notebook commit. */
async function publishPortablePages(input: {
  dataRoot: string;
  store: FsStore;
  workspaceId: string;
  workspaceRoot: string;
}): Promise<void> {
  const workspaceDb = openWorkspaceDb(input.dataRoot, input.workspaceId);
  try {
    const selection = readAdmittedWorkspaceKnowledgeSelection(
      input.workspaceRoot,
      input.workspaceId
    );
    const candidateRevision = selection.notebook.prepare({
      baseRevision: selection.head.notebookCommit,
      changes: PORTABLE_PAGES,
      metadata: {
        summary: 'Publish portable test bytes',
        producer: { kind: 'user', id: LOCAL_USER_ID },
        authority: { kind: 'direct', instructionReference: 'test:portable-pages' },
        changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash(PORTABLE_PAGES) },
        sourceReferences: [],
      },
    });
    const nextHead = await prepareWorkspaceKnowledgeSelection({
      db: workspaceDb,
      workspaceRoot: input.workspaceRoot,
      notebook: selection.notebook,
      knowledgeBaseId: selection.head.knowledgeBaseId,
      notebookCommit: candidateRevision,
      schemaText: PORTABLE_SCOPE_SCHEMA_TEXT,
    });
    await input.store.commitWorkspaceKnowledge({
      workspaceDb,
      expectedHead: selection.head,
      nextHead,
      audits: [],
      revalidatePublication: () => {
        const current = readAdmittedWorkspaceKnowledgeSelection(
          input.workspaceRoot,
          input.workspaceId
        );
        if (!isDeepStrictEqual(current.head, selection.head))
          throw new Error('Fixture Workspace Knowledge head changed.');
      },
    });
  } finally {
    if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
  }
}

/** Copies the admitted SQL selection so a second root reads the same Notebook commit. */
function copyAdmittedAuthority(sourceRoot: string, targetRoot: string): void {
  const knowledgeBaseId = readAdmittedWorkspaceKnowledgeSelection(sourceRoot, basename(sourceRoot))
    .head.knowledgeBaseId;
  closeWorkspaceProductReadHandles(sourceRoot);
  const workspaceDb = openWorkspaceDb(dirname(dirname(sourceRoot)), basename(sourceRoot));
  workspaceDb.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  workspaceDb.sqlite.close();
  for (const name of ['db', 'knowledge']) {
    cpSync(join(sourceRoot, name), join(targetRoot, name), { recursive: true });
  }
  mkdirSync(join(targetRoot, 'config'), { recursive: true });
  writeFileSync(
    join(targetRoot, 'config', 'workspace.jsonc'),
    distinctTargetWorkspaceConfig(knowledgeBaseId)
  );
}

/** Creates a real Workspace and writes the retained trace and Context Package files onto it. */
async function portableSource(prefix: string): Promise<{
  root: string;
  owners: ReturnType<typeof portableOwners>;
  knowledgeBaseId: string;
}> {
  const admitted = await admittedWorkspace(prefix);
  await publishPortablePages(admitted);
  const knowledgeBaseId = readAdmittedWorkspaceKnowledgeSelection(
    admitted.workspaceRoot,
    admitted.workspaceId
  ).head.knowledgeBaseId;
  writeFileSync(
    join(admitted.workspaceRoot, 'config', 'workspace.jsonc'),
    authoredWorkspaceConfig(knowledgeBaseId)
  );
  writePortableTraces(admitted.workspaceRoot, admitted.workspaceId, knowledgeBaseId);
  return {
    root: admitted.workspaceRoot,
    owners: portableOwners(admitted.workspaceId),
    knowledgeBaseId,
  };
}

/** Writes the retained trace and Context Package files under one admitted Workspace. */
function writePortableTraces(root: string, workspaceId: string, knowledgeBaseId: string): void {
  const retrieval = {
    traceId: 'krt_00000000-0000-780e-b78f-51422afca1e9',
    queryContext: {
      serverId: 'server_portable_source',
      workspaceId,
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      threadId: PORTABLE_TURN.threadId,
      turnId: PORTABLE_TURN.turnId,
    },
    sourceScope: `page/workspace/${workspaceId}/${knowledgeBaseId}`,
    notebookRevision: null,
    caller: 'app-api',
    requestDigest: `sha256:${'0'.repeat(64)}`,
    retrievalParameters: {
      limit: 1,
      pinnedReferences: [],
      states: ['active'],
      sourceScope: 'workspace',
    },
    createdAt: JULY,
    selected: [],
    excluded: [],
  };

  const retrievalPath = join(
    root,
    'threads',
    PORTABLE_TURN.threadId,
    'turns',
    PORTABLE_TURN.turnId,
    'retrieval-traces',
    `${retrieval.traceId}.json`
  );
  mkdirSync(dirname(retrievalPath), { recursive: true });
  writeFileSync(retrievalPath, `${JSON.stringify(writeRetainedV1(retrieval))}\n`);
  const threadRetrieval = {
    ...retrieval,
    traceId: 'krt_00000000-0000-7afe-9d7a-6a1fdf1c3d36',
    queryContext: {
      ...retrieval.queryContext,
      turnId: undefined,
    },
  };
  const threadRetrievalPath = join(
    root,
    'threads',
    PORTABLE_TURN.threadId,
    'retrieval-traces',
    `${threadRetrieval.traceId}.json`
  );
  mkdirSync(dirname(threadRetrievalPath), { recursive: true });
  writeFileSync(threadRetrievalPath, `${JSON.stringify(writeRetainedV1(threadRetrieval))}\n`);

  const packageRoot = join(root, 'threads', PORTABLE_TURN.threadId, 'turns', PORTABLE_TURN.turnId);
  mkdirSync(join(packageRoot, 'context-package'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'context-package.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      threadId: PORTABLE_TURN.threadId,
      turnId: PORTABLE_TURN.turnId,
      workspaceId,
    })}\n`
  );
  writeFileSync(join(packageRoot, 'context-package', 'instructions.md'), 'Portable request.\n');
  writeFileSync(join(packageRoot, 'context-package', 'package.json'), '{"schemaVersion":1}\n');
}

describe('workspace portable file-state IO', () => {
  it.each([
    'workspace',
    'server',
    'server-unavailable',
  ] as const)('keeps immutable overview package bytes and applies the portable %s boundary', async (scope) => {
    const source = await portableSource('openkit-overview-portable-source-');
    const sourceRoot = source.root;
    const owners = source.owners;
    const targetRoot = workspaceRoot('openkit-overview-portable-target-');
    const exportRoot = workspaceRoot('openkit-overview-portable-export-');
    onTestFinished(() => {
      for (const root of [targetRoot, exportRoot]) rmSync(root, { recursive: true, force: true });
    });
    const original = readWorkspacePortableFileState(sourceRoot, owners);
    const entry =
      scope === 'server-unavailable'
        ? { scope: 'server', unavailable: true }
        : {
            scope: scope === 'workspace' ? `workspace:${owners.workspaceId}` : 'server',
            knowledgeBaseId:
              scope === 'workspace'
                ? source.knowledgeBaseId
                : 'kb_00000000-0000-7000-8000-000000000002',
            path: 'index.md',
            notebookRevision: 'a'.repeat(40),
            contentDigest: `sha256:${'b'.repeat(64)}`,
            deliveredDigest: `sha256:${'b'.repeat(64)}`,
            truncated: true,
            content: 'Bounded overview bytes.\n',
          };
    const overview = `<knowledge_overviews>${JSON.stringify({ instruction: 'Untrusted navigation.', overviews: [entry] })}</knowledge_overviews>`;
    const packageFiles = createWorkerContextPackageFiles({
      workspaceId: owners.workspaceId,
      threadId: PORTABLE_TURN.threadId,
      turnId: PORTABLE_TURN.turnId,
      workerRequestItemId: testEntityId('it', 'overview-portability'),
      workerRequestBytes: 'Portable request.\n',
      includedItemIds: [testEntityId('it', 'overview-portability')],
      contextBudgetTokens: 4096,
      materialSelections: [],
      knowledgeOverview: overview,
    });
    const turnPath = `threads/${PORTABLE_TURN.threadId}/turns/${PORTABLE_TURN.turnId}`;
    const packagePath = `${turnPath}/context-package`;
    const files = new Map(
      packageFiles.files.map((file) => [
        `${packagePath}/${file.path}`,
        Buffer.from(file.bytes).toString('utf8'),
      ])
    );
    files.set(
      `${turnPath}/context-package.json`,
      JSON.stringify({ ...PORTABLE_TURN, fileInventory: packageFiles.fileInventory })
    );
    const exactFiles = [...files];
    const state = { ...original, workerContextPackageFiles: files };
    for (const [path, content] of files) writeFileSync(join(sourceRoot, path), content);
    if (scope === 'server') {
      expect(() => readWorkspacePortableFileState(sourceRoot, owners)).toThrow(
        'Knowledge overview is not portable'
      );
      expect(() => writeWorkspacePortableFileState(targetRoot, state)).toThrow(
        'Knowledge overview is not portable'
      );
      expect(() => writeWorkspacePortableExportState(exportRoot, state)).toThrow(
        'Knowledge overview is not portable'
      );
      expect(existsSync(join(targetRoot, packagePath, 'knowledge-overview.md'))).toBe(false);
      expect(
        existsSync(join(exportRoot, 'workspace-files', packagePath, 'knowledge-overview.md'))
      ).toBe(false);
    } else {
      expect(
        Object.fromEntries(
          readWorkspacePortableFileState(sourceRoot, owners).workerContextPackageFiles
        )
      ).toEqual(Object.fromEntries(exactFiles));
      copyAdmittedAuthority(sourceRoot, targetRoot);
      writeWorkspacePortableFileState(targetRoot, state);
      expect(
        Object.fromEntries(
          readWorkspacePortableFileState(targetRoot, owners).workerContextPackageFiles
        )
      ).toEqual(Object.fromEntries(exactFiles));
      writeWorkspacePortableExportState(exportRoot, state);
      for (const [path, content] of files)
        expect(readFileSync(join(exportRoot, 'workspace-files', path), 'utf8')).toBe(content);
    }
    // Refusal or roundtrip never strips content or recomputes the source inventory.
    expect([...state.workerContextPackageFiles]).toEqual(exactFiles);
    for (const [path, content] of files)
      expect(readFileSync(join(sourceRoot, path), 'utf8')).toBe(content);
  });

  it('retains canonical page annotations while excluding ignored trace fields from portable writes', async () => {
    const sourceFixture = await portableSource('openkit-knowledge-extended-');
    const source = sourceFixture.root;
    const owners = sourceFixture.owners;
    const target = workspaceRoot('openkit-knowledge-rewritten-');
    onTestFinished(() => rmSync(target, { recursive: true, force: true }));
    const retrievalPath = join(
      source,
      'threads',
      PORTABLE_TURN.threadId,
      'turns',
      PORTABLE_TURN.turnId,
      'retrieval-traces',
      'krt_00000000-0000-780e-b78f-51422afca1e9.json'
    );
    const retrieval = JSON.parse(readFileSync(retrievalPath, 'utf8'));
    retrieval.futureNote = 'retained';
    retrieval.retrievalParameters.futureNote = 'retained';
    writeFileSync(retrievalPath, `${JSON.stringify(retrieval)}\n`);
    const state = readWorkspacePortableFileState(source, owners);
    expect(JSON.stringify([...state.retrievalTraceFiles.values()])).not.toContain('futureNote');
    expect(readFileSync(retrievalPath, 'utf8')).toContain('futureNote');
    // The import coordinator owns content publication; the file-state writer owns only its other families.
    copyAdmittedAuthority(source, target);
    writeWorkspacePortableFileState(target, state);
    const reopened = readWorkspacePortableFileState(target, owners);
    expect(reopened.retrievalTraceFiles).toEqual(state.retrievalTraceFiles);
    expect(reopened.nativeKnowledgePages).toEqual(state.nativeKnowledgePages);
    expect(reopened.nativeKnowledgePages.get('knowledge/pages/native.md')).toContain(
      'future_note: "retained"'
    );
    expect(
      readFileSync(
        join(
          target,
          'threads',
          PORTABLE_TURN.threadId,
          'turns',
          PORTABLE_TURN.turnId,
          'retrieval-traces',
          'krt_00000000-0000-780e-b78f-51422afca1e9.json'
        ),
        'utf8'
      )
    ).not.toContain('futureNote');
  });
  it('round-trips canonical Notebook pages and exact workspace-owned text', async () => {
    const source = await portableSource('openkit-portable-state-source-');
    const sourceRoot = source.root;
    const owners = source.owners;
    const targetRoot = workspaceRoot('openkit-portable-state-target-');
    onTestFinished(() => rmSync(targetRoot, { recursive: true, force: true }));
    copyAdmittedAuthority(sourceRoot, targetRoot);
    mkdirSync(join(targetRoot, 'knowledge', 'pages'), { recursive: true });
    writeFileSync(join(targetRoot, 'knowledge', 'schema', 'scope-schema.yaml'), 'default: true\n');
    writeFileSync(
      join(targetRoot, 'knowledge', 'pages', 'kn_target.md'),
      '---\nopenkit_entry_id: "kn_target"\n---\nTarget owned page.\n'
    );

    const state = readWorkspacePortableFileState(sourceRoot, owners);

    expect([...state.nativeKnowledgePages.keys()]).toEqual([
      'knowledge/pages/index.md',
      'knowledge/pages/kn_owned.md',
      'knowledge/pages/native.md',
      'knowledge/pages/nested/index.md',
      'knowledge/pages/nested/log.md',
      'knowledge/pages/nested/native.md',
    ]);
    expect(state.nativeKnowledgePages.get('knowledge/pages/kn_owned.md')).toContain(
      'openkit_entry_id: "kn_owned"'
    );
    expect([...state.workerContextPackageFiles]).toEqual([
      [
        'threads/th_00000000-0000-7d57-bb9a-837e048d6465/turns/tu_00000000-0000-7533-bc6b-7efa7795a620/context-package.json',
        `{"schemaVersion":1,"threadId":"th_00000000-0000-7d57-bb9a-837e048d6465","turnId":"tu_00000000-0000-7533-bc6b-7efa7795a620","workspaceId":"${owners.workspaceId}"}\n`,
      ],
      [
        'threads/th_00000000-0000-7d57-bb9a-837e048d6465/turns/tu_00000000-0000-7533-bc6b-7efa7795a620/context-package/instructions.md',
        'Portable request.\n',
      ],
      [
        'threads/th_00000000-0000-7d57-bb9a-837e048d6465/turns/tu_00000000-0000-7533-bc6b-7efa7795a620/context-package/package.json',
        '{"schemaVersion":1}\n',
      ],
    ]);

    writeWorkspacePortableFileState(targetRoot, state);

    const roundTripped = readWorkspacePortableFileState(targetRoot, owners);
    for (const [path, content] of state.nativeKnowledgePages) {
      expect(roundTripped.nativeKnowledgePages.get(path)).toBe(content);
    }
    expect(readFileSync(join(targetRoot, 'config', 'workspace.jsonc'), 'utf8')).toBe(
      state.workspaceConfig
    );
    expect(readFileSync(join(targetRoot, 'knowledge', 'schema', 'scope-schema.yaml'), 'utf8')).toBe(
      PORTABLE_SCOPE_SCHEMA_TEXT
    );
    expect(readFileSync(join(targetRoot, 'knowledge', 'pages', 'kn_target.md'), 'utf8')).toContain(
      'openkit_entry_id: "kn_target"'
    );
  });

  it('rejects strict-schema and physical-boundary violations', async () => {
    const malformed = await portableSource('openkit-portable-state-malformed-');
    const linked = await portableSource('openkit-portable-state-linked-');
    const malformedRoot = malformed.root;
    const linkedRoot = linked.root;
    const outsideRoot = workspaceRoot('openkit-portable-state-outside-');
    onTestFinished(() => rmSync(outsideRoot, { recursive: true, force: true }));

    const malformedTracePath = join(
      malformedRoot,
      'threads',
      PORTABLE_TURN.threadId,
      'turns',
      PORTABLE_TURN.turnId,
      'retrieval-traces',
      'krt_00000000-0000-780e-b78f-51422afca1e9.json'
    );
    const malformedTrace = JSON.parse(readFileSync(malformedTracePath, 'utf8'));
    malformedTrace.caller = 'unsupported';
    writeFileSync(malformedTracePath, `${JSON.stringify(malformedTrace)}\n`);
    expect(() => readWorkspacePortableFileState(malformedRoot, malformed.owners)).toThrow();

    writeFileSync(join(outsideRoot, 'sentinel.txt'), 'untouched\n');
    symlinkSync(
      join(outsideRoot, 'sentinel.txt'),
      join(
        linkedRoot,
        'threads',
        PORTABLE_TURN.threadId,
        'retrieval-traces',
        'krt_00000000-0000-780e-b78f-51422afca1ea.json'
      )
    );
    expect(() => readWorkspacePortableFileState(linkedRoot, linked.owners)).toThrow(
      /symbolic link/i
    );
    expect(readFileSync(join(outsideRoot, 'sentinel.txt'), 'utf8')).toBe('untouched\n');
  });

  it.each([
    {
      name: 'orphan Turn package',
      knownTurns: [],
      alter: (_root: string) => undefined,
    },
    {
      name: 'incomplete Turn package',
      knownTurns: [PORTABLE_TURN],
      alter: (root: string) =>
        rmSync(
          join(
            root,
            'threads',
            PORTABLE_TURN.threadId,
            'turns',
            PORTABLE_TURN.turnId,
            'context-package.json'
          )
        ),
    },
  ])('rejects $name', async ({ knownTurns, alter }) => {
    const source = await portableSource('openkit-portable-state-invalid-worker-package-');
    alter(source.root);

    expect(() =>
      readWorkspacePortableFileState(source.root, {
        ...source.owners,
        turns: knownTurns,
      })
    ).toThrow();
  });

  it('rejects a worker Context Package trace carried by another Turn path', async () => {
    const source = await portableSource('openkit-portable-state-worker-lineage-');
    const root = source.root;
    writeFileSync(
      join(
        root,
        'threads',
        PORTABLE_TURN.threadId,
        'turns',
        PORTABLE_TURN.turnId,
        'context-package.json'
      ),
      `${JSON.stringify({
        schemaVersion: 1,
        threadId: 'th_00000000-0000-78ce-b458-8347d12d1da2',
        turnId: 'tu_00000000-0000-7bf1-990f-799cdaa2a481',
        workspaceId: 'ws_00000000-0000-7e30-a961-1cf5d6540406',
      })}\n`
    );

    expect(() => readWorkspacePortableFileState(root, source.owners)).toThrow(
      'Worker Context Package trace path lineage is contradictory.'
    );
  });

  it('rejects retired ledgers and trace files with contradictory path lineage', async () => {
    const retired = await portableSource('openkit-portable-state-retired-trace-');
    const retiredRoot = retired.root;
    const retiredTracePath = join(retiredRoot, 'knowledge', 'traces', '202607.jsonl');
    mkdirSync(dirname(retiredTracePath), { recursive: true });
    writeFileSync(retiredTracePath, '');
    expect(() => readWorkspacePortableFileState(retiredRoot, retired.owners)).toThrow(
      'The retired Knowledge retrieval trace ledger is unsupported.'
    );

    const contradictory = await portableSource('openkit-portable-state-trace-lineage-');
    const contradictoryRoot = contradictory.root;
    const path = join(
      contradictoryRoot,
      'threads',
      PORTABLE_TURN.threadId,
      'turns',
      PORTABLE_TURN.turnId,
      'retrieval-traces',
      'krt_00000000-0000-780e-b78f-51422afca1e9.json'
    );
    const trace = JSON.parse(readFileSync(path, 'utf8'));
    trace.queryContext.turnId = 'tu_00000000-0000-7bf1-990f-799cdaa2a481';
    writeFileSync(path, `${JSON.stringify(trace)}\n`);
    expect(() => readWorkspacePortableFileState(contradictoryRoot, contradictory.owners)).toThrow(
      'Knowledge retrieval trace lineage is contradictory.'
    );
  });

  it('ignores publisher temporary files while retaining Thread and Turn traces', async () => {
    const source = await portableSource('openkit-portable-state-trace-temporary-');
    const root = source.root;
    writeFileSync(
      join(
        root,
        'threads',
        PORTABLE_TURN.threadId,
        'retrieval-traces',
        '.krt_00000000-0000-77a1-9ebf-a9d24ca0b994.00000000-0000-4000-8000-000000000098.tmp'
      ),
      'incomplete'
    );
    expect(readWorkspacePortableFileState(root, source.owners).retrievalTraceFiles.size).toBe(2);
  });

  it('rejects a publisher-temp-shaped symbolic link in a retrieval trace directory', async () => {
    const source = await portableSource('openkit-portable-state-trace-temp-link-');
    const root = source.root;
    try {
      const traceDirectory = join(root, 'threads', PORTABLE_TURN.threadId, 'retrieval-traces');
      mkdirSync(traceDirectory, { recursive: true });
      symlinkSync(
        'missing-trace-target',
        join(
          traceDirectory,
          '.krt_00000000-0000-77a1-9ebf-a9d24ca0b994.00000000-0000-4000-8000-000000000098.tmp'
        )
      );

      expect(() => readWorkspacePortableFileState(root, source.owners)).toThrow(/symbolic link/i);
    } finally {
      rmSync(join(root, 'threads'), { force: true, recursive: true });
    }
  });
});

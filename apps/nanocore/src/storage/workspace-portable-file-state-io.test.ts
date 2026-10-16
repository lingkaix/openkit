// openkit-test-platform: posix
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readWorkspacePortableFileState,
  writeWorkspacePortableFileState,
} from './workspace-portable-file-state.js';

const JUNE = '2026-06-30T23:59:59.000Z';
const JULY = '2026-07-01T00:00:00.000Z';
const PORTABLE_TURN = {
  threadId: 'th_00000000-0000-7d57-bb9a-837e048d6465',
  turnId: 'tu_00000000-0000-7533-bc6b-7efa7795a620',
} as const;
const PORTABLE_OWNERS = {
  workspaceId: 'ws_00000000-0000-7e30-a961-1cf5d6540406',
  threads: [{ threadId: PORTABLE_TURN.threadId }],
  turns: [PORTABLE_TURN],
} as const;

/** Creates one empty real workspace root. */
function workspaceRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes one exact JSONL fixture and creates its real parent directories. */
function writeJsonl(path: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : ''
  );
}

/** Writes one complete portable source fixture. */
function writePortableFixture(root: string): void {
  const workspaceId = 'ws_00000000-0000-7e30-a961-1cf5d6540406';
  const observations = [
    {
      id: 'ko_00000000-0000-7ee4-b78c-17c74a854150',
      workspaceId,
      kind: 'maintenance',
      summary: 'June observation.',
      sourceReferences: [],
      scope: 'workspace',
      producer: 'test',
      confidence: 1,
      freshness: 'current',
      status: 'retained',
      observedAt: JUNE,
      createdAt: JUNE,
    },
    {
      id: 'ko_00000000-0000-74fd-834d-bd7444262a89',
      workspaceId,
      kind: 'maintenance',
      summary: 'July observation.',
      sourceReferences: [],
      scope: 'workspace',
      producer: 'test',
      confidence: 1,
      freshness: 'current',
      status: 'promoted',
      observedAt: JULY,
      createdAt: JULY,
    },
  ];
  const claims = [
    {
      id: 'kc_00000000-0000-7dea-b04c-c8d9dfd362fc',
      workspaceId,
      statement: 'First claim.',
      sourceReferences: [],
      scope: 'workspace',
      producer: 'test',
      confidence: 1,
      freshness: 'current',
      reviewState: 'accepted',
      conflictStatus: 'none',
      createdAt: JULY,
      updatedAt: JULY,
    },
    {
      id: 'kc_00000000-0000-7b97-a8ba-ef418610f14a',
      workspaceId,
      statement: 'Second claim.',
      sourceReferences: [],
      scope: 'workspace',
      producer: 'test',
      confidence: 1,
      freshness: 'current',
      reviewState: 'accepted',
      conflictStatus: 'none',
      createdAt: JULY,
      updatedAt: JULY,
    },
  ];
  const conflicts = [
    {
      id: 'kf_00000000-0000-7aff-b31a-d6d16ddb088d',
      workspaceId,
      subjectReferences: ['claim:kc_00000000-0000-7dea-b04c-c8d9dfd362fc'],
      sourceReferences: [],
      status: 'needs_review',
      summary: 'Conflict history.',
      suggestedActions: ['Review it.'],
      producer: 'test',
      createdAt: JUNE,
      updatedAt: JUNE,
    },
    {
      id: 'kf_00000000-0000-7aff-b31a-d6d16ddb088d',
      workspaceId,
      subjectReferences: ['claim:kc_00000000-0000-7dea-b04c-c8d9dfd362fc'],
      sourceReferences: [],
      status: 'resolved',
      summary: 'Conflict history.',
      suggestedActions: ['Review it.'],
      producer: 'test',
      resolution: 'Resolved.',
      resolvedAt: JULY,
      resolvedBy: 'test',
      createdAt: JUNE,
      updatedAt: JULY,
    },
  ];
  const retrieval = {
    traceId: 'krt_00000000-0000-780e-b78f-51422afca1e9',
    queryContext: {
      serverId: 'server_portable_source',
      workspaceId,
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      threadId: PORTABLE_TURN.threadId,
      turnId: PORTABLE_TURN.turnId,
    },
    sourceScope: `page/workspace/${workspaceId}`,
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

  writeJsonl(join(root, 'knowledge', 'observations', '202606.jsonl'), [observations[0]]);
  writeJsonl(join(root, 'knowledge', 'observations', '202607.jsonl'), [observations[1]]);
  writeJsonl(join(root, 'knowledge', 'claims', '202607.jsonl'), claims);
  writeJsonl(join(root, 'knowledge', 'conflicts', '202606.jsonl'), [conflicts[0]]);
  writeJsonl(join(root, 'knowledge', 'conflicts', '202607.jsonl'), [conflicts[1]]);
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
  writeFileSync(retrievalPath, `${JSON.stringify(retrieval)}\n`);
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
  writeFileSync(threadRetrievalPath, `${JSON.stringify(threadRetrieval)}\n`);

  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(
    join(root, 'config', 'workspace.jsonc'),
    '{\n  // exact comment\n  "schemaVersion": 1\n}\n'
  );
  mkdirSync(join(root, 'knowledge', 'schema'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'schema', 'workspace-schema.yaml'), 'custom: true\n');
  mkdirSync(join(root, 'knowledge', 'pages'), { recursive: true });
  writeFileSync(
    join(root, 'knowledge', 'pages', 'native.md'),
    '---\ntype: "RepoConvention"\ntitle: "Native"\n---\nNative page.\n'
  );
  mkdirSync(join(root, 'knowledge', 'pages', 'nested'), { recursive: true });
  writeFileSync(
    join(root, 'knowledge', 'pages', 'nested', 'native.md'),
    '---\ntype: "RepoConvention"\ntitle: "Nested native"\n---\nNested native page.\n'
  );
  writeFileSync(
    join(root, 'knowledge', 'pages', 'nested', 'index.md'),
    '# Nested authored index\n\nKeep this navigation byte-for-byte.\n'
  );
  writeFileSync(
    join(root, 'knowledge', 'pages', 'nested', 'log.md'),
    '# Nested authored log\n\nKeep this history byte-for-byte.\n'
  );
  writeFileSync(
    join(root, 'knowledge', 'pages', 'kn_owned.md'),
    '---\ntype: "KnowledgePage"\ntitle: "Owned"\nopenkit_entry_id: "kn_owned"\n---\nOwned page.\n'
  );
  const packageRoot = join(root, 'threads', PORTABLE_TURN.threadId, 'turns', PORTABLE_TURN.turnId);
  mkdirSync(join(packageRoot, 'context-package'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'context-package.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      threadId: PORTABLE_TURN.threadId,
      turnId: PORTABLE_TURN.turnId,
      workspaceId: 'ws_00000000-0000-7e30-a961-1cf5d6540406',
    })}\n`
  );
  writeFileSync(join(packageRoot, 'context-package', 'instructions.md'), 'Portable request.\n');
  writeFileSync(join(packageRoot, 'context-package', 'package.json'), '{"schemaVersion":1}\n');
}

describe('workspace portable file-state IO', () => {
  it('retains ledger annotations while excluding ignored trace fields from portable writes', () => {
    const source = workspaceRoot('openkit-knowledge-extended-');
    const target = workspaceRoot('openkit-knowledge-rewritten-');
    writePortableFixture(source);
    for (const family of ['observations', 'claims', 'conflicts']) {
      const path = join(source, 'knowledge', family, '202607.jsonl');
      const rows = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      for (const row of rows) row.futureNote = 'retained';
      writeJsonl(path, rows);
    }
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
    const state = readWorkspacePortableFileState(source, PORTABLE_OWNERS);
    expect(JSON.stringify([...state.retrievalTraceFiles.values()])).not.toContain('futureNote');
    expect(readFileSync(retrievalPath, 'utf8')).toContain('futureNote');
    writeWorkspacePortableFileState(target, state);
    const reopened = readWorkspacePortableFileState(target, PORTABLE_OWNERS);
    expect(reopened.retrievalTraceFiles).toEqual(state.retrievalTraceFiles);
    for (const family of ['observations', 'claims', 'conflicts'])
      expect(readFileSync(join(target, 'knowledge', family, '202607.jsonl'), 'utf8')).toContain(
        'futureNote'
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
  it('round-trips strict monthly ledgers and exact workspace-owned text', () => {
    const sourceRoot = workspaceRoot('openkit-portable-state-source-');
    const targetRoot = workspaceRoot('openkit-portable-state-target-');

    writePortableFixture(sourceRoot);
    mkdirSync(join(targetRoot, 'knowledge', 'schema'), { recursive: true });
    mkdirSync(join(targetRoot, 'knowledge', 'pages'), { recursive: true });
    writeFileSync(
      join(targetRoot, 'knowledge', 'schema', 'workspace-schema.yaml'),
      'default: true\n'
    );
    writeFileSync(
      join(targetRoot, 'knowledge', 'pages', 'kn_target.md'),
      '---\nopenkit_entry_id: "kn_target"\n---\nTarget owned page.\n'
    );

    const state = readWorkspacePortableFileState(sourceRoot, PORTABLE_OWNERS);

    expect([...state.observations.keys()]).toEqual(['202606', '202607']);
    expect(state.claims.get('202607')?.map((row) => row.id)).toEqual([
      'kc_00000000-0000-7dea-b04c-c8d9dfd362fc',
      'kc_00000000-0000-7b97-a8ba-ef418610f14a',
    ]);
    expect([...state.conflicts.values()].flat().map((row) => row.status)).toEqual([
      'needs_review',
      'resolved',
    ]);
    expect([...state.nativeKnowledgePages.keys()]).toEqual([
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
        '{"schemaVersion":1,"threadId":"th_00000000-0000-7d57-bb9a-837e048d6465","turnId":"tu_00000000-0000-7533-bc6b-7efa7795a620","workspaceId":"ws_00000000-0000-7e30-a961-1cf5d6540406"}\n',
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

    const roundTripped = readWorkspacePortableFileState(targetRoot, PORTABLE_OWNERS);
    for (const [path, content] of state.nativeKnowledgePages) {
      expect(roundTripped.nativeKnowledgePages.get(path)).toBe(content);
    }
    expect(readFileSync(join(targetRoot, 'config', 'workspace.jsonc'), 'utf8')).toBe(
      state.workspaceConfig
    );
    expect(
      readFileSync(join(targetRoot, 'knowledge', 'schema', 'workspace-schema.yaml'), 'utf8')
    ).toBe('custom: true\n');
    expect(readFileSync(join(targetRoot, 'knowledge', 'claims', '202607.jsonl'), 'utf8')).toBe(
      `${(state.claims.get('202607') ?? []).map((row) => JSON.stringify(row)).join('\n')}\n`
    );
    expect(readFileSync(join(targetRoot, 'knowledge', 'pages', 'kn_target.md'), 'utf8')).toContain(
      'openkit_entry_id: "kn_target"'
    );
  });

  it('rejects strict-schema and physical-boundary violations', () => {
    const malformedRoot = workspaceRoot('openkit-portable-state-malformed-');
    const linkedRoot = workspaceRoot('openkit-portable-state-linked-');
    const outsideRoot = workspaceRoot('openkit-portable-state-outside-');

    writePortableFixture(malformedRoot);
    writeJsonl(join(malformedRoot, 'knowledge', 'claims', '202607.jsonl'), [
      {
        id: 'kc_00000000-0000-70e0-81b3-473a81814be9',
        workspaceId: 'ws_00000000-0000-7e30-a961-1cf5d6540406',
        statement: 'Unknown core values must fail closed.',
        sourceReferences: [],
        scope: 'workspace',
        producer: 'test',
        confidence: 1,
        freshness: 'current',
        reviewState: 'unsupported',
        conflictStatus: 'none',
        createdAt: JULY,
        updatedAt: JULY,
        unexpected: true,
      },
    ]);
    expect(() => readWorkspacePortableFileState(malformedRoot, PORTABLE_OWNERS)).toThrow();

    writePortableFixture(linkedRoot);
    writeFileSync(join(outsideRoot, 'sentinel.txt'), 'untouched\n');
    symlinkSync(
      join(outsideRoot, 'sentinel.txt'),
      join(linkedRoot, 'knowledge', 'pages', 'linked.md')
    );
    expect(() => readWorkspacePortableFileState(linkedRoot, PORTABLE_OWNERS)).toThrow(
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
  ])('rejects $name', ({ knownTurns, alter }) => {
    const root = workspaceRoot('openkit-portable-state-invalid-worker-package-');
    writePortableFixture(root);
    alter(root);

    expect(() =>
      readWorkspacePortableFileState(root, {
        ...PORTABLE_OWNERS,
        turns: knownTurns,
      })
    ).toThrow();
  });

  it('rejects a worker Context Package trace carried by another Turn path', () => {
    const root = workspaceRoot('openkit-portable-state-worker-lineage-');
    writePortableFixture(root);
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

    expect(() => readWorkspacePortableFileState(root, PORTABLE_OWNERS)).toThrow(
      'Worker Context Package trace path lineage is contradictory.'
    );
  });

  it('rejects retired ledgers and trace files with contradictory path lineage', () => {
    const retiredRoot = workspaceRoot('openkit-portable-state-retired-trace-');
    writePortableFixture(retiredRoot);
    writeJsonl(join(retiredRoot, 'knowledge', 'traces', '202607.jsonl'), []);
    expect(() => readWorkspacePortableFileState(retiredRoot, PORTABLE_OWNERS)).toThrow(
      'The retired Knowledge retrieval trace ledger is unsupported.'
    );

    const contradictoryRoot = workspaceRoot('openkit-portable-state-trace-lineage-');
    writePortableFixture(contradictoryRoot);
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
    expect(() => readWorkspacePortableFileState(contradictoryRoot, PORTABLE_OWNERS)).toThrow(
      'Knowledge retrieval trace lineage is contradictory.'
    );
  });

  it('ignores publisher temporary files while retaining Thread and Turn traces', () => {
    const root = workspaceRoot('openkit-portable-state-trace-temporary-');
    writePortableFixture(root);
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
    expect(readWorkspacePortableFileState(root, PORTABLE_OWNERS).retrievalTraceFiles.size).toBe(2);
  });

  it('rejects a publisher-temp-shaped symbolic link in a retrieval trace directory', () => {
    const root = workspaceRoot('openkit-portable-state-trace-temp-link-');
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

      expect(() => readWorkspacePortableFileState(root, PORTABLE_OWNERS)).toThrow(/symbolic link/i);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

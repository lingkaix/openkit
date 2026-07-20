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
const PORTABLE_TURN = { threadId: 'th_portable', turnId: 'tu_portable' } as const;

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
  const workspaceId = 'ws_portable_source';
  const observations = [
    {
      id: 'ko_june',
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
      id: 'ko_july',
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
      id: 'kc_first',
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
      id: 'kc_second',
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
      id: 'kf_history',
      workspaceId,
      subjectReferences: ['claim:kc_first'],
      sourceReferences: [],
      status: 'needs_review',
      summary: 'Conflict history.',
      suggestedActions: ['Review it.'],
      producer: 'test',
      createdAt: JUNE,
      updatedAt: JUNE,
    },
    {
      id: 'kf_history',
      workspaceId,
      subjectReferences: ['claim:kc_first'],
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
    traceId: 'krt_00000000-0000-4000-8000-000000000001',
    workspaceId,
    caller: 'app-api',
    requestDigest: `sha256:${'0'.repeat(64)}`,
    retrievalParameters: { limit: 1, pinnedConceptIds: [] },
    createdAt: JULY,
    selected: [],
    excluded: [],
  };

  writeJsonl(join(root, 'knowledge', 'observations', '202606.jsonl'), [observations[0]]);
  writeJsonl(join(root, 'knowledge', 'observations', '202607.jsonl'), [observations[1]]);
  writeJsonl(join(root, 'knowledge', 'claims', '202607.jsonl'), claims);
  writeJsonl(join(root, 'knowledge', 'conflicts', '202606.jsonl'), [conflicts[0]]);
  writeJsonl(join(root, 'knowledge', 'conflicts', '202607.jsonl'), [conflicts[1]]);
  writeJsonl(join(root, 'knowledge', 'traces', '202607.jsonl'), [retrieval]);

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
      workspaceId: 'ws_portable_source',
    })}\n`
  );
  writeFileSync(join(packageRoot, 'context-package', 'instructions.md'), 'Portable request.\n');
  writeFileSync(join(packageRoot, 'context-package', 'package.json'), '{"schemaVersion":1}\n');
}

describe('workspace portable file-state IO', () => {
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

    const state = readWorkspacePortableFileState(sourceRoot, [PORTABLE_TURN]);

    expect([...state.observations.keys()]).toEqual(['202606', '202607']);
    expect(state.claims.get('202607')?.map((row) => row.id)).toEqual(['kc_first', 'kc_second']);
    expect([...state.conflicts.values()].flat().map((row) => row.status)).toEqual([
      'needs_review',
      'resolved',
    ]);
    expect([...state.nativeKnowledgePages.keys()]).toEqual([
      'knowledge/pages/kn_owned.md',
      'knowledge/pages/native.md',
      'knowledge/pages/nested/native.md',
    ]);
    expect(state.nativeKnowledgePages.get('knowledge/pages/kn_owned.md')).toContain(
      'openkit_entry_id: "kn_owned"'
    );
    expect([...state.workerContextPackageFiles]).toEqual([
      [
        'threads/th_portable/turns/tu_portable/context-package.json',
        '{"schemaVersion":1,"threadId":"th_portable","turnId":"tu_portable","workspaceId":"ws_portable_source"}\n',
      ],
      [
        'threads/th_portable/turns/tu_portable/context-package/instructions.md',
        'Portable request.\n',
      ],
      [
        'threads/th_portable/turns/tu_portable/context-package/package.json',
        '{"schemaVersion":1}\n',
      ],
    ]);

    writeWorkspacePortableFileState(targetRoot, state);

    const roundTripped = readWorkspacePortableFileState(targetRoot, [PORTABLE_TURN]);
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
        id: 'kc_unknown',
        workspaceId: 'ws_portable_source',
        statement: 'Unknown fields must fail closed.',
        sourceReferences: [],
        scope: 'workspace',
        producer: 'test',
        confidence: 1,
        freshness: 'current',
        reviewState: 'accepted',
        conflictStatus: 'none',
        createdAt: JULY,
        updatedAt: JULY,
        unexpected: true,
      },
    ]);
    expect(() => readWorkspacePortableFileState(malformedRoot, [PORTABLE_TURN])).toThrow();

    writePortableFixture(linkedRoot);
    writeFileSync(join(outsideRoot, 'sentinel.txt'), 'untouched\n');
    symlinkSync(
      join(outsideRoot, 'sentinel.txt'),
      join(linkedRoot, 'knowledge', 'pages', 'linked.md')
    );
    expect(() => readWorkspacePortableFileState(linkedRoot, [PORTABLE_TURN])).toThrow(
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

    expect(() => readWorkspacePortableFileState(root, knownTurns)).toThrow();
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
        threadId: 'th_other',
        turnId: 'tu_other',
        workspaceId: 'ws_portable_source',
      })}\n`
    );

    expect(() => readWorkspacePortableFileState(root, [PORTABLE_TURN])).toThrow(
      'Worker Context Package trace path lineage is contradictory.'
    );
  });
});

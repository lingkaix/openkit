import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  type KnowledgeManagerContextPackageTraceRecord,
  KnowledgeManagerPrepareContextResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';

import { FsStore, type KnowledgeSourceRecord } from '../lib/store.js';

const timestamp = '2026-07-12T00:00:00.000Z';

/**
 * Creates one file-backed workspace for direct canonical write boundary tests.
 *
 * @param prefix Temporary directory prefix.
 * @returns Store plus its workspace and canonical root.
 */
function createFixture(prefix: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), prefix));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Direct canonical write boundary');

  return {
    dataRoot,
    store,
    workspace,
    workspaceRoot: join(dataRoot, 'workspaces', workspace.id),
  };
}

/**
 * Replaces one canonical parent with a directory symlink to an outside root.
 *
 * @param parentPath Canonical parent path to replace.
 * @param prefix Outside temporary directory prefix.
 * @returns Outside directory targeted by the symlink.
 */
function installOutsideParent(parentPath: string, prefix: string): string {
  const outsideRoot = mkdtempSync(join(tmpdir(), prefix));

  rmSync(parentPath, { force: true, recursive: true });
  mkdirSync(dirname(parentPath), { recursive: true });
  symlinkSync(outsideRoot, parentPath, 'dir');
  return outsideRoot;
}

/**
 * Builds one valid source identity for direct material writes.
 *
 * @param workspaceId Owning workspace id.
 * @param sourceId Source id.
 * @returns Source record fixture.
 */
function knowledgeSource(workspaceId: string, sourceId: string): KnowledgeSourceRecord {
  return {
    id: sourceId,
    workspaceId,
    kind: 'upload',
    title: 'Symlink boundary source',
    uri: null,
    contentDigest: 'sha256:symlink-boundary-source',
    originatingThreadId: null,
    originatingTurnId: null,
    originatingFileId: null,
    capturedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Builds one valid empty Knowledge Manager context trace.
 *
 * @param workspaceId Owning workspace id.
 * @param id Context package id.
 * @returns Context trace fixture.
 */
function contextTrace(
  workspaceId: string,
  id = 'ctx_direct_write_symlink'
): KnowledgeManagerContextPackageTraceRecord {
  const operationId = 'op_direct_write_symlink';

  return {
    id,
    workspaceId,
    operationId,
    createdAt: timestamp,
    response: KnowledgeManagerPrepareContextResponseSchema.parse({
      operationId,
      operation: 'prepare-context-material',
      workspaceId,
      caller: 'workflow-coordinator',
      query: 'Verify canonical write boundaries.',
      outcome: 'insufficient-evidence',
      materials: [],
      exclusions: [],
      packageTrace: {
        contextPackageId: id,
        contextPackageDigest: `ctxpkg_sha256_${'0'.repeat(64)}`,
        policyVersion: 'knowledge-context-v1',
        selectedKnowledgeEntryIds: [],
        excludedCandidateCount: 0,
        budget: { requestedLimit: 1, selectedCount: 0, excludedCount: 0 },
      },
      confidence: 0,
      uncertainty: 'No context was selected.',
    }),
  };
}

/**
 * Builds the smallest valid imported workspace snapshot.
 *
 * @param workspaceId Imported workspace id.
 * @returns Import payload accepted by the store.
 */
function workspaceImportPayload(
  workspaceId: string
): Parameters<FsStore['importWorkspaceSnapshot']>[0] {
  return {
    workspace: {
      id: workspaceId,
      name: 'Imported symlink boundary workspace',
      kind: 'general',
      status: 'active',
      defaults: {
        defaultModelId: 'model_codex',
        defaultAgentId: 'agent_codex_host',
        defaultSkillIds: [],
      },
      counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    threads: [],
    knowledge: [],
    turns: [],
    itemRevisions: [],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
  };
}

describe('direct canonical write boundaries', () => {
  it('rejects a symlinked import staging parent before staging or publication', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-import-staging-symlink-'));
    const store = new FsStore({ dataRoot });
    const workspaceId = 'ws_import_staging_symlink';
    const workspacesRoot = join(dataRoot, 'workspaces');
    const outsideRoot = installOutsideParent(
      join(workspacesRoot, '.staging'),
      'openkit-import-staging-outside-'
    );
    const sentinelPath = join(outsideRoot, 'sentinel.txt');
    const stageWorkspace = vi.fn();

    writeFileSync(sentinelPath, 'untouched');

    expect
      .soft(() =>
        store.importWorkspaceSnapshot({
          ...workspaceImportPayload(workspaceId),
          stageWorkspace,
        })
      )
      .toThrow();
    expect.soft(stageWorkspace).not.toHaveBeenCalled();
    expect.soft(readdirSync(outsideRoot).sort()).toEqual(['sentinel.txt']);
    expect.soft(readFileSync(sentinelPath, 'utf8')).toBe('untouched');
    expect(existsSync(join(workspacesRoot, workspaceId))).toBe(false);
  });

  it('rejects a symlinked source material parent without writing outside the workspace', () => {
    const { store, workspace, workspaceRoot } = createFixture('openkit-source-material-symlink-');
    const sourceId = 'ks_source_material_symlink';
    const outsideRoot = installOutsideParent(
      join(workspaceRoot, 'sources', 'materials', sourceId),
      'openkit-source-material-outside-'
    );

    expect
      .soft(() =>
        store.createKnowledgeSource(
          knowledgeSource(workspace.id, sourceId),
          'This content must stay inside the workspace.'
        )
      )
      .toThrow();
    expect(existsSync(join(outsideRoot, 'content.txt'))).toBe(false);
  });

  it.each([
    'materials',
    'derived',
  ] as const)('rejects a symlinked staged source %s parent without writing outside', (family) => {
    const { store, workspace } = createFixture(`openkit-staged-source-${family}-`);
    const workspaceRoot = mkdtempSync(join(tmpdir(), `openkit-staged-source-root-${family}-`));
    const sourceId = `ks_staged_${family}_symlink`;
    const source = knowledgeSource(workspace.id, sourceId);
    const outsideRoot = installOutsideParent(
      join(workspaceRoot, 'sources', family, sourceId),
      `openkit-staged-source-outside-${family}-`
    );
    const outsideFile = family === 'materials' ? 'content.txt' : 'text.json';

    expect
      .soft(() => {
        if (family === 'materials') {
          Reflect.apply(Reflect.get(store, 'writeKnowledgeSourceMaterialsToRoot'), store, [
            workspaceRoot,
            [{ sourceId, content: 'Staged source material.' }],
            [source],
          ]);
          return;
        }

        Reflect.apply(Reflect.get(store, 'writeKnowledgeSourceDerivedRepresentation'), store, [
          workspaceRoot,
          source,
        ]);
      })
      .toThrow();
    expect(existsSync(join(outsideRoot, outsideFile))).toBe(false);
  });

  it.each([
    ['observation', 'observations'],
    ['claim', 'claims'],
    ['conflict', 'conflicts'],
    ['context-package', 'context-packages'],
    ['materialization', 'context-materializations'],
  ] as const)('rejects a symlinked %s write parent without writing outside', (family, directory) => {
    const { store, workspace, workspaceRoot } = createFixture(`openkit-direct-${family}-symlink-`);
    const outsideRoot = installOutsideParent(
      join(workspaceRoot, 'knowledge', directory),
      `openkit-direct-${family}-outside-`
    );

    expect
      .soft(() => {
        switch (family) {
          case 'observation':
            store.recordKnowledgeObservation({
              id: 'ko_direct_write_symlink',
              workspaceId: workspace.id,
              kind: 'maintenance',
              summary: 'Canonical writes must reject symlinked parents.',
              sourceReferences: [],
              scope: 'workspace',
              producer: 'boundary-test',
              confidence: 1,
              freshness: 'current',
              status: 'retained',
              observedAt: timestamp,
              createdAt: timestamp,
            });
            break;
          case 'claim':
            store.recordKnowledgeClaim({
              id: 'kc_direct_write_symlink',
              workspaceId: workspace.id,
              statement: 'Canonical writes reject symlinked parents.',
              sourceReferences: [],
              scope: 'workspace',
              producer: 'boundary-test',
              confidence: 1,
              freshness: 'current',
              reviewState: 'accepted',
              conflictStatus: 'none',
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            break;
          case 'conflict':
            store.recordKnowledgeConflict({
              id: 'kf_direct_write_symlink',
              workspaceId: workspace.id,
              subjectReferences: ['knowledge:boundary'],
              sourceReferences: [],
              status: 'needs_review',
              summary: 'A symlinked parent crosses the workspace boundary.',
              suggestedActions: ['Reject the write.'],
              producer: 'boundary-test',
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            break;
          case 'context-package':
            store.recordKnowledgeContextPackageTrace(contextTrace(workspace.id));
            break;
          case 'materialization':
            store.materializeKnowledgeContextPackageTrace(contextTrace(workspace.id));
            break;
        }
      })
      .toThrow();

    const outsideFile =
      family === 'materialization'
        ? join('ctx_direct_write_symlink', 'openkit', 'context', 'instructions.md')
        : '202607.jsonl';
    expect(existsSync(join(outsideRoot, outsideFile))).toBe(false);
  });

  it.each([
    ['starts after sequence 1', [1, 2]],
    ['skips an intermediate sequence', [0, 2]],
  ] as const)('rejects a canonical event log that %s', (_case, retainedIndexes) => {
    const { dataRoot, store, workspace, workspaceRoot } = createFixture(
      'openkit-event-continuity-'
    );
    const thread = store.createThread(workspace.id, 'Event continuity thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Validate event continuity', {
      kind: 'user',
      id: 'user_local',
    });
    const item = store.createItem({
      id: `it_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: '',
      createdAt: turn.startedAt ?? timestamp,
      completedAt: null,
    });

    store.emitTurnEvent(turn.id, {
      event: 'turn.started',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'turn-started', turnId: turn.id, status: 'running' },
    });
    store.emitTurnEvent(turn.id, {
      event: 'item.created',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'item-created', item },
    });
    store.emitTurnEvent(turn.id, {
      event: 'item.delta',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: {
        type: 'item-delta',
        itemId: item.id,
        itemType: item.type,
        deltaKind: 'text-delta',
        delta: 'Event continuity.',
      },
    });

    const eventsPath = join(
      workspaceRoot,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'runtime',
      'events.jsonl'
    );
    const events = readFileSync(eventsPath, 'utf8').trim().split('\n');
    writeFileSync(eventsPath, `${retainedIndexes.map((index) => events[index]).join('\n')}\n`);

    expect(() => new FsStore({ dataRoot })).toThrow(/sequence/i);
  });
});

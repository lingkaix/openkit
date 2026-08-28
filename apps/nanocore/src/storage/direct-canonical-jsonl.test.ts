// openkit-test-platform: posix
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FsStore } from '../lib/store.js';

const TIMESTAMP = '2026-07-12T00:00:00.000Z';
type LedgerFamily = 'claims' | 'conflicts' | 'observations';

/**
 * Creates one file-backed workspace for direct canonical JSONL tests.
 *
 * @returns Store, workspace id, and canonical workspace root.
 */
function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-direct-jsonl-'));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Direct canonical JSONL');

  return {
    store,
    workspaceId: workspace.id,
    workspaceRoot: join(dataRoot, 'workspaces', workspace.id),
  };
}

/**
 * Appends one valid record to a direct workspace JSONL family.
 *
 * @param store Store that owns the workspace.
 * @param workspaceId Owning workspace id.
 * @param family Ledger family to append.
 * @param suffix Stable record-id suffix.
 */
function appendLedgerRecord(
  store: FsStore,
  workspaceId: string,
  family: LedgerFamily,
  suffix: string
): void {
  switch (family) {
    case 'observations':
      store.recordKnowledgeObservation({
        id: `ko_${suffix}`,
        workspaceId,
        kind: 'maintenance',
        summary: `Observation ${suffix}.`,
        sourceReferences: [],
        scope: 'workspace',
        producer: 'direct-jsonl-test',
        confidence: 1,
        freshness: 'current',
        status: 'retained',
        observedAt: TIMESTAMP,
        createdAt: TIMESTAMP,
      });
      break;
    case 'claims':
      store.recordKnowledgeClaim({
        id: `kc_${suffix}`,
        workspaceId,
        statement: `Claim ${suffix}.`,
        sourceReferences: [],
        scope: 'workspace',
        producer: 'direct-jsonl-test',
        confidence: 1,
        freshness: 'current',
        reviewState: 'accepted',
        conflictStatus: 'none',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      });
      break;
    case 'conflicts':
      store.recordKnowledgeConflict({
        id: `kf_${suffix}`,
        workspaceId,
        subjectReferences: [`knowledge:${suffix}`],
        sourceReferences: [],
        status: 'needs_review',
        summary: `Conflict ${suffix}.`,
        suggestedActions: ['Review the conflict.'],
        producer: 'direct-jsonl-test',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      });
      break;
  }
}

/**
 * Reads one direct JSONL family through its public Store API.
 *
 * @param store Store that owns the workspace.
 * @param workspaceId Owning workspace id.
 * @param family Ledger family to read.
 */
function readLedger(store: FsStore, workspaceId: string, family: LedgerFamily): void {
  switch (family) {
    case 'observations':
      store.listKnowledgeObservations(workspaceId);
      break;
    case 'claims':
      store.listKnowledgeClaims(workspaceId);
      break;
    case 'conflicts':
      store.listKnowledgeConflicts(workspaceId);
      break;
  }
}

describe('direct canonical JSONL ledgers', () => {
  it.each([
    'observations',
    'claims',
    'conflicts',
  ] as const)('repairs incomplete %s tails before append and read', (family) => {
    const { store, workspaceId, workspaceRoot } = createFixture();
    const path = join(workspaceRoot, 'knowledge', family, '202607.jsonl');

    appendLedgerRecord(store, workspaceId, family, 'first');
    appendFileSync(path, '{"id":"interrupted');
    appendLedgerRecord(store, workspaceId, family, 'second');
    appendFileSync(path, '{"id":"interrupted');

    expect(() => readLedger(store, workspaceId, family)).not.toThrow();
    const rows = readFileSync(path, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => JSON.parse(row))).toHaveLength(2);
  });

  it.each([
    'observations',
    'claims',
    'conflicts',
  ] as const)('rejects a symlinked %s ledger without writing outside', (family) => {
    const { store, workspaceId, workspaceRoot } = createFixture();
    const path = join(workspaceRoot, 'knowledge', family, '202607.jsonl');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'openkit-direct-jsonl-outside-'));
    const outsidePath = join(outsideRoot, 'sentinel.jsonl');

    appendLedgerRecord(store, workspaceId, family, 'first');
    rmSync(path);
    writeFileSync(outsidePath, 'untouched\n');
    symlinkSync(outsidePath, path);

    expect(() => appendLedgerRecord(store, workspaceId, family, 'second')).toThrow();
    expect(readFileSync(outsidePath, 'utf8')).toBe('untouched\n');
  });

  it.each([
    'observations',
    'claims',
    'conflicts',
  ] as const)('rejects schema-invalid %s rows through the Store API', (family) => {
    const { store, workspaceId, workspaceRoot } = createFixture();
    const path = join(workspaceRoot, 'knowledge', family, '202607.jsonl');

    appendLedgerRecord(store, workspaceId, family, 'invalid');
    const row = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...row, unexpected: true })}\n`);

    expect(() => readLedger(store, workspaceId, family)).toThrow();
  });

  it.each([
    'observations',
    'claims',
    'conflicts',
  ] as const)('rejects %s rows stored under the wrong ledger month', (family) => {
    const { store, workspaceId, workspaceRoot } = createFixture();
    const expectedPath = join(workspaceRoot, 'knowledge', family, '202607.jsonl');

    appendLedgerRecord(store, workspaceId, family, 'wrong-month');
    renameSync(expectedPath, join(workspaceRoot, 'knowledge', family, '202606.jsonl'));

    expect(() => readLedger(store, workspaceId, family)).toThrow(/month/i);
  });
});

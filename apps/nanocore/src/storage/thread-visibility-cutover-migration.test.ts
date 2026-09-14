// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FsStore } from '../lib/store.js';
import {
  migrateThreadVisibilityCutover,
  runThreadVisibilityCutoverMigrationCli,
} from './thread-visibility-cutover-migration.js';

/** Reads one persisted Thread record from an isolated store. */
function threadRecord(dataRoot: string, workspaceId: string, threadId: string) {
  const path = join(dataRoot, 'workspaces', workspaceId, 'threads', threadId, 'thread.json');
  return {
    path,
    value: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>,
  };
}

/** Removes only visibility-era metadata and recomputes the predecessor envelope digest. */
function predecessorRecord(value: Record<string, unknown>) {
  const predecessor = { ...value };
  delete predecessor.visibility;
  delete predecessor.privateOwnerUserId;
  predecessor.requiredFeatures = ['openkit.thread-entry.v1'];
  const { id, workspaceId, name, preview, status, entryPath, createdAt, updatedAt } = predecessor;
  predecessor.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify({ id, workspaceId, name, preview, status, entryPath, createdAt, updatedAt })).digest('hex')}`;
  return predecessor;
}

describe('Thread visibility cutover migration', () => {
  it('blocks ambiguous predecessors unless an operator default is supplied', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-visibility-migrate-'));
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-visibility-backup-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Migration workspace');
    const formal = store.createThread(workspace.id, 'Formal worker history');
    const ambiguous = store.createThread(workspace.id, 'Empty ambiguous history');
    const turn = store.createTurn(workspace.id, formal.id, 'Work', {
      kind: 'user',
      id: 'user_local',
    });
    store.updateTurn(turn.id, { agentId: 'agent_codex_host' });

    writeFileSync(
      threadRecord(dataRoot, workspace.id, formal.id).path,
      `${JSON.stringify(predecessorRecord(threadRecord(dataRoot, workspace.id, formal.id).value))}\n`
    );
    writeFileSync(
      threadRecord(dataRoot, workspace.id, ambiguous.id).path,
      `${JSON.stringify(predecessorRecord(threadRecord(dataRoot, workspace.id, ambiguous.id).value))}\n`
    );

    const blocked = migrateThreadVisibilityCutover({
      backupRoot,
      dataRoot,
      dryRun: true,
    });
    expect(blocked.outcome).toBe('blocked');
    expect(blocked.ambiguousCount).toBe(1);
    expect(blocked.classifiedCount).toBe(1);
    expect(blocked.rows.map((row) => row.decision).sort()).toEqual(['ambiguous', 'classified']);

    const applied = migrateThreadVisibilityCutover({
      ambiguousDefault: 'workspace',
      backupRoot,
      dataRoot,
    });
    expect(applied).toMatchObject({
      applied: true,
      outcome: 'succeeded',
      writtenCount: 2,
    });
    expect(new FsStore({ dataRoot }).getThread(workspace.id, ambiguous.id)).toMatchObject({
      visibility: 'workspace',
    });
    expect(threadRecord(dataRoot, workspace.id, formal.id).value.requiredFeatures).toContain(
      'openkit.thread-visibility.v1'
    );
  });

  it('prints a path-free summary from the CLI and rejects unknown ambiguous defaults', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-visibility-cli-'));
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-visibility-cli-backup-'));
    new FsStore({ dataRoot });
    const lines: string[] = [];
    const result = runThreadVisibilityCutoverMigrationCli(
      ['--data-root', dataRoot, '--backup-root', backupRoot, '--dry-run'],
      (line) => lines.push(line)
    );
    expect(result.outcome).toBe('succeeded');
    expect(lines.join('')).toContain('"applied": false');
    expect(lines.join('')).not.toContain(dataRoot);
    expect(() =>
      runThreadVisibilityCutoverMigrationCli([
        '--data-root',
        dataRoot,
        '--backup-root',
        backupRoot,
        '--ambiguous-default',
        'private',
      ])
    ).toThrow(/supports only workspace/);
  });
});

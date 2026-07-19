import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FsStore } from './store.js';

/**
 * Computes the canonical S16 digest for exact UTF-8 Artifact content.
 *
 * @param content Exact Artifact body.
 * @returns Lowercase SHA-256 digest with the required prefix.
 */
function artifactDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

describe('FsStore workspace persistence scope', () => {
  it('persists one owner-independent workspace tree without a user storage scope', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-owner-independent-'));
    const firstStore = new FsStore({ dataRoot });
    const workspace = firstStore.createWorkspace('Owner-independent workspace');
    const canonicalRecordPath = join(dataRoot, 'workspaces', workspace.id, 'workspace.json');
    const ownerNestedRecordPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      workspace.id,
      'workspace.json'
    );

    expect.soft(existsSync(canonicalRecordPath)).toBe(true);
    expect.soft(existsSync(ownerNestedRecordPath)).toBe(false);

    const secondStore = new FsStore({ dataRoot });
    expect(() => secondStore.getWorkspace(workspace.id)).not.toThrow();
  });

  it('persists one workspace when another workspace canonical tree is blocked', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-workspace-scope-'));
    const store = new FsStore({ dataRoot });
    const blockedWorkspace = store.createWorkspace('Blocked workspace');
    const targetWorkspace = store.createWorkspace('Target workspace');
    const blockedArtifactsRoot = join(dataRoot, 'workspaces', blockedWorkspace.id, 'artifacts');

    rmSync(blockedArtifactsRoot, { recursive: true });
    writeFileSync(blockedArtifactsRoot, 'not a directory');
    let updateError: unknown;
    try {
      store.updateWorkspace(targetWorkspace.id, { name: 'Updated target workspace' });
    } catch (error) {
      updateError = error;
    } finally {
      rmSync(blockedArtifactsRoot);
      mkdirSync(blockedArtifactsRoot);
    }

    expect.soft(updateError).toBeUndefined();
    const restarted = new FsStore({ dataRoot });
    expect(restarted.getWorkspace(targetWorkspace.id).name).toBe('Updated target workspace');
  });

  it('retains Artifact authority when its reference append has an ambiguous outcome', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-artifact-lineage-failure-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Artifact lineage failure workspace');
    const thread = store.createThread(workspace.id, 'Artifact lineage failure thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Reject partial Artifact lineage', {
      kind: 'user',
      id: 'user_local',
    });
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const artifactId = 'ar_reference_append_failure';
    const requestId = 'artifact-create-reference-append-failure';
    const body = 'This Artifact remains authoritative after an ambiguous append.';
    const artifactInput = {
      id: artifactId,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Ambiguous Artifact reference append',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body },
      contentDigest: artifactDigest(body),
      lastMutationRequestId: requestId,
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: turn.id,
        requestId,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;
    const createItem = store.createItem.bind(store);
    store.createItem = (item) => {
      createItem(item);
      throw new Error('Injected ambiguous Artifact reference append failure.');
    };

    try {
      expect(() => store.createArtifact(artifactInput)).toThrow(
        'Injected ambiguous Artifact reference append failure.'
      );
    } finally {
      store.createItem = createItem;
    }

    expect.soft(store.listArtifacts(workspace.id)).toEqual([artifactInput]);
    expect
      .soft(
        store
          .listAllItems()
          .filter((item) => item.type === 'artifact-reference' && item.artifactId === artifactId)
      )
      .toHaveLength(1);
    const restarted = new FsStore({ dataRoot });
    expect.soft(restarted.listArtifacts(workspace.id)).toEqual([artifactInput]);
    expect
      .soft(
        restarted
          .listAllItems()
          .filter((item) => item.type === 'artifact-reference' && item.artifactId === artifactId)
      )
      .toHaveLength(1);
    let retryError: unknown;
    try {
      store.createArtifact(artifactInput);
    } catch (error) {
      retryError = error;
    }
    expect(retryError).toMatchObject({ code: 'recovery_required', status: 409 });
  });

  it('restores the prior canonical state when Artifact introduction persistence fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-artifact-introduction-failure-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Artifact introduction failure workspace');
    const thread = store.createThread(workspace.id, 'Artifact introduction failure thread');
    const acceptedAt = '2026-07-18T00:04:00.000Z';
    const requestId = 'artifact-import-before-introduction-failure';
    const body = 'Preserve this workspace-only Artifact.';
    const contentDigest = artifactDigest(body);
    const artifact = store.createArtifact({
      id: 'ar_introduction_write_failure',
      workspaceId: workspace.id,
      threadId: null,
      turnId: null,
      kind: 'file',
      title: 'Stable Artifact',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body },
      contentDigest,
      lastMutationRequestId: requestId,
      origin: {
        kind: 'imported',
        sourceKind: 'direct-import',
        sourceId: requestId,
        sourceDigest: contentDigest,
        actor: { kind: 'user', id: 'user_local' },
        requestId,
        recordedAt: acceptedAt,
      },
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    });
    const persistence = store as unknown as {
      persist: (workspaceId: string) => void;
    };
    const persist = persistence.persist.bind(store);
    let failed = false;
    persistence.persist = (workspaceId) => {
      if (!failed && workspaceId === workspace.id) {
        failed = true;
        throw new Error('Injected Artifact introduction persistence failure.');
      }
      persist(workspaceId);
    };

    try {
      expect(() =>
        store.introduceArtifact({
          workspaceId: workspace.id,
          threadId: thread.id,
          artifactId: artifact.id,
          expectedArtifactVersion: 1,
          requestId: 'artifact-introduction-persistence-failure',
          acceptedAt: '2026-07-18T00:05:00.000Z',
          turnId: 'tu_artifact_introduction_persistence_failure',
          triggerActor: { kind: 'user', id: 'user_local' },
        })
      ).toThrow('Injected Artifact introduction persistence failure.');
    } finally {
      persistence.persist = persist;
    }

    expect(store.getArtifact(workspace.id, artifact.id)).toEqual(artifact);
    expect(store.listThreadTurns(workspace.id, thread.id)).toEqual([]);
    expect(store.listAllItems()).toEqual([]);

    const restarted = new FsStore({ dataRoot });
    expect(restarted.getArtifact(workspace.id, artifact.id)).toEqual(artifact);
    expect(restarted.listThreadTurns(workspace.id, thread.id)).toEqual([]);
    expect(restarted.listAllItems()).toEqual([]);
  });

  it('does not resurrect deleted knowledge after a later projection write fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-knowledge-delete-failure-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Knowledge deletion workspace');
    const thread = store.createThread(workspace.id, 'Knowledge deletion thread');
    const knowledge = store.createKnowledgeEntry(workspace.id, {
      kind: 'project-context',
      title: 'Delete this knowledge',
      content: 'This record must not return after restart.',
    });
    const threadRecordPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'thread.json'
    );
    const threadRecord = readFileSync(threadRecordPath);

    rmSync(threadRecordPath);
    mkdirSync(threadRecordPath);
    expect(() => store.deleteKnowledgeEntry(workspace.id, knowledge.id)).toThrow(/regular file/);
    rmSync(threadRecordPath, { recursive: true });
    writeFileSync(threadRecordPath, threadRecord);

    const restarted = new FsStore({ dataRoot });
    expect(() => restarted.getKnowledgeEntry(workspace.id, knowledge.id)).toThrow(
      `Knowledge entry not found: ${knowledge.id}`
    );
  });
});

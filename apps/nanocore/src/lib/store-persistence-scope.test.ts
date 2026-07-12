import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FsStore } from './store.js';

describe('FsStore workspace persistence scope', () => {
  it('persists one workspace when another workspace canonical tree is blocked', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-workspace-scope-'));
    const store = new FsStore({ dataRoot });
    const blockedWorkspace = store.createWorkspace('Blocked workspace');
    const targetWorkspace = store.createWorkspace('Target workspace');
    const blockedArtifactsRoot = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      blockedWorkspace.id,
      'artifacts'
    );

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
      'users',
      'user_local',
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

  it('does not resurrect a deleted artifact or review after a later projection write fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-artifact-delete-failure-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Artifact deletion workspace');
    const thread = store.createThread(workspace.id, 'Artifact deletion thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Delete the artifact');
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const artifact = store.createArtifact({
      id: `ar_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Delete this artifact',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body: 'This body must not return after restart.' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.recordArtifactReviewDecision({
      artifactId: artifact.id,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      status: 'accepted',
      requestId: 'delete-artifact-review',
      message: null,
      decidedAt: timestamp,
      followUpTurnId: null,
      lifecycle: 'completed',
    });
    const schemaPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      workspace.id,
      'knowledge',
      'schema',
      'workspace-schema.yaml'
    );
    const schema = readFileSync(schemaPath);

    rmSync(schemaPath);
    mkdirSync(schemaPath);
    expect(() => store.deleteArtifact(workspace.id, artifact.id)).toThrow(/regular file/);
    rmSync(schemaPath, { recursive: true });
    writeFileSync(schemaPath, schema);

    const restarted = new FsStore({ dataRoot });
    expect.soft(restarted.listArtifacts(workspace.id)).toEqual([]);
    expect(restarted.getArtifactReviewDecision(artifact.id)).toBeNull();
  });
});

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { appendWorkspaceTurnEvent, loadWorkspaceFileRecords } from './workspace-file-records.js';

const families = ['Workspace', 'Turn', 'Artifact', 'AgentSession', 'Item', 'stream event'] as const;

/** Publishes minimal native records, with exactly one row in each JSONL file. */
function createRetainedFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-retained-file-formats-'));
  onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Retained formats');
  const thread = store.createThread(workspace.id, 'Retained formats');
  const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
  const turn = store.createTurn(workspace.id, thread.id, 'Retained request', actor);
  const now = workspace.createdAt;
  store.createItem({
    id: 'it_00000000-0000-7107-a6b6-12de9088d8ca',
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    createdAt: now,
    type: 'user-message',
    actor,
    text: 'Retained request',
    status: 'completed',
    completedAt: now,
  });
  const sessionId = 'as_00000000-0000-74db-9692-cadae15b58fb';
  store.createAgentSession({
    id: sessionId,
    agentId: 'agent_retained_formats',
    workspaceId: workspace.id,
    threadId: thread.id,
    status: 'idle',
    message: null,
    createdAt: now,
    updatedAt: now,
    workspaceRoots: [],
  });
  const artifactId = 'ar_00000000-0000-780c-b09d-92983bad1f5b';
  const body = 'Retained artifact bytes.';
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  store.createArtifact({
    id: artifactId,
    workspaceId: workspace.id,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: 'Retained artifact',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'text', body },
    contentDigest: digest,
    lastMutationRequestId: 'retained-import',
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: 'retained-import',
      sourceDigest: digest,
      actor,
      requestId: 'retained-import',
      recordedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  });
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const turnRoot = join(workspaceRoot, 'threads', thread.id, 'turns', turn.id);
  appendWorkspaceTurnEvent(workspaceRoot, {
    protocolVersion: '1',
    sequence: 1,
    requestId: null,
    timestamp: now,
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    event: 'workspace.updated',
    data: { type: 'workspace-updated', workspace },
  });
  return {
    dataRoot,
    expected: {
      workspace: { id: workspace.id, name: 'Retained formats' },
      turns: [{ id: turn.id, items: [{ text: 'Retained request' }] }],
      itemRevisions: [{ text: 'Retained request' }],
      artifacts: [{ id: artifactId, content: { format: 'text', body } }],
      agentSessions: [{ id: sessionId, agentId: 'agent_retained_formats' }],
      streamEvents: [[turn.id, [{ sequence: 1, event: 'workspace.updated' }]]],
    },
    paths: {
      Workspace: join(workspaceRoot, 'workspace-record.json'),
      Turn: join(turnRoot, 'turn.json'),
      Artifact: join(workspaceRoot, 'artifacts', artifactId, 'artifact.json'),
      AgentSession: join(workspaceRoot, 'runtime', 'agent-sessions', sessionId, 'session.json'),
      Item: join(turnRoot, 'items.jsonl'),
      'stream event': join(turnRoot, 'runtime', 'events.jsonl'),
    },
  };
}

describe('native retained file formats', () => {
  it.each(
    families
  )('writes %s v1 and reopens descriptive additions without changing bytes', (family) => {
    const { dataRoot, expected, paths } = createRetainedFixture();
    const path = paths[family];
    const record = JSON.parse(readFileSync(path, 'utf8'));
    // Observe the native writer before adding any fixture-owned content.
    expect(record.schemaVersion).toBe(1);
    const original = loadWorkspaceFileRecords(dataRoot);
    expect(original).toMatchObject([expected]);
    record.futureNote = 'Retained descriptive annotation.';
    const annotatedBytes = `${JSON.stringify(record)}\n`;
    writeFileSync(path, annotatedBytes);

    expect(loadWorkspaceFileRecords(dataRoot)).toEqual(original);
    expect(readFileSync(path, 'utf8')).toBe(annotatedBytes);
  });

  it.each(families)('refuses %s with a missing or unknown retained version', (family) => {
    const { dataRoot, paths } = createRetainedFixture();
    const path = paths[family];
    const originalBytes = readFileSync(path, 'utf8');
    expect(loadWorkspaceFileRecords(dataRoot)).toHaveLength(1);

    for (const version of [undefined, 2]) {
      const record = JSON.parse(originalBytes);
      if (version === undefined) delete record.schemaVersion;
      else record.schemaVersion = version;
      const invalidBytes = `${JSON.stringify(record)}\n`;
      writeFileSync(path, invalidBytes);

      expect(() => loadWorkspaceFileRecords(dataRoot)).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(invalidBytes);
      writeFileSync(path, originalBytes);
      expect(loadWorkspaceFileRecords(dataRoot)).toHaveLength(1);
    }
  });
});

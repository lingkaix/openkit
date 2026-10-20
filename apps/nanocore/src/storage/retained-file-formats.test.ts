// openkit-test-platform: posix
// The refusal helper preserves raw symbolic-link targets under the POSIX contract.
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
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
  const internalExecution = {
    roleId: 'assistant',
    logicalModelId: 'Smart',
    profileId: 'assistant',
    limits: { maxModelTurns: 12, maxToolCalls: 24, deadlineMs: 60_000 },
    contextStrategy: 'rolling' as const,
    threshold: 16_000,
  };
  const turn = store.createTurn(workspace.id, thread.id, 'Retained request', actor, null, {
    internalExecution,
  });
  const now = workspace.createdAt;
  store.createItem({
    id: 'it_00000000-0000-7107-a6b6-12de9088d8ca',
    owner: { kind: 'workspace', workspaceId: workspace.id },
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
      turns: [{ id: turn.id, internalExecution, items: [{ text: 'Retained request' }] }],
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

/**
 * Validates one retained fault in a fresh admission lifetime without resetting process state.
 *
 * Copies exact authority, seeds an independent healthy sibling, and checks refusal and preservation.
 * Each copy has a new root identity, so later faults cannot reuse an earlier refusal.
 *
 * @param dataRoot Source fixture containing the injected fault.
 * @param workspaceId Owning Workspace that must be quarantined.
 * @returns Reopened Store and isolated root for additional native readback checks.
 */
function expectLocalWorkspaceRefusal(dataRoot: string, workspaceId: string) {
  const restartRoot = mkdtempSync(join(tmpdir(), 'openkit-local-refusal-'));
  onTestFinished(() => rmSync(restartRoot, { recursive: true, force: true }));
  const seed = new FsStore({ dataRoot: restartRoot });
  const sibling = seed.createWorkspace('Healthy refusal control');
  const siblingThread = seed.createThread(sibling.id, 'Retained sibling thread');
  const siblingBefore = seed.getWorkspace(sibling.id);
  cpSync(dataRoot, restartRoot, { recursive: true, verbatimSymlinks: true });

  /** Records every directory, link target and file byte, including the absence of deleted entries. */
  function snapshot(root: string): Record<string, Buffer | string> {
    const entries: Record<string, Buffer | string> = {};
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const key = join(prefix, entry.name);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          entries[key] = 'directory';
          visit(path, key);
        } else {
          entries[key] = entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path);
        }
      }
    };
    visit(root);
    return entries;
  }

  const refusedRoot = join(restartRoot, 'workspaces', workspaceId);
  const before = snapshot(refusedRoot);
  const reopened = new FsStore({ dataRoot: restartRoot });
  expect(scopeAdmissionFailures(restartRoot)).toContainEqual(
    expect.objectContaining({ scope: 'workspace', id: workspaceId })
  );
  expect(() => reopened.getWorkspace(workspaceId)).toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  expect(() => reopened.createThread(workspaceId, 'Must remain refused')).toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  expect(reopened.getWorkspace(sibling.id)).toEqual(siblingBefore);
  expect(reopened.getThread(sibling.id, siblingThread.id)).toEqual(siblingThread);
  const progress = reopened.createThread(sibling.id, 'Healthy sibling progress');
  expect(new FsStore({ dataRoot: restartRoot }).getThread(sibling.id, progress.id)).toEqual(
    progress
  );
  expect(snapshot(refusedRoot)).toEqual(before);
  expect(snapshot(join(dataRoot, 'workspaces', workspaceId))).toEqual(before);
  return { store: reopened, dataRoot: restartRoot };
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

      const workspaceId = JSON.parse(readFileSync(paths.Workspace, 'utf8')).id as string;
      const restarted = expectLocalWorkspaceRefusal(dataRoot, workspaceId);
      expect(
        loadWorkspaceFileRecords(restarted.dataRoot).map(({ workspace }) => workspace.id)
      ).not.toContain(workspaceId);
      expect(readFileSync(path, 'utf8')).toBe(invalidBytes);
      writeFileSync(path, originalBytes);
      expect(loadWorkspaceFileRecords(dataRoot)).toHaveLength(1);
    }
  });
});

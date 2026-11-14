import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspacePolicyDocumentSchema } from '@openkit/config-schema';
import { allocateEntityId, type PolicyDocumentV1, ThreadSchema } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { managedThreadPolicy } from '../test-support/resource-policy.js';
import { createTestCoreDb, createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { canDiscloseThreadToAudience, isThreadVisible } from './thread-visibility.js';

describe('current managed Thread audience', () => {
  it('uses the loaded boundary for discovery, source reads and revocation, including administrators', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'managed-thread-audience-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Managed audience');
    const managed = await store.createThread(workspace.id, 'Restricted');
    const ordinary = await store.createThread(workspace.id, 'Ordinary');
    const userId = allocateEntityId('usr');
    const otherId = allocateEntityId('usr');
    let policy = managedThreadPolicy({
      workspaceId: workspace.id,
      threadId: managed.id,
      userId,
      operations: ['thread.read'],
    });
    store.setWorkspaceResourcePolicyProjection(() => policy);
    expect(isThreadVisible(store, managed, userId)).toBe(true);
    expect(isThreadVisible(store, managed, userId, false, 'turn.run')).toBe(false);
    expect(isThreadVisible(store, managed, otherId)).toBe(false);
    expect(isThreadVisible(store, managed, otherId, true)).toBe(false);
    expect(
      store.listThreads(workspace.id).filter((thread) => isThreadVisible(store, thread, otherId))
    ).toEqual([ordinary]);
    policy = {
      ...policy,
      statements: policy.statements.filter((statement) => statement.kind === 'managed-boundary'),
    };
    expect(isThreadVisible(store, managed, userId)).toBe(false);
    expect(isThreadVisible(store, ordinary, userId)).toBe(true);
  });
});

it('does not copy a managed source into an unmanaged or different audience', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'thread-source-audience-'));
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Source boundary');
  const source = await store.createThread(workspace.id, 'Managed source');
  const destination = await store.createThread(workspace.id, 'Broad destination');
  const matching = await store.createThread(workspace.id, 'Matching destination');
  const userId = allocateEntityId('usr');
  store.setWorkspaceResourcePolicyProjection(() => ({
    schemaVersion: 1,
    statements: [
      ...managedThreadPolicy({
        workspaceId: workspace.id,
        threadId: source.id,
        userId,
        operations: ['thread.read'],
      }).statements,
      ...managedThreadPolicy({
        workspaceId: workspace.id,
        threadId: matching.id,
        userId,
        operations: ['thread.read'],
      }).statements,
    ],
  }));
  expect(canDiscloseThreadToAudience(store, source, source)).toBe(true);
  expect(canDiscloseThreadToAudience(store, source, destination)).toBe(false);
  expect(canDiscloseThreadToAudience(store, source, null)).toBe(false);
  expect(canDiscloseThreadToAudience(store, source, matching)).toBe(true);
  expect(canDiscloseThreadToAudience(store, destination, source)).toBe(true);
});

it('never interprets a Server Thread as Workspace audience authority', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-thread-audience-'));
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = createTestStore({ dataRoot });
  const timestamp = '2026-10-19T00:00:00.000Z';
  const thread = ThreadSchema.parse({
    id: allocateEntityId('th'),
    owner: { kind: 'server' },
    name: 'Server work',
    preview: 'Server work',
    status: 'active',
    entryPath: 'knowledge-manager',
    visibility: 'server',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  for (const administratorEligible of [false, true]) {
    expect(isThreadVisible(store, thread, allocateEntityId('usr'), administratorEligible)).toBe(
      false
    );
  }
  expect(canDiscloseThreadToAudience(store, thread, thread)).toBe(false);
  expect(canDiscloseThreadToAudience(store, thread, null)).toBe(false);
});

/** Real Thread owners and the existing loaded-Policy fixture; no configuration admission is claimed. */
async function audienceFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'policy-p6-audience-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const otherId = allocateEntityId('usr');
  const store = createTestStore({ dataRoot });
  onTestFinished(() => disposeTestStore(dataRoot, coreDb));
  const workspace = await store.createWorkspace('Policy audience contract');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const source = await store.createThread(workspace.id, 'Source');
  const destination = await store.createThread(workspace.id, 'Destination');
  let current: PolicyDocumentV1 = { schemaVersion: 1, statements: [] };
  let sequence = 0;
  store.setWorkspaceResourcePolicyProjection(() => current);
  const boundary = (threadId: string) =>
    managedThreadPolicy({ workspaceId: workspace.id, threadId, userId }).statements[0]!;
  const permission = (
    threadId: string,
    recipientId: string,
    actions: string[] = ['thread.read'],
    effect: 'allow' | 'prohibit' = 'allow',
    agentId?: string
  ): PolicyDocumentV1['statements'][number] => {
    const grant = managedThreadPolicy({
      workspaceId: workspace.id,
      threadId,
      userId,
      operations: actions,
      ...(agentId ? { agentId } : {}),
    }).statements.find((statement) => statement.kind === 'permission');
    if (!grant) throw new Error('The shared builder must produce the requested permission.');
    return {
      ...grant,
      id: `audience-permission-${sequence++}`,
      effect,
      scope: { ...grant.scope, subjects: [{ kind: 'human', id: recipientId }] },
    };
  };
  const load = (...statements: PolicyDocumentV1['statements']) => {
    current = WorkspacePolicyDocumentSchema.parse({ schemaVersion: 1, statements });
  };
  return {
    coreDb,
    store,
    workspace,
    source,
    destination,
    userId,
    otherId,
    boundary,
    permission,
    load,
  };
}

describe('P6 semantic managed-audience containment (Policy core; product-ablation P6/F50)', () => {
  // New #534 behavior: representation equivalence and narrower grant/prohibition audiences.
  it.each(['split actions', 'narrower recipients', 'additional prohibition'] as const)(
    'admits a destination with %s without granting source access',
    async (scenario) => {
      const f = await audienceFixture();
      const { source: s, destination: d, userId: u, otherId: v, boundary: b, permission: p } = f;
      const sourceGrants = [p(s.id, u, ['thread.read', 'turn.run'])];
      let destinationGrants = [p(d.id, u, ['thread.read', 'turn.run'])];
      if (scenario === 'split actions')
        destinationGrants = [p(d.id, u, ['thread.read']), p(d.id, u, ['turn.run'])];
      if (scenario === 'narrower recipients' || scenario === 'additional prohibition')
        sourceGrants.push(p(s.id, v, ['thread.read']));
      if (scenario === 'additional prohibition')
        destinationGrants.push(p(d.id, v), p(d.id, v, ['thread.read'], 'prohibit'));
      f.load(b(s.id), b(d.id), ...sourceGrants, ...destinationGrants);

      // Current source read is independently required; containment is not a source grant.
      expect(isThreadVisible(f.store, s, u)).toBe(true);
      if (scenario === 'narrower recipients' || scenario === 'additional prohibition') {
        expect(isThreadVisible(f.store, s, v)).toBe(true);
        expect(isThreadVisible(f.store, d, v)).toBe(false);
        expect(isThreadVisible(f.store, d, v, true)).toBe(false);
      }
      expect(isThreadVisible(f.store, d, u)).toBe(true);
      expect(isThreadVisible(f.store, s, allocateEntityId('usr'), true)).toBe(false);
      expect(canDiscloseThreadToAudience(f.store, s, d)).toBe(true);
    }
  );

  it.each(['human', 'agent'] as const)(
    'refuses a destination that drops the source %s prohibition',
    async (kind) => {
      const f = await audienceFixture();
      const { source: s, destination: d, userId: u, otherId: v, boundary: b, permission: p } = f;
      const grants = (threadId: string) =>
        kind === 'human'
          ? [p(threadId, u), p(threadId, v)]
          : [p(threadId, u), p(threadId, u, ['thread.read'], 'allow', 'reader-a')];
      f.load(
        b(s.id),
        b(d.id),
        ...grants(s.id),
        ...grants(d.id),
        p(
          s.id,
          kind === 'human' ? v : u,
          ['thread.read'],
          'prohibit',
          kind === 'agent' ? 'reader-a' : undefined
        )
      );
      expect(isThreadVisible(f.store, s, u)).toBe(true);
      expect(isThreadVisible(f.store, d, u)).toBe(true);
      if (kind === 'human') {
        expect(isThreadVisible(f.store, s, v)).toBe(false);
        expect(isThreadVisible(f.store, d, v)).toBe(true);
      } else {
        const actor = {
          kind: 'agent' as const,
          userId: u,
          agentId: 'reader-a',
          processId: 'reader-run',
        };
        expect(isThreadVisible(f.store, s, u, false, 'thread.read', actor)).toBe(false);
        expect(isThreadVisible(f.store, d, u, false, 'thread.read', actor)).toBe(true);
      }
      expect(canDiscloseThreadToAudience(f.store, s, d)).toBe(false);
    }
  );

  it('does not treat an extra destination operation as a narrower audience', async () => {
    const f = await audienceFixture();
    const { source: s, destination: d, userId: u, boundary: b, permission: p } = f;
    f.load(b(s.id), b(d.id), p(s.id, u), p(d.id, u, ['thread.read', 'turn.run']));
    expect(isThreadVisible(f.store, s, u)).toBe(true);
    expect(isThreadVisible(f.store, d, u)).toBe(true);
    expect(isThreadVisible(f.store, s, u, false, 'turn.run')).toBe(false);
    expect(isThreadVisible(f.store, d, u, false, 'turn.run')).toBe(true);
    expect(canDiscloseThreadToAudience(f.store, s, d)).toBe(false);
  });

  it('fails closed when current loaded audience authority becomes unavailable', async () => {
    const f = await audienceFixture();
    const { source: s, destination: d, userId: u, boundary: b, permission: p } = f;
    f.load(b(s.id), b(d.id), p(s.id, u), p(d.id, u));
    expect(isThreadVisible(f.store, s, u)).toBe(true);
    expect(canDiscloseThreadToAudience(f.store, s, d)).toBe(true);
    f.store.setWorkspaceResourcePolicyProjection(() => {
      throw new Error('Policy unavailable');
    });
    expect(isThreadVisible(f.store, s, u)).toBe(false);
    expect(isThreadVisible(f.store, s, u, true)).toBe(false);
    expect(canDiscloseThreadToAudience(f.store, s, d)).toBe(false);
    expect(f.store.getThread(f.workspace.id, s.id).id).toBe(s.id);
  });
});

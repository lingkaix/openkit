import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationId } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { loadWorkspaceResourceCatalog, readWorkspaceSkillSnapshot } from './resource-catalog.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
const tree = [
  {
    kind: 'file',
    path: 'SKILL.md',
    executable: false,
    contentBase64: Buffer.from(
      '---\nname: native-candidate\ndescription: Synthetic native candidate.\n---\nExact synthetic instructions.\n'
    ).toString('base64'),
  },
];

/** Real public operations and retained Artifact/SQLite owners; no Worker execution is modeled. */
function fixture(
  options: { privateOwner?: string; personal?: boolean; administrator?: boolean } = {}
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-native-skill-candidate-'));
  cleanups.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanups.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const privateOwnerUserId = options.privateOwner === 'self' ? userId : options.privateOwner;
  const store = new FsStore({ dataRoot });
  const workspace = options.personal
    ? store.ensureQuickChatWorkspace(userId)
    : store.createWorkspace('Synthetic native Skill');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = store.createThread(
    workspace.id,
    'Synthetic producing work',
    undefined,
    'conversation',
    privateOwnerUserId ? { visibility: 'private', privateOwnerUserId } : { visibility: 'workspace' }
  );
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    'Prepare a candidate only.',
    { kind: 'user', id: userId },
    null,
    { agentId: 'ag_synthetic_native' }
  );
  const body = JSON.stringify(tree);
  const contentDigest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const artifact = store.createArtifact({
    id: allocateEntityId('ar'),
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    kind: 'file',
    title: 'Synthetic candidate',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'json', body },
    contentDigest,
    lastMutationRequestId: 'synthetic-output',
    origin: {
      kind: 'turn-output',
      threadId: thread.id,
      turnId: turn.id,
      requestId: 'synthetic-output',
    },
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: '2026-10-16T00:00:00Z',
  });
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: options.administrator ? 'server-admin' : 'workspace',
    workspaceIds: options.administrator ? [] : [workspace.id],
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    mode: 'server',
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 }),
    },
  });
  const input = {
    workspaceId: workspace.id,
    skillId: 'native-candidate',
    expectedRevision: 0,
    baseDigest: null,
    requestId: randomUUID(),
    summary: 'Synthetic native submission.',
    artifact: { artifactId: artifact.id, version: artifact.version, contentDigest },
  };
  return { app, artifact, coreDb, dataRoot, input, store, thread, token, turn, userId, workspace };
}

/** Crosses the real HTTP/native admission boundary with the current retained bearer. */
function call(f: ReturnType<typeof fixture>, operation: OperationId, input: unknown) {
  return f.app.request(
    ...operationRequest(
      operation,
      {},
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${f.token.secret}` },
        body: JSON.stringify(input),
      }
    )
  );
}

describe('native Artifact-origin Skill candidates', () => {
  it('submits exact inactive bytes, replays one receipt, promotes by a real human decision and pins the retained version', async () => {
    const f = fixture();
    const response = await call(f, 'catalog.skill-candidate-submit', f.input);
    expect(response.status, await response.clone().text()).toBe(201);
    const submitted = await response.json();
    expect(submitted.candidate).toMatchObject({
      disposition: 'proposed',
      decision: null,
      producer: { kind: 'agent', id: 'ag_synthetic_native' },
      submitter: { kind: 'user', id: f.userId },
    });
    let catalog = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    expect(catalog.skills.entries[0]?.currentDigest).toBeNull();
    expect(catalog.skills.pins).toEqual([]);
    expect(catalog.skills.candidates[0]?.evidenceRefs.join(' ')).toContain(
      f.artifact.contentDigest
    );
    expect(catalog.skills.candidates[0]?.evidenceRefs.join(' ')).toContain(f.turn.id);
    const replay = await call(f, 'catalog.skill-candidate-submit', f.input);
    expect(replay.status).toBe(201);
    expect((await replay.json()).candidate.id).toBe(submitted.candidate.id);
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).revision).toBe(
      catalog.revision
    );
    const conflict = await call(f, 'catalog.skill-candidate-submit', {
      ...f.input,
      summary: 'Different intent.',
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('idempotency_key_conflict');
    const decideInput = {
      workspaceId: f.workspace.id,
      candidateId: submitted.candidate.id,
      decision: 'promoted',
      expectedRevision: catalog.revision,
      expectedCurrentDigest: null,
      requestId: randomUUID(),
    };
    const decided = await call(f, 'catalog.skill-candidate-decide', decideInput);
    expect(decided.status, await decided.clone().text()).toBe(200);
    catalog = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    expect(catalog.skills.candidates[0]?.decision?.actor).toEqual({
      kind: 'user',
      id: f.userId,
    });
    expect(catalog.skills.entries[0]?.currentDigest).toBe(submitted.candidate.candidateDigest);
    const pin = await call(f, 'catalog.skill-pin', {
      workspaceId: f.workspace.id,
      skillId: f.input.skillId,
      digest: submitted.candidate.candidateDigest,
      expectedPinDigest: null,
      expectedRevision: catalog.revision,
      requestId: randomUUID(),
    });
    expect(pin.status, await pin.clone().text()).toBe(200);
    const selected = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.pins[0]!
      .digest;
    expect(
      readWorkspaceSkillSnapshot({
        dataRoot: f.dataRoot,
        workspaceId: f.workspace.id,
        entryId: f.input.skillId,
        digest: selected,
      }).entries[0]?.content?.toString('base64')
    ).toBe(tree[0]!.contentBase64);
    const decisionReplay = await call(f, 'catalog.skill-candidate-decide', decideInput);
    expect(decisionReplay.status).toBe(200);
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.candidates).toHaveLength(
      1
    );
    const workspaceDb = openWorkspaceDb(f.dataRoot, f.workspace.id);
    try {
      expect(
        workspaceDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM idempotency_requests WHERE command_name IN ('catalog.skill-candidate-submit', 'catalog.skill-candidate-decide')"
          )
          .get()
      ).toEqual({ count: 2 });
      expect(
        workspaceDb.sqlite
          .prepare('SELECT actor_json AS actor FROM audit_events WHERE audit_event_id = ?')
          .get(catalog.skills.candidates[0]!.decision!.auditRef)
      ).toEqual({ actor: JSON.stringify({ kind: 'user', id: f.userId }) });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it.each([
    'own-private',
    'foreign-private',
    'administrator-private',
    'foreign-workspace',
    'revoked',
    'stale',
  ] as const)('refuses %s before candidate effects', async (reason) => {
    const f = fixture({
      ...(reason.includes('private')
        ? { privateOwner: reason === 'foreign-private' ? allocateEntityId('usr') : 'self' }
        : {}),
      administrator: reason === 'administrator-private' || reason === 'foreign-workspace',
    });
    if (reason === 'revoked') revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    if (reason === 'stale') f.input.artifact.version += 1;
    if (reason === 'foreign-workspace') {
      const other = f.store.createWorkspace('Other synthetic Workspace');
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        workspaceId: other.id,
        ownerUserId: f.userId,
      });
      f.input.workspaceId = other.id;
    }
    const response = await call(f, 'catalog.skill-candidate-submit', f.input);
    expect(response.status, await response.clone().text()).toBe(
      reason === 'revoked' ? 401 : reason === 'stale' ? 409 : 503
    );
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.candidates).toEqual([]);
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.input.workspaceId).revision).toBe(0);
  });

  it('keeps own-private input in its owner-only personal Workspace', async () => {
    const f = fixture({ personal: true, privateOwner: 'self' });
    const response = await call(f, 'catalog.skill-candidate-submit', f.input);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(
      loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.entries[0]?.currentDigest
    ).toBeNull();
  });

  it('rechecks current authority on receipt replay', async () => {
    const f = fixture();
    expect((await call(f, 'catalog.skill-candidate-submit', f.input)).status).toBe(201);
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    const before = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).revision;
    const replay = await call(f, 'catalog.skill-candidate-submit', f.input);
    expect(replay.status, await replay.clone().text()).toBe(401);
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).revision).toBe(before);
  });

  it.each([
    'rejected',
    'withdrawn',
  ] as const)('records a real human %s decision without activation', async (disposition) => {
    const f = fixture();
    const response = await call(f, 'catalog.skill-candidate-submit', f.input);
    expect(response.status, await response.clone().text()).toBe(201);
    const submitted = await response.json();
    const input = {
      workspaceId: f.workspace.id,
      candidateId: submitted.candidate.id,
      expectedRevision: submitted.revision,
      requestId: randomUUID(),
      ...(disposition === 'rejected' ? { decision: disposition, expectedCurrentDigest: null } : {}),
    };
    const operation =
      disposition === 'rejected'
        ? 'catalog.skill-candidate-decide'
        : 'catalog.skill-candidate-withdraw';
    const decision = await call(f, operation, input);
    expect(decision.status, await decision.clone().text()).toBe(200);
    const catalog = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    expect(catalog.skills.candidates[0]).toMatchObject({
      disposition,
      decision: { actor: { kind: 'user', id: f.userId } },
    });
    expect(catalog.skills.entries[0]?.currentDigest).toBeNull();
    expect(catalog.skills.pins).toEqual([]);
    expect((await call(f, operation, input)).status).toBe(200);
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).revision).toBe(
      catalog.revision
    );
  });

  it.each([
    'both',
    'neither',
  ] as const)('refuses %s candidate input alternatives before candidate effects', async (choice) => {
    const f = fixture();
    const { artifact: _artifact, ...base } = f.input;
    const response = await call(
      f,
      'catalog.skill-candidate-submit',
      choice === 'both' ? { ...f.input, tree } : base
    );
    expect(response.status, await response.clone().text()).toBe(400);
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).revision).toBe(0);
  });

  it('reports an interrupted receipt without replaying a completed catalog effect', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'recordCommandRequest').mockImplementationOnce(() => {
      throw new Error('Synthetic receipt failure.');
    });
    const response = await call(f, 'catalog.skill-candidate-submit', f.input);
    expect(response.status, await response.clone().text()).toBe(409);
    expect((await response.json()).code).toBe('recovery_required');
    const catalog = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    expect(catalog.skills.candidates).toHaveLength(1);
    expect(catalog.skills.entries[0]?.currentDigest).toBeNull();
    const retry = await call(f, 'catalog.skill-candidate-submit', f.input);
    expect(retry.status, await retry.clone().text()).toBe(409);
    expect((await retry.json()).code).toBe('recovery_required');
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(catalog);
    expect(f.store.listCommandRequests()).toEqual([]);
  });
});

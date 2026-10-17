import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { type Actor, ensureLocalUser } from './auth/identity.js';
import { isWorkspaceOperationAuthorized } from './auth/operation-authorizer.js';
import { disableCanonicalUser } from './auth/user-lifecycle.js';
import { validateCatalogTree } from './catalog/resource-catalog.js';
import { FsStore } from './lib/store.js';
import {
  MAX_SKILL_CANDIDATE_ARTIFACT_BYTES,
  readSkillCandidateArtifact,
  type SkillCandidateArtifactError,
  type SkillCandidateArtifactSelection,
} from './skill-candidate-artifact.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { stageArtifactPayload } from './storage/artifacts/file-payload.js';
import { artifactFilePayloadPath } from './storage/artifacts/file-records.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
const digest = (body: string) =>
  `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
const tree = [
  {
    kind: 'file' as const,
    path: 'SKILL.md',
    executable: false,
    contentBase64: Buffer.from(
      '---\nname: example\ndescription: Example.\n---\nInstructions.\n'
    ).toString('base64'),
  },
];

function fixture(body = JSON.stringify(tree)) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-skill-artifact-'));
  cleanup.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanup.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot }, userId);
  const workspaceId = store.listWorkspaces().find((workspace) => workspace.kind !== 'personal')!.id;
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
  const actor: Actor = { kind: 'session', userId };
  const selection: SkillCandidateArtifactSelection = {
    workspaceId,
    artifactId: allocateEntityId('ar'),
    version: 1,
    contentDigest: digest(body),
  };
  store.createArtifact({
    id: selection.artifactId,
    workspaceId,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: 'Candidate',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'json', body },
    contentDigest: selection.contentDigest,
    lastMutationRequestId: 'import-candidate',
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: 'import-candidate',
      sourceDigest: selection.contentDigest,
      actor: { kind: 'user', id: userId },
      requestId: 'import-candidate',
      recordedAt: '2026-10-16T00:00:00Z',
    },
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: '2026-10-16T00:00:00Z',
  });
  return { dataRoot, coreDb, store, actor, selection };
}

describe('retained Artifact Skill candidate input', () => {
  it('decodes exact retained JSON after reopen with real SQLite authority', () => {
    const state = fixture();
    const store = new FsStore({ dataRoot: state.dataRoot });
    const before = readdirSync(state.dataRoot, { recursive: true }).map(String).sort();
    expect(readSkillCandidateArtifact({ ...state, store })).toMatchObject({
      digest: validateCatalogTree(tree).digest,
      tree,
      source: { ...state.selection, origin: { kind: 'imported' } },
      submitter: { kind: 'user', id: state.actor.userId },
      producer: { kind: 'user', id: state.actor.userId },
      producingTurn: null,
    });
    expect(readdirSync(state.dataRoot, { recursive: true }).map(String).sort()).toEqual(before);
    expect(
      existsSync(
        join(state.dataRoot, 'workspaces', state.selection.workspaceId, 'catalog', 'catalog.json')
      )
    ).toBe(false);
    expect(
      store.getArtifact(state.selection.workspaceId, state.selection.artifactId).content.body
    ).toBe(JSON.stringify(tree));
  });
});

function workSource(
  state: ReturnType<typeof fixture>,
  privateOwnerUserId?: string,
  agentId?: string
) {
  const workspaceId = state.selection.workspaceId;
  const thread = state.store.createThread(
    workspaceId,
    'Producing work',
    undefined,
    'conversation',
    privateOwnerUserId ? { visibility: 'private', privateOwnerUserId } : { visibility: 'workspace' }
  );
  const turn = state.store.createTurn(workspaceId, thread.id, 'Prepare Skill', {
    kind: 'user',
    id: state.actor.userId,
  });
  if (agentId) state.store.updateTurn(turn.id, { agentId });
  const original = state.store.getArtifact(workspaceId, state.selection.artifactId);
  const artifact = state.store.createArtifact({
    ...original,
    id: allocateEntityId('ar'),
    threadId: thread.id,
    turnId: turn.id,
    origin: {
      kind: 'turn-output',
      threadId: thread.id,
      turnId: turn.id,
      requestId: 'produce-candidate',
    },
    lastMutationRequestId: 'produce-candidate',
  });
  return { ...state, thread, turn, selection: { ...state.selection, artifactId: artifact.id } };
}

function refuses(
  state: Parameters<typeof readSkillCandidateArtifact>[0],
  code: SkillCandidateArtifactError['code']
) {
  expect(() => readSkillCandidateArtifact(state)).toThrowError(
    expect.objectContaining({ name: 'SkillCandidateArtifactError', code })
  );
}

describe('Skill Artifact source admission', () => {
  it('retains producing Worker lineage separately from the submitting user', () => {
    const state = workSource(fixture(), undefined, 'ag_producing_worker');
    const reopened = new FsStore({ dataRoot: state.dataRoot });
    const result = readSkillCandidateArtifact({ ...state, store: reopened });
    expect(result).toMatchObject({
      producer: { kind: 'agent', id: 'ag_producing_worker', responsibleUserId: state.actor.userId },
      submitter: { kind: 'user', id: state.actor.userId },
      producingTurn: {
        workspaceId: state.selection.workspaceId,
        threadId: state.thread.id,
        turnId: state.turn.id,
        agentId: 'ag_producing_worker',
      },
      source: { origin: { kind: 'turn-output', threadId: state.thread.id, turnId: state.turn.id } },
    });
  });

  it('reads exact file-backed Worker JSON as a native Skill candidate without changing the original', async () => {
    const state = workSource(fixture(), undefined, 'ag_producing_worker');
    const original = state.store.getArtifact(
      state.selection.workspaceId,
      state.selection.artifactId
    );
    const bytes = Buffer.from(JSON.stringify(tree));
    const workspaceRoot = join(state.dataRoot, 'workspaces', state.selection.workspaceId);
    const admission = new FileStorageAdmission(state.dataRoot, () => 0n);
    const reservation = admission.reserve({
      stagingBytes: BigInt(bytes.length),
      extractionBytes: 0n,
      derivativeBytes: 0n,
      publicationBytes: BigInt(bytes.length),
    });
    const staged = await stageArtifactPayload({
      workspaceRoot,
      reservation,
      source: Readable.from([bytes]),
      expectedByteLength: bytes.length,
      expectedDigest: state.selection.contentDigest,
    });
    let artifact: typeof original;
    try {
      artifact = state.store.createArtifact(
        {
          ...original,
          id: allocateEntityId('ar'),
          content: { format: 'file', mediaType: 'application/json', byteLength: bytes.length },
        },
        staged
      );
    } finally {
      await staged.remove();
      reservation.release();
    }
    const selection = { ...state.selection, artifactId: artifact.id };
    const payload = artifactFilePayloadPath(workspaceRoot, artifact.id, selection.version);
    const before = readFileSync(payload);
    const result = readSkillCandidateArtifact({
      ...state,
      selection,
      store: new FsStore({ dataRoot: state.dataRoot }),
      destination: 'workspace-skill',
    });
    expect(result).toMatchObject({
      tree,
      digest: validateCatalogTree(tree).digest,
      source: { ...selection, origin: original.origin },
      producer: { kind: 'agent', id: 'ag_producing_worker', responsibleUserId: state.actor.userId },
      submitter: { kind: 'user', id: state.actor.userId },
      producingTurn: {
        workspaceId: selection.workspaceId,
        threadId: state.thread.id,
        turnId: state.turn.id,
      },
    });
    expect(readFileSync(payload)).toEqual(before);
    expect(before).toEqual(bytes);
    expect(`sha256:${createHash('sha256').update(before).digest('hex')}`).toBe(
      selection.contentDigest
    );
  });

  it('reports unproven Worker identity as unavailable instead of using the submitter', () => {
    const state = workSource(fixture());
    expect(readSkillCandidateArtifact(state)).toMatchObject({
      producer: null,
      producingTurn: { agentId: null },
      submitter: { kind: 'user', id: state.actor.userId },
    });
  });

  it('preserves imported attribution without inventing a Worker or Thread', () => {
    const state = fixture();
    const artifact = state.store.getArtifact(
      state.selection.workspaceId,
      state.selection.artifactId
    );
    if (artifact.origin.kind !== 'imported') throw new Error('Expected imported fixture.');
    artifact.origin.actor = {
      kind: 'integration',
      id: 'integration_source',
      responsibleUserId: null,
    };
    expect(readSkillCandidateArtifact(state)).toMatchObject({
      producer: artifact.origin.actor,
      producingTurn: null,
      submitter: { kind: 'user', id: state.actor.userId },
      source: { origin: { kind: 'imported', actor: artifact.origin.actor } },
    });
  });

  it('does not disclose another private Thread even to a Workspace owner', () => {
    const state = workSource(fixture(), allocateEntityId('usr'), 'ag_private');
    refuses(state, 'source_unavailable');
  });

  it('admits the current private Thread owner', () => {
    const state = fixture();
    expect(
      readSkillCandidateArtifact(workSource(state, state.actor.userId, 'ag_private')).tree
    ).toEqual(tree);
  });

  it('does not find an Artifact by scanning another Workspace', () => {
    const state = fixture();
    const other = state.store.createWorkspace('Other');
    recordWorkspaceOwnerMembership({
      coreDb: state.coreDb,
      workspaceId: other.id,
      ownerUserId: state.actor.userId,
    });
    refuses(
      { ...state, selection: { ...state.selection, workspaceId: other.id } },
      'source_unavailable'
    );
  });

  it('rejects a missing Artifact without revealing an identifier or bytes', () => {
    const state = fixture();
    const missingArtifactId = allocateEntityId('ar');
    refuses(
      { ...state, selection: { ...state.selection, artifactId: missingArtifactId } },
      'source_unavailable'
    );
    try {
      readSkillCandidateArtifact({
        ...state,
        selection: { ...state.selection, artifactId: missingArtifactId },
      });
    } catch (error) {
      expect((error as Error).message).toBe('Skill Artifact is unavailable.');
    }
  });

  it('requires current actor authority, including readonly credentials', () => {
    const state = fixture();
    const { tokenId } = createOpenKitAccessTokenRecord(state.coreDb, {
      ownerUserId: state.actor.userId,
      scope: 'workspace-readonly',
      workspaceIds: [state.selection.workspaceId],
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const readonlyActor: Actor = {
      kind: 'token',
      userId: state.actor.userId,
      tokenId,
      tokenScope: 'workspace-readonly',
      tokenWorkspaceIds: [state.selection.workspaceId],
    };
    expect(
      isWorkspaceOperationAuthorized(state.coreDb, readonlyActor, state.selection.workspaceId, {
        mutating: false,
        policyOperation: 'artifact.read',
      })
    ).toBe(true);
    refuses(
      {
        ...state,
        actor: {
          kind: 'token',
          tokenId,
          userId: state.actor.userId,
          tokenScope: 'workspace-readonly',
          tokenWorkspaceIds: [state.selection.workspaceId],
        },
      },
      'source_unavailable'
    );
    state.coreDb.sqlite.transaction(() => disableCanonicalUser(state.coreDb, state.actor.userId))();
    refuses(state, 'source_unavailable');
  });

  it('rechecks current actor authority before returning decoded bytes', () => {
    const state = fixture();
    const artifact = state.store.getArtifact(
      state.selection.workspaceId,
      state.selection.artifactId
    );
    vi.spyOn(state.store, 'getArtifact').mockImplementation(() => {
      state.coreDb.sqlite.transaction(() =>
        disableCanonicalUser(state.coreDb, state.actor.userId)
      )();
      return artifact;
    });
    refuses(state, 'source_unavailable');
  });

  it.each(['version', 'contentDigest'] as const)('rejects a stale selected %s', (field) => {
    const state = fixture();
    refuses(
      {
        ...state,
        selection: {
          ...state.selection,
          [field]: field === 'version' ? 2 : `sha256:${'0'.repeat(64)}`,
        },
      },
      'stale'
    );
  });

  it('rechecks the exact selected source after decoding', () => {
    const state = fixture();
    const artifact = state.store.getArtifact(
      state.selection.workspaceId,
      state.selection.artifactId
    );
    let reads = 0;
    vi.spyOn(state.store, 'getArtifact').mockImplementation(() => ({
      ...artifact,
      version: ++reads === 1 ? 1 : 2,
    }));
    refuses(state, 'stale');
  });

  it('verifies actual retained bytes rather than trusting the stored digest field', () => {
    const state = fixture();
    state.store.getArtifact(state.selection.workspaceId, state.selection.artifactId).content.body =
      '["corrupt-original-canary"]';
    refuses(state, 'source_unavailable');
  });

  it.each([
    'draft',
    'archived',
  ] as const)('admits an explicitly selected readable %s source without activation', (status) => {
    const state = workSource(fixture());
    state.store.getArtifact(state.selection.workspaceId, state.selection.artifactId).status =
      status;
    expect(readSkillCandidateArtifact(state).tree).toEqual(tree);
    expect(
      existsSync(
        join(state.dataRoot, 'workspaces', state.selection.workspaceId, 'catalog', 'catalog.json')
      )
    ).toBe(false);
  });
});

describe('bounded Skill Artifact JSON and tree', () => {
  it.each([
    '{malformed-json-canary',
    JSON.stringify({ tree }),
    JSON.stringify([null]),
    JSON.stringify([{ kind: 'symlink', path: 'link', target: '/outside-canary' }]),
    JSON.stringify([{ ...tree[0], path: '../outside-canary' }]),
    JSON.stringify([{ ...tree[0], path: '/outside-canary' }]),
    JSON.stringify([{ ...tree[0], path: '.git/config' }]),
    JSON.stringify([tree[0], tree[0]]),
    JSON.stringify([{ ...tree[0], contentBase64: '???' }]),
    JSON.stringify([{ kind: 'directory', path: 'references', contentBase64: 'YQ==' }, ...tree]),
  ])('rejects malformed or unsafe trees without exposing their content (%#)', (body) => {
    const state = fixture(body);
    const before = readdirSync(state.dataRoot, { recursive: true }).map(String).sort();
    refuses(state, 'invalid_request');
    expect(readdirSync(state.dataRoot, { recursive: true }).map(String).sort()).toEqual(before);
    expect(
      existsSync(
        join(state.dataRoot, 'workspaces', state.selection.workspaceId, 'catalog', 'catalog.json')
      )
    ).toBe(false);
  });

  it('rejects more than the Skill file-byte bound through the shared tree validator', () => {
    const state = fixture(
      JSON.stringify([
        ...tree,
        {
          kind: 'file',
          path: 'large.bin',
          contentBase64: Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64'),
        },
      ])
    );
    refuses(state, 'invalid_request');
  });

  it('bounds valid JSON framing before parsing a complete small tree', () => {
    const state = fixture(' '.repeat(MAX_SKILL_CANDIDATE_ARTIFACT_BYTES) + JSON.stringify(tree));
    refuses(state, 'invalid_request');
  });

  it('includes directories, supporting bytes and executability in the same tree digest', () => {
    const fullTree = [
      ...tree,
      { kind: 'directory' as const, path: 'empty' },
      { kind: 'file' as const, path: 'scripts/run', executable: true, contentBase64: 'AAEC/w==' },
    ];
    const result = readSkillCandidateArtifact(fixture(JSON.stringify(fullTree)));
    expect(result.tree).toEqual(fullTree);
    expect(result.digest).toBe(validateCatalogTree(fullTree).digest);
    expect(result.digest).not.toBe(validateCatalogTree(tree).digest);
  });
});

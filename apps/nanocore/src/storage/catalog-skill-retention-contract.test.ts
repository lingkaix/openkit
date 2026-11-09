// openkit-test-platform: posix
// L3: public catalog.skill-purge operation -> real Core, Store, catalog, AEP and evidence owners.
// Owners: docs/specs/20260711-skill_catalog_versioning_pinning.md (Removal and retention),
// docs/core/storage.md (retention classes and legal hold), and
// docs/specs/20260703-audit_usage_evidence_records.md (evidence lifecycle).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import {
  type CatalogTreeFile,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  skillSnapshotPath,
} from '../catalog/resource-catalog.js';
import {
  compactWorkspaceEvidenceBundles,
  listStoredWorkspaceEvidenceBundles,
  recordWorkspaceEvidenceBundle,
} from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import {
  recordAgentEnvironmentPackageSnapshot,
  requireAgentEnvironmentPackageSnapshot,
} from '../runtime/aep-snapshot-ledger.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { agentSessionsRoot } from './workspace-file-records.js';

const ENTRY_ID = 'retention-example';
const SKILL_PATH = 'SKILL.md';

const cleanup: Array<() => void> = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Exact uploaded bytes keep the retention decision independent of display metadata. */
function tree(body: string): CatalogTreeFile[] {
  return [
    {
      kind: 'file',
      path: SKILL_PATH,
      contentBase64: Buffer.from(
        `---\nname: Retention Example\ndescription: Exercise public retention decisions.\n---\n${body}\n`
      ).toString('base64'),
    },
  ];
}

/**
 * Real Core, Store, Workspace and catalog owners. The two imports arrange one active and one
 * inactive version through the native catalog owner; the HTTP app is the public operation boundary.
 */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-skill-retention-'));
  cleanup.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanup.push(() => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Skill retention');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  cleanup.push(() => {
    if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
  });
  applyScopedMigrations(workspaceDb);
  const firstTree = tree('Version A');
  const secondTree = tree('Version B');
  const base = {
    dataRoot,
    workspaceId: workspace.id,
    id: ENTRY_ID,
    displayName: 'Retention Example',
    producer: { kind: 'user' as const, id: userId },
    createdAt: '2026-10-16T00:00:00Z',
  };
  const first = importWorkspaceSkill({
    ...base,
    expectedRevision: 0,
    activate: true,
    tree: firstTree,
  });
  const second = importWorkspaceSkill({
    ...base,
    expectedRevision: 1,
    activate: false,
    tree: secondTree,
  });
  const app = createApp({ coreDb, dataRoot, store });
  const call = (
    operation: Parameters<typeof operationRequest>[0],
    input: Record<string, unknown>
  ) =>
    app.request(
      ...operationRequest(
        operation,
        {},
        { body: JSON.stringify({ workspaceId: workspace.id, ...input }) }
      )
    );
  return {
    dataRoot,
    userId,
    coreDb,
    store,
    workspace,
    workspaceDb,
    first: first.version.digest,
    second: second.version.digest,
    firstBytes: firstTree[0]!.contentBase64,
    secondBytes: secondTree[0]!.contentBase64,
    call,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Reads exact retained content through the public read operation. */
function readContent(f: Fixture, digest: string) {
  return f.call('catalog.skill-content-read', {
    skillId: ENTRY_ID,
    digest,
    path: SKILL_PATH,
  });
}

/** Purge Audit lives with the existing Workspace Audit owner; a refusal publishes none. */
function purgeAudit(f: Fixture, requestId: string) {
  return listWorkspaceAuditEvents(f.workspaceDb, f.workspace.id).filter(
    (event) => event.requestId === requestId && event.action.startsWith('catalog.skill-purge')
  );
}

/** Records one unexpired AEP snapshot that names the current Skill version. */
async function recordSkillAep(f: Fixture) {
  const thread = await f.store.createThread(f.workspace.id, 'Retained Skill input');
  const turn = await f.store.createTurn(f.workspace.id, thread.id, 'Use the retained Skill', {
    kind: 'user',
    id: f.userId,
  });
  const snapshot = await resolveAgentEnvironmentPackage({
    captureCoverage: { scope: 'server', value: 'off' },
    agentSetup: createTestAgentSetup({ skillIds: [ENTRY_ID] }),
    agentSessionId: allocateEntityId('as'),
    backend: { kind: 'openshell' },
    coreDb: f.coreDb,
    createdAt: '2026-10-16T00:00:00.000Z',
    requestId: null,
    turn,
    triggerActor: turn.triggerActor,
    workspaceRoots: [],
  });
  await recordAgentEnvironmentPackageSnapshot(f.workspaceDb, {
    environmentPackage: snapshot,
    createdAt: '2026-10-16T00:00:00.000Z',
  });
  return snapshot;
}

/** Records one pre-normalized evidence bundle through its native owner. */
function recordEvidence(
  f: Fixture,
  input: {
    readonly id: string;
    readonly digest: string;
    readonly retentionClass: 'ephemeral-diagnostic' | 'legal-hold';
    readonly importStatus: 'collected' | 'expired';
  }
) {
  return recordWorkspaceEvidenceBundle(f.workspaceDb, {
    id: input.id,
    workspaceId: f.workspace.id,
    threadId: null,
    goalId: null,
    turnId: null,
    agentSessionId: null,
    backendType: null,
    sourceKind: 'skill-comparison',
    summary: 'Retained Skill input.',
    rawEvidenceRefs: [],
    redactedEvidenceRefs: [],
    contentDigests: [input.digest],
    retentionClass: input.retentionClass,
    sensitivityClass: 'product-safe',
    importStatus: input.importStatus,
    requiredFeatures: [],
    createdAt: '2026-10-01T00:00:00.000Z',
  });
}

/** Expires only the ordinary ephemeral diagnostic bundle through its existing owner. */
function expireEphemeralEvidence(f: Fixture) {
  compactWorkspaceEvidenceBundles({
    workspaceDb: f.workspaceDb,
    workspaceId: f.workspace.id,
    olderThan: '2026-10-15T00:00:00.000Z',
  });
}

describe('public Skill retention through catalog.skill-purge', () => {
  it('retains exact Skill bytes named by a retained AEP after the matching evidence expires', async () => {
    const f = await fixture();
    const snapshot = await recordSkillAep(f);
    // Expire the evidence owner's reference so only the immutable AEP snapshot can retain bytes.
    recordEvidence(f, {
      id: 'expired-skill-evidence',
      digest: f.first,
      retentionClass: 'ephemeral-diagnostic',
      importStatus: 'collected',
    });
    expireEphemeralEvidence(f);
    const expired = listStoredWorkspaceEvidenceBundles(f.workspaceDb, f.workspace.id).find(
      (record) => record.id === 'expired-skill-evidence'
    );
    expect(expired).toMatchObject({
      importStatus: 'expired',
      retentionClass: 'ephemeral-diagnostic',
    });

    const selected = await f.call('catalog.skill-select', {
      requestId: randomUUID(),
      expectedRevision: 2,
      skillId: ENTRY_ID,
      digest: f.second,
      expectedCurrentDigest: f.first,
    });
    expect(selected.status, await selected.clone().text()).toBe(200);

    const requestId = randomUUID();
    const refused = await f.call('catalog.skill-purge', {
      requestId,
      expectedRevision: 3,
      skillId: ENTRY_ID,
      digest: f.first,
    });
    expect(refused.status, await refused.clone().text()).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: 'resource_retained',
      details: { references: [`aep:${snapshot.snapshotId}`] },
    });
    expect(purgeAudit(f, requestId)).toEqual([]);

    const retainedAep = requireAgentEnvironmentPackageSnapshot(
      f.workspaceDb,
      f.workspace.id,
      snapshot.snapshotId
    );
    expect(
      retainedAep.snapshot.supply.skills.some(
        (skill) => skill.id === ENTRY_ID && skill.integrity?.sha256 === f.first
      )
    ).toBe(true);
    const catalog = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    expect(catalog.revision).toBe(3);
    expect(
      catalog.skills.versions.find((version) => version.digest === f.first)?.contentState
    ).toBe('retained');
    expect(existsSync(skillSnapshotPath(f.dataRoot, f.workspace.id, ENTRY_ID, f.first))).toBe(true);
    const content = await readContent(f, f.first);
    expect(content.status, await content.clone().text()).toBe(200);
    expect(await content.json()).toMatchObject({ contentBase64: f.firstBytes });
  });

  it('retains an expired evidence reference while its legal hold remains', async () => {
    const f = await fixture();
    // A retained bundle can keep its original expiry after restore; an active legal hold still
    // blocks deletion and grants no read authority (Core Storage retention classes).
    recordEvidence(f, {
      id: 'held-skill-evidence',
      digest: f.second,
      retentionClass: 'legal-hold',
      importStatus: 'expired',
    });

    const requestId = randomUUID();
    const refused = await f.call('catalog.skill-purge', {
      requestId,
      expectedRevision: 2,
      skillId: ENTRY_ID,
      digest: f.second,
    });
    expect(refused.status, await refused.clone().text()).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: 'resource_retained',
      details: { references: ['evidence:held-skill-evidence'] },
    });
    expect(purgeAudit(f, requestId)).toEqual([]);

    const held = listStoredWorkspaceEvidenceBundles(f.workspaceDb, f.workspace.id).find(
      (record) => record.id === 'held-skill-evidence'
    );
    expect(held).toMatchObject({ importStatus: 'expired', retentionClass: 'legal-hold' });
    const catalog = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    expect(catalog.revision).toBe(2);
    expect(
      catalog.skills.versions.find((version) => version.digest === f.second)?.contentState
    ).toBe('retained');
    expect(existsSync(skillSnapshotPath(f.dataRoot, f.workspace.id, ENTRY_ID, f.second))).toBe(
      true
    );
    const content = await readContent(f, f.second);
    expect(content.status, await content.clone().text()).toBe(200);
    expect(await content.json()).toMatchObject({ contentBase64: f.secondBytes });
  });

  it('permits exact purge after ordinary evidence expires and no reference remains', async () => {
    const f = await fixture();
    recordEvidence(f, {
      id: 'expired-unreferenced-evidence',
      digest: f.second,
      retentionClass: 'ephemeral-diagnostic',
      importStatus: 'collected',
    });
    expireEphemeralEvidence(f);
    expect(
      listStoredWorkspaceEvidenceBundles(f.workspaceDb, f.workspace.id).find(
        (record) => record.id === 'expired-unreferenced-evidence'
      )
    ).toMatchObject({ importStatus: 'expired' });

    const requestId = randomUUID();
    const purged = await f.call('catalog.skill-purge', {
      requestId,
      expectedRevision: 2,
      skillId: ENTRY_ID,
      digest: f.second,
    });
    expect(purged.status, await purged.clone().text()).toBe(200);
    expect(await purged.json()).toEqual({ revision: 3 });

    const catalog = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    expect(catalog.revision).toBe(3);
    expect(
      catalog.skills.versions.find((version) => version.digest === f.second)?.contentState
    ).toBe('purged');
    expect(
      catalog.skills.versions.find((version) => version.digest === f.first)?.contentState
    ).toBe('retained');
    expect(existsSync(skillSnapshotPath(f.dataRoot, f.workspace.id, ENTRY_ID, f.second))).toBe(
      false
    );
    expect(existsSync(skillSnapshotPath(f.dataRoot, f.workspace.id, ENTRY_ID, f.first))).toBe(true);

    const unavailable = await readContent(f, f.second);
    expect(unavailable.status, await unavailable.clone().text()).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: 'resource_unavailable' });
    const retained = await readContent(f, f.first);
    expect(retained.status, await retained.clone().text()).toBe(200);
    expect(await retained.json()).toMatchObject({ contentBase64: f.firstBytes });

    const audits = purgeAudit(f, requestId);
    expect(audits.map((event) => event.action).sort()).toEqual([
      'catalog.skill-purge',
      'catalog.skill-purge.admit',
    ]);
    for (const event of audits) {
      expect(event).toMatchObject({
        actor: { kind: 'user', id: f.userId },
        outcome: 'succeeded',
        resource: `skill:${ENTRY_ID}@${f.second}`,
      });
    }
    expect(
      audits.find((event) => event.action === 'catalog.skill-purge.admit')?.resourceRevision
    ).toBe(2);
    expect(audits.find((event) => event.action === 'catalog.skill-purge')?.resourceRevision).toBe(
      3
    );

    const replay = await f.call('catalog.skill-purge', {
      requestId,
      expectedRevision: 2,
      skillId: ENTRY_ID,
      digest: f.second,
    });
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual({ revision: 3 });
    expect(purgeAudit(f, requestId)).toHaveLength(2);
  });

  it('refuses without publication while the retained reference authority cannot be read', async () => {
    const f = await fixture();
    const snapshot = await recordSkillAep(f);
    const selected = await f.call('catalog.skill-select', {
      requestId: randomUUID(),
      expectedRevision: 2,
      skillId: ENTRY_ID,
      digest: f.second,
      expectedCurrentDigest: f.first,
    });
    expect(selected.status, await selected.clone().text()).toBe(200);
    const before = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
    expect(before.revision).toBe(3);

    const snapshotsRoot = join(
      agentSessionsRoot(f.workspaceDb),
      snapshot.scope.agentSessionId,
      'aep-snapshots'
    );
    const unreadableEntry = join(snapshotsRoot, 'unreadable-authority.json');
    const requestId = randomUUID();
    try {
      // A prepared retained-read fault makes the external reference authority unavailable without
      // manufacturing a reference, receipt or publication. The owner requires fail-closed refusal.
      symlinkSync(join(f.dataRoot, 'missing-authority-target'), unreadableEntry);
      const refused = await f.call('catalog.skill-purge', {
        requestId,
        expectedRevision: 3,
        skillId: ENTRY_ID,
        digest: f.first,
      });
      expect(refused.ok).toBe(false);
      // An unreadable retained authority is not a known retention cause: it keeps the existing
      // unclassified failure boundary and publishes neither a receipt nor an Audit completion.
      expect(refused.status).toBe(500);
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(before);
      expect(purgeAudit(f, requestId)).toEqual([]);
      expect(existsSync(skillSnapshotPath(f.dataRoot, f.workspace.id, ENTRY_ID, f.first))).toBe(
        true
      );
      const content = await readContent(f, f.first);
      expect(content.status, await content.clone().text()).toBe(200);
      expect(await content.json()).toMatchObject({ contentBase64: f.firstBytes });
    } finally {
      rmSync(unreadableEntry, { force: true });
    }

    // Restoring the exact retained entry proves the AEP reference is still the deciding cause.
    const known = await f.call('catalog.skill-purge', {
      requestId,
      expectedRevision: 3,
      skillId: ENTRY_ID,
      digest: f.first,
    });
    expect(known.status, await known.clone().text()).toBe(409);
    expect(await known.json()).toMatchObject({
      code: 'resource_retained',
      details: { references: [`aep:${snapshot.snapshotId}`] },
    });
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(before);
    expect(purgeAudit(f, requestId)).toEqual([]);
  });
});

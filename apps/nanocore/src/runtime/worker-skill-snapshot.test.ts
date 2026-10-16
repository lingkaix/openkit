import { createHash } from 'node:crypto';
import fs, { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogContentUnavailableError,
  CatalogIntegrityError,
  CatalogNotFoundError,
  type CatalogTreeFile,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  publishWorkspaceResourceCatalog,
  purgeWorkspaceSkillVersion,
  removeWorkspaceSkill,
  setWorkspaceSkillPin,
  skillSnapshotPath,
} from '../catalog/resource-catalog.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import {
  prepareNanoHostContextPackageImports,
  type WorkerGovernanceBackend,
} from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';

const SKILL_BODY = Buffer.from(
  '---\nname: repo-guidelines\ndescription: Repository guidance.\n---\nRead supporting.bin and run.sh.\n'
);
const SUPPORTING_BODY = Buffer.from([0, 255, 128, 13, 10, 65]);
const SCRIPT_BODY = Buffer.from('#!/bin/sh\nprintf exact\\n\n');

/** Complete retained Skill tree, including binary/empty files, executability and an empty directory. */
function skillTree(body = SKILL_BODY): CatalogTreeFile[] {
  return [
    { kind: 'file', path: 'SKILL.md', contentBase64: body.toString('base64') },
    { kind: 'directory', path: 'empty-dir' },
    { kind: 'file', path: 'empty-file' },
    {
      kind: 'file',
      path: 'run.sh',
      executable: true,
      contentBase64: SCRIPT_BODY.toString('base64'),
    },
    { kind: 'file', path: 'supporting.bin', contentBase64: SUPPORTING_BODY.toString('base64') },
  ];
}

describe('exact retained Worker Skill delivery', () => {
  let coreDb: ReturnType<typeof openCoreDb>;
  let store: ReturnType<typeof createDemoStore>;
  let turn: ReturnType<typeof store.createTurn>;
  let first: ReturnType<typeof importWorkspaceSkill>;
  let environmentPackage: AgentEnvironmentPackage;
  const agentSetup = createTestAgentSetup({ skillIds: ['repo-guidelines'] });

  /** Resolves the current/pinned selection through the real AEP owner. */
  function resolvePackage(): AgentEnvironmentPackage {
    return AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSetup,
        agentSessionId: 'as_exact_skill',
        backend: { kind: 'openshell' },
        coreDb,
        createdAt: '2026-10-05T00:00:00.000Z',
        requestId: null,
        turn,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      })
    );
  }

  /** Publishes a newer exact version without changing the admitted package. */
  function advanceDefault() {
    const catalog = loadWorkspaceResourceCatalog(coreDb.dataRoot, turn.workspaceId);
    return importWorkspaceSkill({
      activate: true,
      baseDigest: first.version.digest,
      createdAt: '2026-10-06T00:00:00.000Z',
      dataRoot: coreDb.dataRoot,
      displayName: 'Repo guidelines',
      expectedRevision: catalog.revision,
      producer: { id: 'user_local', kind: 'user' },
      tree: skillTree(Buffer.concat([SKILL_BODY, Buffer.from('New instructions.\n')])),
      workspaceId: turn.workspaceId,
    });
  }

  /** Imports through the public native preparation boundary after reopening catalog authority. */
  function prepare(candidate = environmentPackage) {
    return prepareNanoHostContextPackageImports(candidate, {
      dataRoot: coreDb.dataRoot,
      workspaceRoots: [],
    });
  }

  beforeEach(() => {
    coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-exact-worker-skill-')));
    applyMigrations(coreDb);
    store = createDemoStore({ dataRoot: coreDb.dataRoot });
    turn = store.createTurn('ws_demo', 'th_demo', 'Use exact retained Skill', {
      kind: 'user',
      id: 'user_local',
    });
    first = importWorkspaceSkill({
      activate: true,
      createdAt: '2026-10-05T00:00:00.000Z',
      dataRoot: coreDb.dataRoot,
      displayName: 'Repo guidelines',
      expectedRevision: 0,
      producer: { id: 'user_local', kind: 'user' },
      tree: skillTree(),
      workspaceId: turn.workspaceId,
    });
    environmentPackage = resolvePackage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    coreDb.sqlite.close();
    rmSync(coreDb.dataRoot, { recursive: true, force: true });
  });

  it.each([
    'current',
    'pin',
  ] as const)('keeps admitted exact bytes and lineage after a newer %s selection', async (selection) => {
    if (selection === 'pin') {
      setWorkspaceSkillPin({
        dataRoot: coreDb.dataRoot,
        workspaceId: turn.workspaceId,
        entryId: 'repo-guidelines',
        digest: first.version.digest,
        expectedRevision: first.catalog.revision,
      });
      environmentPackage = resolvePackage();
    }
    const next = advanceDefault();
    if (selection === 'pin') {
      expect(resolvePackage().supply.skills[0]?.integrity?.sha256).toBe(first.version.digest);
      setWorkspaceSkillPin({
        dataRoot: coreDb.dataRoot,
        workspaceId: turn.workspaceId,
        entryId: 'repo-guidelines',
        digest: next.version.digest,
        expectedRevision: next.catalog.revision,
      });
    }
    expect(resolvePackage().supply.skills[0]?.integrity?.sha256).toBe(next.version.digest);
    const imports = await prepare();
    expect(imports.map((entry) => entry.slot)).toEqual([
      'package-config',
      'worker-supply',
      'worker-supply',
      'worker-supply',
      'worker-supply',
    ]);
    const expectedFiles = [
      ['empty-file', Buffer.alloc(0)],
      ['run.sh', SCRIPT_BODY],
      ['SKILL.md', SKILL_BODY],
      ['supporting.bin', SUPPORTING_BODY],
    ] as const;
    expect(imports.slice(1)).toEqual(
      expectedFiles.map(([path, body]) => ({
        body,
        byteLength: body.byteLength,
        contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        relativePath: `as_exact_skill/supply/inputs/repo-guidelines/${path}`,
        slot: 'worker-supply',
      }))
    );
    const importedPackage = JSON.parse(
      imports[0]!.body.toString('utf8')
    ) as AgentEnvironmentPackage;
    expect(importedPackage.supply.skills).toEqual(environmentPackage.supply.skills);
    expect(importedPackage.supply.skills[0]).toMatchObject({
      inventory: first.version.inventory,
      selectionSource: selection,
      lineage: { baseDigest: null, pluginMemberKey: null, pluginVersionDigest: null },
    });
    expect(importedPackage.supply.skills[0]?.inventory).toContainEqual({
      path: 'run.sh',
      kind: 'file',
      executable: true,
      size: SCRIPT_BODY.byteLength,
      sha256: `sha256:${createHash('sha256').update(SCRIPT_BODY).digest('hex')}`,
    });
    expect(importedPackage.supply.skills[0]?.inventory).toContainEqual({
      path: 'empty-dir',
      kind: 'directory',
      executable: false,
      size: 0,
      sha256: null,
    });
  });

  it.each([
    'supporting bytes',
    'missing supporting file',
    'executable mode',
    'empty directory',
    'extra file',
    'missing snapshot',
  ] as const)('refuses %s tamper at AEP resolution and native import', async (tamper) => {
    const snapshot = skillSnapshotPath(
      coreDb.dataRoot,
      turn.workspaceId,
      'repo-guidelines',
      first.version.digest
    );
    chmodSync(snapshot, 0o755);
    if (tamper === 'supporting bytes') {
      chmodSync(join(snapshot, 'supporting.bin'), 0o644);
      writeFileSync(join(snapshot, 'supporting.bin'), 'changed');
    } else if (tamper === 'missing supporting file') rmSync(join(snapshot, 'supporting.bin'));
    else if (tamper === 'executable mode') chmodSync(join(snapshot, 'run.sh'), 0o444);
    else if (tamper === 'empty directory') rmSync(join(snapshot, 'empty-dir'), { recursive: true });
    else if (tamper === 'extra file') writeFileSync(join(snapshot, 'extra'), 'undeclared');
    else rmSync(snapshot, { recursive: true });
    const failure =
      tamper === 'missing snapshot' ? CatalogContentUnavailableError : CatalogIntegrityError;
    expect(() => resolvePackage()).toThrow(failure);
    await expect(prepare()).rejects.toBeInstanceOf(failure);
  });

  it.each([
    'omitted file',
    'mode',
    'directory',
    'digest',
    'provenance',
    'version',
    'source',
    'entry',
  ] as const)('refuses changed admitted %s claims against exact retained authority', async (claim) => {
    const candidate = structuredClone(environmentPackage);
    const skill = candidate.supply.skills[0]!;
    if (claim === 'omitted file')
      skill.inventory = skill.inventory!.filter((row) => row.path !== 'supporting.bin');
    else if (claim === 'mode')
      skill.inventory!.find((row) => row.path === 'run.sh')!.executable = false;
    else if (claim === 'directory')
      skill.inventory = skill.inventory!.filter((row) => row.path !== 'empty-dir');
    else if (claim === 'digest') skill.integrity = { sha256: `sha256:${'0'.repeat(64)}` };
    else if (claim === 'provenance') skill.lineage!.baseDigest = `sha256:${'0'.repeat(64)}`;
    else if (claim === 'version') skill.version = 'invented-version';
    else if (claim === 'source') skill.sourceRef = 'invented-source';
    else skill.id = 'unavailable-entry';
    await expect(prepare(candidate)).rejects.toThrow();
  });

  it('refuses removed entries while exact bytes remain retained', async () => {
    removeWorkspaceSkill({
      dataRoot: coreDb.dataRoot,
      workspaceId: turn.workspaceId,
      entryId: 'repo-guidelines',
      expectedRevision: first.catalog.revision,
    });
    expect(() => resolvePackage()).toThrow();
    await expect(prepare()).rejects.toThrow(CatalogNotFoundError);
  });

  it.each([
    ['aep', 'removed', CatalogNotFoundError],
    ['aep', 'purged', CatalogContentUnavailableError],
    ['aep', 'missing version', CatalogNotFoundError],
    ['aep', 'inventory', CatalogIntegrityError],
    ['native', 'removed', CatalogNotFoundError],
    ['native', 'purged', CatalogContentUnavailableError],
    ['native', 'missing version', CatalogNotFoundError],
    ['native', 'inventory', CatalogIntegrityError],
  ] as const)('discards %s bytes when %s changes during the actual read', async (boundary, change, failure) => {
    const source = join(
      skillSnapshotPath(coreDb.dataRoot, turn.workspaceId, 'repo-guidelines', first.version.digest),
      'SKILL.md'
    );
    let changed = false;
    const mutate = (path: unknown) => {
      if (String(path) !== source || changed) return;
      changed = true;
      const catalog = loadWorkspaceResourceCatalog(coreDb.dataRoot, turn.workspaceId);
      if (change === 'removed') catalog.skills.entries[0]!.availability = 'removed';
      else if (change === 'purged') catalog.skills.versions[0]!.contentState = 'purged';
      else if (change === 'missing version') catalog.skills.versions = [];
      else catalog.skills.versions[0]!.inventory[0]!.executable = true;
      publishWorkspaceResourceCatalog({
        dataRoot: coreDb.dataRoot,
        workspaceId: turn.workspaceId,
        expectedRevision: catalog.revision,
        catalog,
      });
    };
    const originalSyncRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
      const bytes = originalSyncRead(path, options);
      mutate(path);
      return bytes;
    });
    const originalRead = fsPromises.readFile;
    vi.spyOn(fsPromises, 'readFile').mockImplementation(async (path, options) => {
      const bytes = await originalRead(path, options);
      mutate(path);
      return bytes;
    });
    syncBuiltinESMExports();
    if (boundary === 'aep') expect(() => resolvePackage()).toThrow(failure);
    else await expect(prepare()).rejects.toThrow(failure);
    expect(changed).toBe(true);
  });

  it('refuses a missing retained version without choosing the newer default', async () => {
    const next = advanceDefault();
    publishWorkspaceResourceCatalog({
      dataRoot: coreDb.dataRoot,
      workspaceId: turn.workspaceId,
      expectedRevision: next.catalog.revision,
      catalog: {
        ...next.catalog,
        skills: {
          ...next.catalog.skills,
          versions: next.catalog.skills.versions.filter(
            (version) => version.digest !== first.version.digest
          ),
        },
      },
    });
    await expect(prepare()).rejects.toThrow(CatalogNotFoundError);
  });

  it('refuses current selection when its retained version metadata is missing', () => {
    publishWorkspaceResourceCatalog({
      dataRoot: coreDb.dataRoot,
      workspaceId: turn.workspaceId,
      expectedRevision: first.catalog.revision,
      catalog: { ...first.catalog, skills: { ...first.catalog.skills, versions: [] } },
    });
    expect(() => resolvePackage()).toThrow(CatalogNotFoundError);
  });

  it('refuses purged content even if its exact residual bytes reappear', async () => {
    const next = advanceDefault();
    const purged = purgeWorkspaceSkillVersion({
      dataRoot: coreDb.dataRoot,
      workspaceId: turn.workspaceId,
      entryId: 'repo-guidelines',
      digest: first.version.digest,
      expectedRevision: next.catalog.revision,
      retainedReferences: [],
    });
    // An exact re-admission restores payload bytes; restore the prior purge disposition to model residual storage.
    importWorkspaceSkill({
      activate: false,
      createdAt: '2026-10-07T00:00:00.000Z',
      dataRoot: coreDb.dataRoot,
      displayName: 'Repo guidelines',
      expectedRevision: purged.revision,
      producer: { id: 'user_local', kind: 'user' },
      tree: skillTree(),
      workspaceId: turn.workspaceId,
    });
    const restored = loadWorkspaceResourceCatalog(coreDb.dataRoot, turn.workspaceId);
    publishWorkspaceResourceCatalog({
      dataRoot: coreDb.dataRoot,
      workspaceId: turn.workspaceId,
      expectedRevision: restored.revision,
      catalog: {
        ...restored,
        skills: {
          ...restored.skills,
          versions: restored.skills.versions.map((version) =>
            version.digest === first.version.digest
              ? { ...version, contentState: 'purged' }
              : version
          ),
          pins: [{ entryId: 'repo-guidelines', digest: first.version.digest }],
        },
      },
    });
    expect(() => resolvePackage()).toThrow(CatalogContentUnavailableError);
    await expect(prepare()).rejects.toThrow(CatalogContentUnavailableError);
  });

  it('refuses corrupt launch before any Sandbox backend call', async () => {
    admitTestNativeEnvironment(coreDb, agentSetup.manifest);
    const snapshot = skillSnapshotPath(
      coreDb.dataRoot,
      turn.workspaceId,
      'repo-guidelines',
      first.version.digest
    );
    chmodSync(snapshot, 0o755);
    rmSync(join(snapshot, 'supporting.bin'));
    const backendCall = vi.fn(() => {
      throw new Error('Unexpected Sandbox effect');
    });
    const backend: WorkerGovernanceBackend = {
      id: 'nanohost',
      submit: backendCall,
      inspect: backendCall,
      cancel: backendCall,
      release: backendCall,
      describeCapabilities: backendCall,
      validatePackage: backendCall,
      planSession: backendCall,
      prepareAgentSessionContinuity: backendCall,
      cleanupSession: backendCall,
      materialize: backendCall,
      prepareLaunch: backendCall,
      update: backendCall,
      collectEvidence: backendCall,
      collectProviderRefreshStatuses: backendCall,
      collectTranscript: backendCall,
      collectWorkspaceChanges: backendCall,
    };
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
    await expect(
      executor.prepareAgentSessionForTurn(store, {
        agentSetup,
        freshAgentSessionId: 'as_exact_skill_launch',
        requestId: null,
        turn,
        turnInput: 'Use exact retained Skill',
        workspaceCwd: null,
        workspaceRoots: [],
      })
    ).rejects.toThrow(CatalogIntegrityError);
    expect(backendCall).not.toHaveBeenCalled();
    expect(store.listThreadAgentSessions(turn.workspaceId, turn.threadId)).toEqual([]);
  });
});

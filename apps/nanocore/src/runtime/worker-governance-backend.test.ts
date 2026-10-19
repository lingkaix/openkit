// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  planSessionWorkspaceMaterialization,
} from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import {
  importWorkspaceSkill,
  removeWorkspaceSkill,
  setWorkspaceSkillPin,
} from '../catalog/resource-catalog.js';
import { buildWorkerContextPackageWorkspaceInput } from '../context/worker-context-package.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore, createDemoWorkspaceForUser } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import {
  openShellNetworkEndpointsFromPackagePolicy,
  prepareNanoHostContextPackageImports,
  resolveNanoHostExportPath,
  WorkerSandboxPolicyIntentSchema,
} from './worker-governance-backend.js';

describe('NanoHost worker governance helpers', () => {
  it('exports a generated output under the exact AgentSession namespace and refuses undeclared paths', () => {
    const environmentPackage = createNanoHostPackage();
    const agentSessionId = environmentPackage.scope.agentSessionId;
    const path = `/openkit/sessions/${agentSessionId}/outputs/report.md`;
    expect(resolveNanoHostExportPath(environmentPackage, path)).toEqual({
      slot: 'turn-output',
      relativePath: `${agentSessionId}/outputs/report.md`,
    });
    for (const candidate of [
      '/workspace/outputs/report.md',
      '/openkit/sessions/as_00000000-0000-7340-a2c1-1f85dfa9bafb/outputs/report.md',
    ]) {
      expect(() => resolveNanoHostExportPath(environmentPackage, candidate)).toThrow(
        'outside every declared output slot'
      );
    }
  });

  it('prefixes a main-worktree export with the exact AEP-bound work slot', () => {
    const environmentPackage = createNanoHostPackage();
    const mainWorktree = (
      environmentPackage.extensions.openkit as {
        sessionWorkspace: { layout: { slots: Array<{ id: string; path: string }> } };
      }
    ).sessionWorkspace.layout.slots.find((slot) => slot.id === 'main-worktree');
    if (!mainWorktree) {
      throw new Error('Expected the main worktree slot.');
    }
    const withOutput = AgentEnvironmentPackageSchema.parse({
      ...environmentPackage,
      workspace: {
        ...environmentPackage.workspace,
        outputs: [
          {
            id: 'repo-output',
            path: mainWorktree.path,
            registerAsArtifacts: true,
            retention: 'sync-on-turn-end',
          },
        ],
      },
    });
    const workSlotRef = (
      withOutput.extensions.openkit as { workerStorage: { workSlotRef: string } }
    ).workerStorage.workSlotRef;

    expect(
      resolveNanoHostExportPath(withOutput, `${mainWorktree.path}/reports/result.json`)
    ).toEqual({
      relativePath: `${workSlotRef}/reports/result.json`,
      slot: 'main-worktree',
    });
    expect(() =>
      resolveNanoHostExportPath(
        AgentEnvironmentPackageSchema.parse({
          ...withOutput,
          extensions: {
            ...withOutput.extensions,
            openkit: {
              ...(withOutput.extensions.openkit as Record<string, unknown>),
              workerStorage: { workSlotRef: 'wsl_different' },
            },
          },
        }),
        `${mainWorktree.path}/reports/result.json`
      )
    ).toThrow('no exact admitted Worker storage slot');
    expect(() =>
      resolveNanoHostExportPath(
        AgentEnvironmentPackageSchema.parse({
          ...withOutput,
          workspace: { ...withOutput.workspace, root: '/workspace/altered' },
        }),
        `${mainWorktree.path}/reports/result.json`
      )
    ).toThrow('no exact admitted Worker storage slot');
  });

  it('canonicalizes one strict AEP as the first immutable NanoHost import', async () => {
    const environmentPackage = createNanoHostPackage();
    const reordered = AgentEnvironmentPackageSchema.parse(
      sortJsonObjectKeys(environmentPackage, true)
    );
    const expectedBytes = Buffer.from(JSON.stringify(sortJsonObjectKeys(environmentPackage)));
    const expectedDigest = `sha256:${createHash('sha256').update(expectedBytes).digest('hex')}`;

    for (const candidate of [environmentPackage, reordered]) {
      const imports = await prepareNanoHostContextPackageImports(candidate, { workspaceRoots: [] });

      expect(imports[0]).toMatchObject({
        body: expectedBytes,
        byteLength: expectedBytes.byteLength,
        contentDigest: expectedDigest,
        relativePath: `${environmentPackage.scope.agentSessionId}/config/package.json`,
        slot: 'package-config',
      });
      if (!imports[0]?.body)
        throw new Error('Canonical package config must have bounded inline bytes.');
      expect(imports[0].body[0]).not.toBe(0xef);
      expect(imports[0]?.body.at(-1)).not.toBe(0x0a);
      expect(JSON.parse(imports[0]?.body.toString('utf8') ?? '')).toEqual(environmentPackage);
    }

    // Contract Evolution ignores inert additions before publishing worker-consumed bytes.
    const additiveImports = await prepareNanoHostContextPackageImports(
      {
        ...environmentPackage,
        rawSecret: 'must-not-enter-package-bytes',
      } as AgentEnvironmentPackage,
      { workspaceRoots: [] }
    );
    expect(additiveImports[0]?.body).toEqual(expectedBytes);

    const cyclic = structuredClone(environmentPackage) as AgentEnvironmentPackage & {
      self?: unknown;
    };
    cyclic.self = cyclic;
    const nonPlain = Object.assign(Object.create(null), environmentPackage);
    for (const invalid of [
      { ...environmentPackage, nonJson: 1n },
      { ...environmentPackage, resources: { cpu: Number.NaN } },
      cyclic,
      nonPlain,
      {
        ...environmentPackage,
        runtime: {
          ...environmentPackage.runtime,
          runtimeEnvironment: { TOKEN: 'must-not-enter-package-bytes' },
        },
      },
    ]) {
      await expect(
        prepareNanoHostContextPackageImports(invalid as AgentEnvironmentPackage, {
          workspaceRoots: [],
        })
      ).rejects.toThrow();
    }
  });

  it.each([
    'available',
    'pinned-audit',
    'removed-during-context-read',
  ] as const)('imports only currently eligible verified Skill files after the canonical AEP: %s', async (selection) => {
    const skillBody =
      '---\nname: repo-guidelines\ndescription: Repository guidance.\n---\n# Hello\n';
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-supply-import-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      const userId = ensureLocalUser(coreDb);
      const store = createDemoStore({ dataRoot }, userId);
      const { workspace, thread } = createDemoWorkspaceForUser(userId);
      const agentSessionId = allocateEntityId('as');
      const turn = store.createTurn(workspace.id, thread.id, 'Use catalog skill', {
        kind: 'user',
        id: userId,
      });
      const created = importWorkspaceSkill({
        activate: true,
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        displayName: 'Repo guidelines',
        expectedRevision: 0,
        producer: { id: userId, kind: 'user' },
        tree: [
          {
            contentBase64: Buffer.from(skillBody, 'utf8').toString('base64'),
            kind: 'file',
            path: 'SKILL.md',
          },
        ],
        workspaceId: turn.workspaceId,
      });
      const pinAuditRef = allocateEntityId('aud');
      if (selection === 'pinned-audit') {
        setWorkspaceSkillPin({
          dataRoot,
          digest: created.version.digest,
          entryId: 'repo-guidelines',
          expectedRevision: created.catalog.revision,
          pinAuditRef,
          workspaceId: turn.workspaceId,
        });
      }
      const environmentPackage = AgentEnvironmentPackageSchema.parse(
        resolveAgentEnvironmentPackage({
          captureCoverage: { scope: 'server', value: 'off' },
          agentSetup: createTestAgentSetup({ skillIds: ['repo-guidelines'] }),
          agentSessionId,
          backend: { kind: 'openshell' },
          coreDb,
          createdAt: '2026-06-16T00:00:00.000Z',
          requestId: 'req_nanohost_skill_1',
          turn,
          triggerActor: turn.triggerActor,
          userId,
          workspaceCwd: process.cwd(),
          workspaceRoots: [],
        })
      );
      const workspaceRoots: Parameters<
        typeof prepareNanoHostContextPackageImports
      >[1]['workspaceRoots'] = [];
      if (selection === 'removed-during-context-read') {
        const inputId = `context_${turn.id}`;
        const pathRef = `threads/${turn.threadId}/turns/${turn.id}/context-package`;
        const sourcePath = join(dataRoot, 'workspaces', turn.workspaceId, ...pathRef.split('/'));
        mkdirSync(sourcePath, { recursive: true });
        environmentPackage.workspace.inputs.push({
          access: 'read-only',
          id: inputId,
          kind: 'generated',
          materialization: {
            slotId: 'context',
            strategy: 'filesystem',
            contentDigest: `sha256:${createHash('sha256').update('[]').digest('hex')}`,
          },
          source: { kind: 'generated', pathRef },
          target: `/openkit/sessions/${agentSessionId}/context`,
        });
        (environmentPackage.extensions.openkit as Record<string, unknown>).sessionWorkspace =
          planSessionWorkspaceMaterialization({ environmentPackage });
        workspaceRoots.push({
          id: inputId,
          access: 'read-only',
          sourceKind: 'materialized-dir',
          sourcePath,
          workerPath: `/openkit/sessions/${agentSessionId}/context`,
        });
        const readDirectory = fsPromises.readdir;
        let removed = false;
        vi.spyOn(fsPromises, 'readdir').mockImplementation(async (...args) => {
          const result = await readDirectory(...args);
          if (String(args[0]) === sourcePath && !removed) {
            removed = true;
            removeWorkspaceSkill({
              dataRoot,
              workspaceId: turn.workspaceId,
              entryId: 'repo-guidelines',
              expectedRevision: created.catalog.revision,
            });
          }
          return result;
        });
        syncBuiltinESMExports();
        await expect(
          prepareNanoHostContextPackageImports(environmentPackage, { dataRoot, workspaceRoots })
        ).rejects.toThrow(/catalog entry not found/i);
        expect(removed).toBe(true);
        return;
      }
      const imports = await prepareNanoHostContextPackageImports(environmentPackage, {
        dataRoot,
        workspaceRoots,
      });
      expect(imports.map((item) => item.slot)).toEqual(['package-config', 'worker-supply']);
      expect(imports[1]).toMatchObject({
        body: Buffer.from(skillBody, 'utf8'),
        byteLength: Buffer.byteLength(skillBody),
        relativePath: `${agentSessionId}/supply/inputs/repo-guidelines/SKILL.md`,
        slot: 'worker-supply',
      });
      expect(imports[1]?.contentDigest).toBe(
        created.version.inventory.find((entry) => entry.path === 'SKILL.md')?.sha256
      );
      if (selection === 'pinned-audit') {
        const skill = environmentPackage.supply.skills[0];
        expect(skill?.lineage?.pinAuditRef).toBe(pinAuditRef);
        if (!skill?.lineage) throw new Error('Expected the pinned Skill lineage.');
        skill.lineage.baseDigest = `sha256:${'f'.repeat(64)}`;
        await expect(
          prepareNanoHostContextPackageImports(environmentPackage, { dataRoot, workspaceRoots })
        ).rejects.toThrow('Worker Skill supply does not match its retained catalog version');
      }
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});

/** Creates one canonical NanoHost AEP from the shared authored-manifest fixture. */
function createNanoHostPackage(): AgentEnvironmentPackage {
  const store = createDemoStore();
  const turn = store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Materialize NanoHost backend',
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );

  return AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: createTestAgentSetup({
        imageRef: 'ghcr.io/openkit/codex-worker:test',
      }),
      agentSessionId: 'as_00000000-0000-79c6-aae9-aedf5075fd1f',
      triggerActor: turn.triggerActor,
      userId: 'usr_00000000-0000-7000-8000-000000000001',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-06-16T00:00:00.000Z',
      requestId: 'req_nanohost_1',
      turn,
      workspaceCwd: process.cwd(),
      workspaceRoots: [],
    })
  );
}

/** Recursively orders one JSON fixture with the ECMAScript UTF-16 key comparator. */
function sortJsonObjectKeys(value: unknown, descending = false): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonObjectKeys(entry, descending));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const keys = Object.keys(value).sort();
  if (descending) {
    keys.reverse();
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      sortJsonObjectKeys((value as Record<string, unknown>)[key], descending),
    ])
  );
}

describe('public exact grant materialization', () => {
  it('projects only the existing enforceable tuple and no public request inspector', () => {
    const environmentPackage = createNanoHostPackage();
    const rule = {
      action: 'allow',
      id: 'public-search',
      host: 'search.example.com',
      port: 443,
      protocol: 'rest',
      purpose: 'Public search',
      scope: 'session',
      binaries: ['/usr/local/bin/node'],
      rules: [{ method: 'POST', path: '/mcp' }],
      publicAccess: { kind: 'credential-free-non-llm' },
    };
    const marked = AgentEnvironmentPackageSchema.parse({
      ...environmentPackage,
      policy: {
        ...environmentPackage.policy,
        network: { default: 'deny', enforcement: 'openshell', rules: [rule] },
      },
    });
    const endpoints = openShellNetworkEndpointsFromPackagePolicy(marked);
    expect(endpoints).toEqual([
      {
        name: 'public_search',
        host: rule.host,
        port: rule.port,
        protocol: 'rest',
        binaries: rule.binaries,
        rules: rule.rules,
      },
    ]);
    expect(marked.credentials.declarations).toEqual([]);
  });
});

it('exports only the exact admitted Turn capture, even with a changed transcript declaration', () => {
  const pkg = createNanoHostPackage();
  const { threadId, turnId } = pkg.scope;
  const runtime = pkg.control.adapter.targetRuntime;
  const root = `/openkit/threads/${threadId}/${runtime}/capture/${turnId}`;
  expect(resolveNanoHostExportPath(pkg, `${root}/events.jsonl`)).toEqual({
    slot: 'session',
    relativePath: `${threadId}/${runtime}/capture/${turnId}/events.jsonl`,
  });
  for (const foreign of [
    `/openkit/threads/sibling/${runtime}/capture/${turnId}`,
    `/openkit/threads/${threadId}/pi/capture/${turnId}`,
    `/openkit/threads/${threadId}/${runtime}/capture/other-turn`,
    `/openkit/threads/${threadId}/${runtime}/native`,
  ]) {
    const changed = structuredClone(pkg);
    changed.control.transcript.root = foreign;
    expect(() => resolveNanoHostExportPath(changed, `${foreign}/events.jsonl`)).toThrow();
  }
});

it.each([
  true,
  false,
])('includes recorded effort controls in canonical immutable package bytes: %s', async (recorded) => {
  const retained = createNanoHostPackage();
  const candidate = AgentEnvironmentPackageSchema.parse({
    ...retained,
    llm: {
      ...retained.llm,
      ...(recorded ? { reasoningEffort: 'none' } : {}),
      routes: retained.llm.routes.map((route) => ({
        ...route,
        ...(recorded ? { reasoningEffortLevels: [] } : {}),
      })),
    },
  });
  const [imported] = await prepareNanoHostContextPackageImports(candidate, { workspaceRoots: [] });
  const expectedBytes = Buffer.from(JSON.stringify(sortJsonObjectKeys(candidate)));
  expect(imported?.body).toEqual(expectedBytes);
  expect(imported?.contentDigest).toBe(
    `sha256:${createHash('sha256').update(expectedBytes).digest('hex')}`
  );
  if (imported?.entryKind !== 'file' || !imported.body)
    throw new Error('Expected bounded canonical package-config file bytes.');
  const parsed = AgentEnvironmentPackageSchema.parse(JSON.parse(imported.body.toString('utf8')));
  if (recorded) {
    expect(parsed.llm).toHaveProperty('reasoningEffort', 'none');
    expect(parsed.llm.routes[0]).toHaveProperty('reasoningEffortLevels', []);
    const [oldImport] = await prepareNanoHostContextPackageImports(retained, {
      workspaceRoots: [],
    });
    expect(imported?.contentDigest).not.toBe(oldImport?.contentDigest);
  } else {
    expect(parsed.llm).not.toHaveProperty('reasoningEffort');
    expect(parsed.llm.routes[0]).not.toHaveProperty('reasoningEffortLevels');
  }
  candidate.llm.reasoningEffort = 'max';
  expect(imported?.body).toEqual(expectedBytes);
});

describe('encoded-slash Core policy intent', () => {
  const endpoint = {
    name: 'package_read',
    host: 'packages.example.com',
    port: 443,
    protocol: 'rest',
    access: 'read-only',
    binaries: ['/usr/local/bin/node'],
  };
  const parse = (additionalNetworkEndpoints: unknown[]) =>
    WorkerSandboxPolicyIntentSchema.safeParse({
      additionalFilesystemGrants: [],
      additionalNetworkEndpoints,
    });
  it.each([
    undefined,
    false,
    true,
  ])('preserves package authority %s at the intent boundary', (allowEncodedSlash) => {
    const pkg = createNanoHostPackage();
    pkg.policy.network!.rules = [
      {
        action: 'allow',
        id: 'package-read',
        ...endpoint,
        ...(allowEncodedSlash === undefined ? {} : { allowEncodedSlash }),
      },
    ];
    const endpoints = openShellNetworkEndpointsFromPackagePolicy(pkg);
    expect(endpoints).toEqual([
      { ...endpoint, ...(allowEncodedSlash === undefined ? {} : { allowEncodedSlash }) },
    ]);
    expect(parse(endpoints).success).toBe(true);
  });
  it('rejects malformed, forbidden and unsupported authority rather than dropping it', () => {
    for (const change of [
      { allowEncodedSlash: 'true' },
      { allowEncodedSlash: null },
      { allowEncodedSlash: true, access: 'read-write' },
      { allowEncodedSlash: false, rules: [] },
      { allowEncodedSlash: true, protocol: 'http' },
      { futureAuthority: true },
    ]) {
      expect(parse([{ ...endpoint, ...change }]).success).toBe(false);
      const pkg = createNanoHostPackage();
      pkg.policy.network!.rules = [{ action: 'allow', id: 'package-read', ...endpoint, ...change }];
      if ('allowEncodedSlash' in change)
        expect(() => openShellNetworkEndpointsFromPackagePolicy(pkg)).toThrow();
    }
  });
  it('refuses encoded-slash authority on a rule that would otherwise be silently omitted', () => {
    for (const change of [
      { id: 'openkit-worker-control' },
      { id: 'openkit-worker-inference' },
      { binaries: [] },
      { action: 'deny' },
      { port: undefined },
    ]) {
      const pkg = createNanoHostPackage();
      pkg.policy.network!.rules = [
        { action: 'allow', id: 'package-read', ...endpoint, allowEncodedSlash: true, ...change },
      ];
      expect(() => openShellNetworkEndpointsFromPackagePolicy(pkg)).toThrow(
        'cannot project encoded-slash authority'
      );
    }
  });
  it('refuses conflicting destination settings in either order and accepts matching settings', () => {
    const allowed = { ...endpoint, allowEncodedSlash: true };
    for (const strict of [
      { ...endpoint, name: 'strict', host: 'PACKAGES.EXAMPLE.COM.' },
      { ...endpoint, name: 'strict', allowEncodedSlash: false },
      {
        ...endpoint,
        name: 'strict',
        access: undefined,
        rules: [{ method: 'GET', path: '/allowed' }],
      },
    ]) {
      expect(parse([allowed, strict]).success).toBe(false);
      expect(parse([strict, allowed]).success).toBe(false);
    }
    expect(parse([allowed, { ...allowed, name: 'same' }]).success).toBe(true);
    expect(
      parse([endpoint, { ...endpoint, name: 'strict', allowEncodedSlash: false }]).success
    ).toBe(true);
    expect(parse([allowed, { ...endpoint, name: 'other_port', port: 8443 }]).success).toBe(true);
  });
});

it('prepares a large Context Package original as a verified bounded source and rejects later replacement or links', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'context-source-import-'));
  try {
    const base = createNanoHostPackage();
    const { workspaceId, threadId, turnId, agentSessionId } = base.scope;
    const root = join(
      dataRoot,
      'workspaces',
      workspaceId,
      'threads',
      threadId,
      'turns',
      turnId,
      'context-package'
    );
    mkdirSync(root, { recursive: true });
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 17, 120);
    const path = join(root, 'original.bin');
    writeFileSync(path, bytes);
    const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const inventory = [{ byteLength: bytes.length, contentDigest, path: 'original.bin' }];
    const rootDigest = `sha256:${createHash('sha256').update(JSON.stringify(inventory)).digest('hex')}`;
    const workspaceInput = buildWorkerContextPackageWorkspaceInput({
      threadId,
      turnId,
      agentSessionId,
      packageRootDigest: rootDigest,
    });
    const withInput = AgentEnvironmentPackageSchema.parse({
      ...base,
      workspace: { ...base.workspace, inputs: [...base.workspace.inputs, workspaceInput] },
    });
    const openkit = withInput.extensions.openkit as Record<string, unknown> & {
      workerStorage: { workSlotRef: string };
    };
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...withInput,
      extensions: {
        ...withInput.extensions,
        openkit: {
          ...openkit,
          sessionWorkspace: planSessionWorkspaceMaterialization({
            environmentPackage: withInput,
            workSlotRef: openkit.workerStorage.workSlotRef,
          }),
        },
      },
    });
    const context = {
      workspaceRoots: [
        {
          id: workspaceInput.id,
          access: 'read-only' as const,
          sourceKind: 'materialized-dir' as const,
          sourcePath: root,
          workerPath: workspaceInput.target,
        },
      ],
    };
    const imports = await prepareNanoHostContextPackageImports(environmentPackage, context);
    const original = imports.find((entry) => entry.slot === 'context');
    expect(original).toMatchObject({ byteLength: bytes.length, contentDigest });
    expect(original).not.toHaveProperty('body');
    if (!original?.source) throw new Error('Expected a bounded original source.');
    const measured = createHash('sha256');
    let size = 0;
    for await (const chunk of original.source.open(new AbortController().signal)) {
      expect(chunk.byteLength).toBeLessThanOrEqual(65_536);
      size += chunk.byteLength;
      measured.update(chunk);
    }
    expect(size).toBe(bytes.length);
    expect(`sha256:${measured.digest('hex')}`).toBe(contentDigest);
    rmSync(path);
    writeFileSync(path, bytes);
    await expect(
      (async () => {
        for await (const _chunk of original.source!.open(new AbortController().signal)) {
          /* Exact accepted source only. */
        }
      })()
    ).rejects.toThrow(/unavailable/);
    rmSync(path);
    symlinkSync(join(dataRoot, 'outside'), path);
    await expect(prepareNanoHostContextPackageImports(environmentPackage, context)).rejects.toThrow(
      /unavailable/
    );
    rmSync(path);
    writeFileSync(path, bytes);
    linkSync(path, join(dataRoot, 'linked-original'));
    await expect(prepareNanoHostContextPackageImports(environmentPackage, context)).rejects.toThrow(
      /unavailable/
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

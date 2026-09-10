import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { importWorkspaceSkill } from '../catalog/resource-catalog.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  prepareNanoHostContextPackageImports,
  resolveNanoHostExportPath,
} from './worker-governance-backend.js';

describe('NanoHost worker governance helpers', () => {
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
      expect(imports[0]?.body[0]).not.toBe(0xef);
      expect(imports[0]?.body.at(-1)).not.toBe(0x0a);
      expect(JSON.parse(imports[0]?.body.toString('utf8') ?? '')).toEqual(environmentPackage);
    }

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
      { ...environmentPackage, rawSecret: 'must-not-enter-package-bytes' },
    ]) {
      await expect(
        prepareNanoHostContextPackageImports(invalid as AgentEnvironmentPackage, {
          workspaceRoots: [],
        })
      ).rejects.toThrow();
    }
  });

  it('imports verified Skill files after the canonical AEP', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-supply-import-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      const store = createDemoStore();
      const turn = store.createTurn('ws_demo', 'th_demo', 'Use catalog skill', {
        kind: 'user',
        id: 'user_local',
      });
      const created = importWorkspaceSkill({
        activate: true,
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        displayName: 'Repo guidelines',
        expectedRevision: 0,
        producer: { id: 'user_local', kind: 'user' },
        tree: [
          {
            contentBase64: Buffer.from('# Hello\n', 'utf8').toString('base64'),
            kind: 'file',
            path: 'SKILL.md',
          },
        ],
        workspaceId: turn.workspaceId,
      });
      const environmentPackage = AgentEnvironmentPackageSchema.parse(
        resolveAgentEnvironmentPackage({
          agentSetup: createTestAgentSetup({ skillIds: ['repo-guidelines'] }),
          agentSessionId: 'as_nanohost_1',
          backend: { kind: 'openshell' },
          coreDb,
          createdAt: '2026-06-16T00:00:00.000Z',
          requestId: 'req_nanohost_skill_1',
          turn,
          triggerActor: turn.triggerActor,
          userId: 'user_local',
          workspaceCwd: process.cwd(),
          workspaceRoots: [],
        })
      );
      const imports = await prepareNanoHostContextPackageImports(environmentPackage, {
        dataRoot,
        workspaceRoots: [],
      });
      expect(imports.map((item) => item.slot)).toEqual(['package-config', 'worker-supply']);
      expect(imports[1]).toMatchObject({
        byteLength: Buffer.byteLength('# Hello\n'),
        relativePath: 'as_nanohost_1/supply/inputs/repo-guidelines/SKILL.md',
        slot: 'worker-supply',
      });
      expect(imports[1]?.contentDigest).toBe(
        created.version.inventory.find((entry) => entry.path === 'SKILL.md')?.sha256
      );
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});

/** Creates one canonical NanoHost AEP from the shared authored-manifest fixture. */
function createNanoHostPackage(): AgentEnvironmentPackage {
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Materialize NanoHost backend', {
    kind: 'user',
    id: 'user_local',
  });

  return AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup({
        imageRef: 'ghcr.io/openkit/codex-worker:test',
      }),
      agentSessionId: 'as_nanohost_1',
      triggerActor: turn.triggerActor,
      userId: 'user_local',
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

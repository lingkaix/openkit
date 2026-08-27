import { createHash } from 'node:crypto';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { prepareNanoHostContextPackageImports } from './worker-governance-backend.js';

describe('NanoHost worker governance helpers', () => {
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
        relativePath: 'package.json',
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

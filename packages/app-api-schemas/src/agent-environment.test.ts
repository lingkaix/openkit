import { describe, expect, it } from 'vitest';
import {
  AgentEnvironmentPackageSnapshotRecordSchema,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
} from './agent-environment.js';

const environment = {
  imageDigest: `sha256:${'a'.repeat(64)}`,
  defaultsDigest: `sha256:${'b'.repeat(64)}`,
  values: { token: 'ghp_public-literal', PATH: '/Users/public/tools' },
};
const record = {
  snapshotId: 'snapshot',
  workspaceId: 'workspace',
  turnId: 'turn',
  threadId: 'thread',
  agentSessionId: 'session',
  agentId: 'agent',
  packageId: 'package',
  runtimeKind: 'pi',
  backendKind: 'openshell',
  contentDigest: 'digest',
  createdAt: '2026-10-01T00:00:00.000Z',
  snapshot: { runtime: { environment } },
};
describe('public native settings in AEP snapshots', () => {
  it('preserves validated public literal values through record and list responses', () => {
    expect(
      AgentEnvironmentPackageSnapshotRecordSchema.parse(record).snapshot.runtime.environment
    ).toEqual(environment);
    expect(
      ListAgentEnvironmentPackageSnapshotsResponseSchema.parse({ items: [record] }).items[0]!
        .snapshot.runtime.environment
    ).toEqual(environment);
  });
  it('retains native-environment validation', () => {
    expect(
      AgentEnvironmentPackageSnapshotRecordSchema.safeParse({
        ...record,
        snapshot: { runtime: { environment: { ...environment, values: { BAD: null } } } },
      }).success
    ).toBe(false);
  });
});

it('preserves matching ordinary strings everywhere in AEP record and list envelopes', () => {
  const ordinary = {
    ...record,
    agentId: 'ghp_public-fixture-agent',
    snapshot: {
      runtime: { environment },
      extensions: {
        fixture: { note: 'ghp_public-test-fixture', nested: ['sk-public-test-fixture'] },
      },
      note: 'okt_public-test-fixture',
    },
  };
  expect(AgentEnvironmentPackageSnapshotRecordSchema.parse(ordinary)).toEqual(ordinary);
  expect(
    ListAgentEnvironmentPackageSnapshotsResponseSchema.parse({ items: [ordinary] }).items
  ).toEqual([ordinary]);
});

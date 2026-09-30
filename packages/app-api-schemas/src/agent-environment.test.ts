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
  it('retains credential rejection outside the validated public namespace', () => {
    expect(
      AgentEnvironmentPackageSnapshotRecordSchema.safeParse({
        ...record,
        snapshot: { runtime: { environment }, token: 'ghp_private-shaped' },
      }).success
    ).toBe(false);
    expect(
      AgentEnvironmentPackageSnapshotRecordSchema.safeParse({
        ...record,
        snapshot: { runtime: { environment: { ...environment, values: { BAD: null } } } },
      }).success
    ).toBe(false);
  });
});

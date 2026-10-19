import { WORKSPACE_RESOURCE_POLICY_FEATURE } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { remintResourcePolicyConfig } from './resource-policy-portability.js';

const source = allocateEntityId('th');
const target = allocateEntityId('th');
const userId = allocateEntityId('usr');
const resource = { family: 'thread', id: source };
const entry = { resource, grants: [], prohibitions: [] };
const config = (boundary: unknown) =>
  JSON.stringify({
    requiredFeatures: [WORKSPACE_RESOURCE_POLICY_FEATURE],
    workspace: { name: 'Portable privacy', policy: { resourceAccess: [boundary] } },
  });
const input = {
  content: config(entry),
  threads: [{ id: source, visibility: 'workspace' }],
  threadIds: new Map([[source, target]]),
  manifestFeatures: [WORKSPACE_RESOURCE_POLICY_FEATURE],
};

describe('portable Workspace resource Policy', () => {
  it('retains an empty last-revoke boundary with its reminted Thread on a different Server', () => {
    const imported = parse(remintResourcePolicyConfig(input));
    expect(imported.workspace.policy.resourceAccess).toEqual([
      { ...entry, resource: { family: 'thread', id: target } },
    ]);
    expect(imported.requiredFeatures).toEqual([WORKSPACE_RESOURCE_POLICY_FEATURE]);
  });

  it('rejects an unvalidated principal before any target publication and preserves validated terms', () => {
    const grant = { subject: { kind: 'user', userId }, operations: ['thread.read'] };
    const captured = {
      ...input,
      content: config({ ...entry, grants: [grant], prohibitions: [grant] }),
    };
    expect(() => remintResourcePolicyConfig(captured)).toThrow('principal binding');
    expect(
      parse(remintResourcePolicyConfig({ ...captured, subjectEligible: () => true })).workspace
        .policy.resourceAccess[0]
    ).toEqual({
      resource: { family: 'thread', id: target },
      grants: [grant],
      prohibitions: [grant],
    });
    expect(() => remintResourcePolicyConfig({ ...input, manifestFeatures: [] })).toThrow(
      'required feature'
    );
    expect(() => remintResourcePolicyConfig({ ...input, threadIds: new Map() })).toThrow(
      'identity'
    );
    expect(() => remintResourcePolicyConfig({ ...input, threads: [] })).toThrow('Thread owner');
  });
});

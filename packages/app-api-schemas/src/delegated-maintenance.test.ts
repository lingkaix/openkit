import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ApplyDelegatedAdministrationConfigurationRequestSchema,
  ProposeAdministrationConfigurationRequestSchema,
} from './administration.js';

describe('finite Worker Git-read proposal', () => {
  it('accepts only exact candidate and request identity in the private apply input', () => {
    const request = {
      requestId: randomUUID(),
      candidate: {
        artifactId: randomUUID(),
        artifactVersion: 1,
        contentDigest: `sha256:${'1'.repeat(64)}`,
      },
    };
    expect(ApplyDelegatedAdministrationConfigurationRequestSchema.safeParse(request).success).toBe(
      true
    );
    for (const extra of [
      { actor: 'administrator' },
      { threadId: randomUUID() },
      { authorized: true },
      { assignment: {} },
      { confirmation: { action: 'administration.configuration.apply' } },
      { content: 'replacement source' },
    ]) {
      expect(
        ApplyDelegatedAdministrationConfigurationRequestSchema.safeParse({ ...request, ...extra })
          .success
      ).toBe(false);
    }
  });
  it('admits only a registered Agent identity, exact source revision and retained failure reference', () => {
    const request = {
      targetFamily: 'agent',
      targetId: randomUUID(),
      expectedRevision: `sha256:${'1'.repeat(64)}`,
      failure: { workspaceId: randomUUID(), threadId: randomUUID(), turnId: randomUUID() },
      changes: {
        networkGrantId: 'git-read',
        rules: [
          { method: 'GET', path: '/team/project.git/info/refs*' },
          { method: 'POST', path: '/team/project.git/git-upload-pack' },
        ],
      },
    };
    expect(ProposeAdministrationConfigurationRequestSchema.safeParse(request).success).toBe(true);
    for (const change of [
      { failure: undefined },
      { path: '/caller-selected-file' },
      { changes: { ...request.changes, host: 'other.example.com' } },
      { changes: { ...request.changes, binaries: ['/bin/other'] } },
      { changes: { ...request.changes, rules: [{ method: 'DELETE', path: '/' }] } },
    ]) {
      expect(
        ProposeAdministrationConfigurationRequestSchema.safeParse({ ...request, ...change }).success
      ).toBe(false);
    }
  });
});

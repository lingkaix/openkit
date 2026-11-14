import { describe, expect, it } from 'vitest';
import { PolicyDocumentV1Schema, PolicyGrantV1Schema } from '../index.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const principal = { kind: 'human', id: userId };
const anchor = { owner: { kind: 'workspace', workspaceId }, kind: 'workspace', id: workspaceId };

/** A complete authored permission keeps rejection attributable to its grant. */
function document(grant: unknown) {
  return {
    schemaVersion: 1,
    statements: [
      {
        kind: 'permission',
        id: 'authored-grant',
        author: principal,
        authority: { kind: 'human', userId },
        authoredAt: '2026-10-18T00:00:00.000Z',
        state: 'active',
        scope: {
          subjects: [principal],
          actions: ['knowledge.read'],
          resources: [{ kind: 'container', container: anchor }],
        },
        lifetime: { anchor, notAfter: '2026-10-20T00:00:00.000Z' },
        effect: 'allow',
        grant,
      },
    ],
  };
}

describe('Policy grant ablation', () => {
  // Approved F45 deletion rejects the previously valid authoring surface, not just bad leases.
  it.each(['read-only', 'staged-write'])('rejects storage-lease authoring in %s mode', (mode) => {
    const grant = {
      kind: 'storage-lease',
      knowledgeBaseId: 'kb_00000000-0000-7000-8000-000000000001',
      mount: 'local',
      pathPrefix: 'docs/chapter',
      mode,
    };
    expect.soft(PolicyGrantV1Schema.safeParse(grant).success).toBe(false);
    expect(PolicyDocumentV1Schema.safeParse(document(grant)).success).toBe(false);
  });

  it('preserves ordinary permission effects and the closed grant shape', () => {
    for (const effect of ['allow', 'prohibit', 'require_approval']) {
      const input = document({ kind: 'ordinary' });
      input.statements[0]!.effect = effect;
      expect(PolicyDocumentV1Schema.parse(input)).toEqual(input);
    }
    expect(PolicyGrantV1Schema.safeParse({ kind: 'ordinary', mount: 'local' }).success).toBe(false);
  });

  it('preserves finite maintenance permissions and their expiry requirement', () => {
    const container = { owner: { kind: 'server' }, kind: 'agent', id: 'registered-worker' };
    const input = document({
      kind: 'worker-git-read-maintenance',
      networkGrantId: 'repository-read',
      host: 'git.example.test',
      port: 443,
      protocol: 'rest',
      repositoryPaths: ['/team/project.git'],
      binaries: ['/usr/bin/git'],
      validFrom: '2026-10-19T00:00:00.000Z',
    });
    const statement = {
      ...input.statements[0]!,
      scope: {
        subjects: [principal],
        actions: ['administration.configuration.apply'],
        resources: [{ kind: 'container', container }],
      },
      lifetime: { anchor: container, notAfter: '2026-10-20T00:00:00.000Z' },
    };
    const finite = { schemaVersion: 1, statements: [statement] };
    expect(PolicyDocumentV1Schema.parse(finite)).toEqual(finite);
    for (const lifetime of [
      { anchor: container },
      { anchor: container, notAfter: '2026-10-19T00:00:00.000Z' },
    ]) {
      expect(
        PolicyDocumentV1Schema.safeParse({ ...finite, statements: [{ ...statement, lifetime }] })
          .success
      ).toBe(false);
    }
  });
});

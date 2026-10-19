import { describe, expect, it } from 'vitest';

import { evaluateWorkerGitReadMaintenance } from './worker-git-read-maintenance.js';

const userId = 'usr_00000000-0000-7000-8000-000000000002';
const container = { owner: { kind: 'server' as const }, kind: 'agent', id: 'agent_worker' };
const assignment = {
  id: 'finite-git-read',
  kind: 'permission' as const,
  state: 'active' as const,
  author: { kind: 'human' as const, id: userId },
  authority: { kind: 'human' as const, userId },
  authoredAt: '2026-10-15T00:00:00.000Z',
  scope: {
    subjects: [{ kind: 'human' as const, id: userId }],
    actions: ['administration.configuration.apply'],
    resources: [{ kind: 'container' as const, container }],
  },
  lifetime: { anchor: container, notAfter: '2026-10-16T01:00:00.000Z' },
  effect: 'allow' as const,
  grant: {
    kind: 'worker-git-read-maintenance' as const,
    networkGrantId: 'git-read',
    host: 'git.example.test',
    port: 443,
    protocol: 'rest',
    repositoryPaths: ['/team/project.git'],
    binaries: ['/usr/bin/git'],
    validFrom: '2026-10-16T00:00:00.000Z',
  },
};
const policy = (statements = [assignment]) => ({ schemaVersion: 1 as const, statements });
const authorCurrent = (humanId: string) => humanId === userId;
const facts = {
  responsibleUserId: 'usr_00000000-0000-7000-8000-000000000002',
  agentId: 'agent_worker',
  networkGrantId: 'git-read',
  host: 'git.example.test',
  port: 443,
  protocol: 'rest',
  repositoryPath: '/team/project.git',
  binaries: ['/usr/bin/git'],
  now: new Date('2026-10-16T00:30:00.000Z'),
};

describe('finite Worker Git-read Policy evaluation', () => {
  it('ends a distinct human author statement when that author loses current authority', () => {
    const issuerId = 'usr_00000000-0000-7000-8000-000000000003';
    const issued = {
      ...assignment,
      author: { kind: 'human' as const, id: issuerId },
      authority: { kind: 'human' as const, userId: issuerId },
    };
    let issuerActive = true;
    const current = (humanId: string) => humanId === issuerId && issuerActive;
    expect(evaluateWorkerGitReadMaintenance(policy([issued]), facts, current).effect).toBe('allow');
    issuerActive = false;
    expect(evaluateWorkerGitReadMaintenance(policy([issued]), facts, current).effect).toBe('deny');
    expect(evaluateWorkerGitReadMaintenance(policy([issued]), facts, authorCurrent).effect).toBe(
      'deny'
    );
  });

  it('removes current authority when the common statement is inactive or absent', () => {
    expect(
      evaluateWorkerGitReadMaintenance(
        { schemaVersion: 1, statements: [{ ...assignment, state: 'inactive' }] },
        facts,
        authorCurrent
      ).effect
    ).toBe('deny');
    expect(evaluateWorkerGitReadMaintenance(policy([]), facts, authorCurrent).effect).toBe('deny');
  });
  it.each([
    { at: '2026-10-15T23:59:59.999Z', effect: 'deny' },
    { at: '2026-10-16T00:00:00.000Z', effect: 'allow' },
    { at: '2026-10-16T00:59:59.999Z', effect: 'allow' },
    { at: '2026-10-16T01:00:00.000Z', effect: 'deny' },
  ])('returns $effect at the exact validity boundary $at', ({ at, effect }) => {
    expect(
      evaluateWorkerGitReadMaintenance(policy(), { ...facts, now: new Date(at) }, authorCurrent)
        .effect
    ).toBe(effect);
  });

  it('does not union duplicate tuples into broader authority', () => {
    expect(
      evaluateWorkerGitReadMaintenance(
        policy([
          assignment,
          {
            ...assignment,
            id: 'duplicate-tuple',
            grant: { ...assignment.grant, repositoryPaths: ['/other/project.git'] },
          },
        ]),
        facts,
        authorCurrent
      ).effect
    ).toBe('deny');
  });

  it.each([
    { reason: 'empty binary scope', changed: { binaries: [] } },
    { reason: 'an additional binary', changed: { binaries: ['/usr/bin/git', '/usr/bin/curl'] } },
    { reason: 'an alternate protocol', changed: { protocol: 'tcp' } },
    { reason: 'an alternate port', changed: { port: 8443 } },
    {
      reason: 'another responsible human',
      changed: { responsibleUserId: 'usr_00000000-0000-7000-8000-000000000003' },
    },
    { reason: 'another Agent', changed: { agentId: 'another-worker' } },
    { reason: 'another network grant', changed: { networkGrantId: 'other-grant' } },
    { reason: 'another host', changed: { host: 'other.example.test' } },
    { reason: 'another repository', changed: { repositoryPath: '/other/project.git' } },
  ])('refuses $reason through the actual kernel', ({ changed }) => {
    expect(
      evaluateWorkerGitReadMaintenance(policy(), { ...facts, ...changed }, authorCurrent).effect
    ).toBe('deny');
  });

  it('fails closed on an unknown authority field or an invalid current time', () => {
    expect(
      evaluateWorkerGitReadMaintenance(
        policy([{ ...assignment, grant: { ...assignment.grant, allowPush: true } }]),
        facts,
        authorCurrent
      ).effect
    ).toBe('deny');
    expect(
      evaluateWorkerGitReadMaintenance(
        policy(),
        { ...facts, now: new Date(Number.NaN) },
        authorCurrent
      ).effect
    ).toBe('deny');
  });
});

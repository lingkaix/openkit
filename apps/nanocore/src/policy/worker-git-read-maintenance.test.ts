import { describe, expect, it } from 'vitest';

import { evaluateWorkerGitReadMaintenance } from './worker-git-read-maintenance.js';

const assignment = {
  responsibleUserId: 'usr_00000000-0000-7000-8000-000000000002',
  agentId: 'agent_worker',
  networkGrantId: 'git-read',
  host: 'git.example.test',
  port: 443,
  protocol: 'rest',
  repositoryPaths: ['/team/project.git'],
  binaries: ['/usr/bin/git'],
  validFrom: '2026-10-16T00:00:00.000Z',
  expiresAt: '2026-10-16T01:00:00.000Z',
  enabled: true,
};
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
  it.each([
    { at: '2026-10-15T23:59:59.999Z', effect: 'deny' },
    { at: '2026-10-16T00:00:00.000Z', effect: 'allow' },
    { at: '2026-10-16T00:59:59.999Z', effect: 'allow' },
    { at: '2026-10-16T01:00:00.000Z', effect: 'deny' },
  ])('returns $effect at the exact validity boundary $at', ({ at, effect }) => {
    expect(
      evaluateWorkerGitReadMaintenance([assignment], { ...facts, now: new Date(at) }).effect
    ).toBe(effect);
  });

  it('does not union duplicate tuples into broader authority', () => {
    expect(
      evaluateWorkerGitReadMaintenance(
        [assignment, { ...assignment, repositoryPaths: ['/other/project.git'] }],
        facts
      ).effect
    ).toBe('deny');
  });

  it.each([
    { reason: 'empty binary scope', changed: { binaries: [] } },
    { reason: 'an additional binary', changed: { binaries: ['/usr/bin/git', '/usr/bin/curl'] } },
    { reason: 'an alternate protocol', changed: { protocol: 'tcp' } },
    { reason: 'an alternate port', changed: { port: 8443 } },
  ])('refuses $reason through the actual kernel', ({ changed }) => {
    expect(evaluateWorkerGitReadMaintenance([assignment], { ...facts, ...changed }).effect).toBe(
      'deny'
    );
  });

  it('fails closed on an unknown authority field or an invalid current time', () => {
    expect(
      evaluateWorkerGitReadMaintenance([{ ...assignment, allowPush: true }], facts).effect
    ).toBe('deny');
    expect(
      evaluateWorkerGitReadMaintenance([assignment], { ...facts, now: new Date(Number.NaN) }).effect
    ).toBe('deny');
  });
});

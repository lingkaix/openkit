import { expect, it } from 'vitest';
import { requireMatchingWorkerReleaseIdentity } from './worker-release-identity.js';

const core = { sourceCommit: 'a'.repeat(40), releaseTag: 'v0.1.0-rc.1' };

it.each([
  undefined,
  null,
  {},
  { sourceCommit: null, releaseTag: null },
  { ...core, sourceCommit: 'b'.repeat(40) },
  { ...core, sourceCommit: 'A'.repeat(40) },
  { ...core, releaseTag: 'v0.1.0-rc.2' },
  { ...core, releaseTag: null },
  { ...core, releaseTag: 'not-a-release' },
])('refuses unknown, malformed or different Worker identity without echoing it: %j', (peer) => {
  expect(() => requireMatchingWorkerReleaseIdentity(core, peer)).toThrow(
    expect.objectContaining({ code: 'worker_release_incompatible', status: 409 })
  );
});

it('never treats two unknown identities as a match', () => {
  expect(() =>
    requireMatchingWorkerReleaseIdentity(
      { sourceCommit: null, releaseTag: null },
      { sourceCommit: null, releaseTag: null }
    )
  ).toThrow(expect.objectContaining({ code: 'worker_release_incompatible' }));
});

it('admits exact tagged and known untagged builds, ignoring inert additive metadata', () => {
  expect(requireMatchingWorkerReleaseIdentity(core, { ...core, future: 'inert' })).toEqual(core);
  const source = { ...core, releaseTag: null };
  expect(requireMatchingWorkerReleaseIdentity(source, source)).toEqual(source);
});

// Main-loop >100ms work must be attributed; rejection must not introduce a peer-regex stall.
// Thread CPU measures this synchronous work without treating host descheduling as product cost.
it('rejects a hostile in-bound peer tag without spending 100ms of Main CPU', () => {
  const peer = { sourceCommit: core.sourceCommit, releaseTag: `v0.1.0-${'a'.repeat(20_000)}!` };
  const before = process.threadCpuUsage();
  expect(() => requireMatchingWorkerReleaseIdentity(core, peer)).toThrow(
    expect.objectContaining({ code: 'worker_release_incompatible' })
  );
  const cpu = process.threadCpuUsage(before);
  expect(cpu.user + cpu.system).toBeLessThan(100_000);
});

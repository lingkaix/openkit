import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { selectTag } from '../scripts/release-candidate.mjs';
import {
  candidateSecurityScope,
  checkedCandidateRegister,
  releaseCreateArgs,
} from '../scripts/release-direct.mjs';
import { publishImageArgs, selectedAdmittedDigest } from '../scripts/release-image-state.mjs';
import { directStableGrant } from '../scripts/release-preflight.mjs';
import { sha as checksum } from '../scripts/release-safety.mjs';
import {
  attestationArguments,
  verifyCandidateBundleChecksum,
} from '../scripts/verify-release-integrity.mjs';

const repository = 'lingkaix/openkit';
const tag = 'v0.2.0';
const sha = 'a'.repeat(40);
const now = Date.parse('2026-11-20T10:00:00Z');
const digest = (value) => `sha256:${value.repeat(64)}`;

test('stock selection admits stable 0.x and reserves prereleases for major cycles', () => {
  const notes = ['v0.1.1-rc.1', 'v0.2.0-rc.1', tag];
  assert.equal(selectTag({ repository, notes, tags: [] }), tag);
  for (const explicit of notes.slice(0, -1))
    assert.throws(() => selectTag({ repository, notes, tags: [], explicit }), /unused notes/);
  assert.equal(selectTag({ repository, notes: ['v1.0.0-rc.1'], tags: [] }), 'v1.0.0-rc.1');
  assert.equal(selectTag({ repository, notes, tags: [tag] }), '');
  assert.deepEqual(directStableGrant(tag, sha, `${tag}@${sha}:42:1`), { runId: 42, attempt: 1 });
  for (const wrong of [undefined, `${tag}@${sha}`, `${tag}@${sha}:42:0`, `v0.2.1@${sha}:42:1`])
    assert.throws(() => directStableGrant(tag, sha, wrong), /candidate attempt grant/);
});

test('candidate admission requires a current secret bound to the exact six platform digests', () => {
  const scope = candidateSecurityScope({
    repository,
    tag,
    sha,
    candidate: { runId: 42, attempt: 1 },
    images: ['app', 'worker-common', 'worker-runtimes'].map((id, i) => ({
      candidate: {
        id,
        digest: digest(String(i + 1)),
        platforms: [
          { platform: 'linux/amd64', digest: digest(String(i + 4)) },
          { platform: 'linux/arm64', digest: digest(String(i + 7)) },
        ],
      },
    })),
  });
  assert.equal(scope.images.flatMap((image) => image.platforms).length, 6);
  const value = {
    schemaVersion: 1,
    scope,
    validUntil: '2026-11-20T11:00:00Z',
    register: { schemaVersion: 1, records: [] },
    qualification: { workerReadiness: { sourceCommit: sha } },
  };
  const check = (input) => checkedCandidateRegister(JSON.stringify(input), scope, now);
  assert.equal(check(value).register.records.length, 0);
  for (const bad of [
    undefined,
    '',
    value.register,
    { ...value, register: undefined },
    { ...value, validUntil: '2026-11-20T09:59:59Z' },
    { ...value, scope: { ...scope, repository: 'example/openkit' } },
    { ...value, scope: { ...scope, attempt: 2 } },
    { ...value, scope: { ...scope, sha: 'b'.repeat(40) } },
    { ...value, scope: { ...scope, tag: 'v0.2.1' } },
    { ...value, scope: { ...scope, images: scope.images.slice(1) } },
    {
      ...value,
      scope: {
        ...scope,
        images: scope.images.map((image) => ({
          ...image,
          platforms: image.platforms.map((platform) => ({ ...platform, digest: digest('f') })),
        })),
      },
    },
  ])
    assert.throws(() => check(bad), /register|finding gate refused/);
});

test('stable readback rejects the same C with checksum bytes from a different attempt', () => {
  const bundles = [Buffer.from('first checksum list\n'), Buffer.from('second checksum list\n')];
  const identity = { repository, tag, sha };
  const proofs = bundles.map((bytes, i) => ({
    ...identity,
    runId: 42,
    attempt: i + 1,
    checksums: checksum(bytes),
  }));
  for (const [i, proof] of proofs.entries()) {
    assert.doesNotThrow(() =>
      verifyCandidateBundleChecksum({ ...identity, proof, bytes: bundles[i] })
    );
    assert.throws(
      () => verifyCandidateBundleChecksum({ ...identity, proof, bytes: bundles[1 - i] }),
      /differs from the selected stable candidate/u
    );
  }
  assert.throws(
    () => verifyCandidateBundleChecksum({ ...identity, bytes: bundles[0] }),
    /differs from the selected stable candidate/u
  );
});

test('the direct tag plans the full stable upload and pins its signer to CI and the exact tag', () => {
  const args = releaseCreateArgs({ repository, tag, assetsDir: 'assets', notesFile: 'notes.md' });
  const assets = args.slice(3, args.indexOf('--repo'));
  assert.equal(assets.length, 13);
  assert.equal(new Set(assets).size, 13);
  assert.ok(assets.includes(join('assets', `openkit-release-${tag}.json`)));
  assert.ok(args.includes('--verify-tag') && args.includes('--latest'));
  assert.ok(!args.includes('--prerelease'));
  const verify = attestationArguments({ repository, tag, sha, subject: assets[0] });
  assert.ok(verify.includes(`${repository}/.github/workflows/ci.yml`));
  assert.ok(verify.includes(`refs/tags/${tag}`));
  assert.ok(verify.includes(sha));
});

test('registry dry-run and tag publisher share exact aliases and source digest', () => {
  const image = 'ghcr.io/lingkaix/openkit-app';
  const input = { image, digest: digest('a'), tag, sha };
  const dry = publishImageArgs({ ...input, dryRun: true });
  const write = publishImageArgs(input);
  assert.deepEqual(
    dry.filter((arg) => arg !== '--dry-run'),
    write
  );
  assert.equal(dry[3], '--dry-run');
  assert.deepEqual(write.slice(3, -1), [
    '--tag',
    `${image}:${tag}`,
    '--tag',
    `${image}:0.2.0`,
    '--tag',
    `${image}:sha-${sha.slice(0, 12)}`,
    '--tag',
    `${image}:latest`,
  ]);
  assert.equal(write.at(-1), `${image}@${digest('a')}`);
});

test('the tag writer refuses a conflicting or missing admitted digest before assigning aliases', () => {
  const selected = digest('a');
  for (const present of ['false', 'true'])
    assert.deepEqual(selectedAdmittedDigest(selected, { present, existing: selected }), {
      digest: selected,
      reused: present,
    });
  assert.throws(
    () => selectedAdmittedDigest(selected, { present: 'true', existing: digest('b') }),
    /changed after security/
  );
  assert.throws(() => selectedAdmittedDigest('', { present: 'false' }), /Invalid admitted/);
  assert.throws(() => selectedAdmittedDigest(selected, {}), /Invalid admitted/);
});

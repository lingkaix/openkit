import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  compactReleaseRecord,
  createReleaseManifest,
  draftReleaseNotes,
  parseReleaseNotesInput,
} from '../scripts/release-notes.mjs';

/** Exact synthetic image/checksum/assessment inputs from the existing producers. */
export function manifestInput() {
  const tag = 'v0.1.0-rc.6',
    sha = 'a'.repeat(40),
    digest = `sha256:${'b'.repeat(64)}`;
  return {
    tag,
    sha,
    repository: 'lingkaix/openkit',
    images: ['app', 'worker-common', 'worker-runtimes'].map((id) => ({
      id,
      image: `ghcr.io/lingkaix/openkit/${id}`,
      digest,
      prerelease: true,
      tags: [tag, tag.slice(1), `sha-${sha.slice(0, 12)}`],
      platforms: ['linux/amd64', 'linux/arm64'].map((platform) => ({ platform, digest })),
    })),
    checksums: `${[
      `openkit-ops-skill-${tag}.tar.gz`,
      ...['amd64', 'arm64'].map((arch) => `openkit-nanohost-${tag}-linux-${arch}.tar.gz`),
    ]
      .map((name) => `${'c'.repeat(64)}  ${name}`)
      .join('\n')}\n`,
    assertions: {
      sourceCommit: sha,
      appDigest: digest,
      previousAppImageId: `sha256:${'d'.repeat(64)}`,
      migrationFree: true,
      configurationCompatible: true,
      retainedDataCompatible: true,
      recovery: 'previous-image-compatible',
      provenance: 'synthetic-reviewed-assessment',
    },
  };
}
test('manifest projects both image platforms and portable identities', () => {
  const m = createReleaseManifest(manifestInput());
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.images.length, 3);
  assert.equal(m.assets.length, 3);
  assert.equal(m.sourceCommit, 'a'.repeat(40));
});
for (const key of Object.keys(manifestInput().assertions))
  test(`manifest refuses missing compatibility/recovery fact ${key}`, () => {
    const input = manifestInput();
    delete input.assertions[key];
    assert.throws(() => createReleaseManifest(input));
  });
for (const [name, change] of [
  [
    'private provenance path',
    (i) => {
      i.assertions.provenance = '/example/private/assessment';
    },
  ],
  [
    'credential-shaped provenance',
    (i) => {
      i.assertions.provenance = 'sk-syntheticcredentialvalue';
    },
  ],
  [
    'unknown recovery',
    (i) => {
      i.assertions.recovery = 'unknown';
    },
  ],
  [
    'migration',
    (i) => {
      i.assertions.migrationFree = false;
    },
  ],
  [
    'wrong assessed source',
    (i) => {
      i.assertions.sourceCommit = 'e'.repeat(40);
    },
  ],
  [
    'missing App',
    (i) => {
      i.images.shift();
    },
  ],
  [
    'missing platform',
    (i) => {
      i.images[0].platforms.pop();
    },
  ],
  [
    'missing NanoHost',
    (i) => {
      i.checksums = i.checksums.split('\n').slice(0, 2).join('\n');
    },
  ],
  [
    'duplicate checksum',
    (i) => {
      i.checksums += `${i.checksums.split('\n')[0]}\n`;
    },
  ],
])
  test(`manifest refuses ${name}`, () => {
    const input = manifestInput();
    change(input);
    assert.throws(() => createReleaseManifest(input));
  });
test('draft producer preserves the existing reviewed two-section grammar', () => {
  const draft = draftReleaseNotes({
    changes: ['Accepted change #241.'],
    knownIssues: ['R001 remains open.'],
  });
  assert.equal(parseReleaseNotesInput(draft), draft.trimEnd());
  assert.throws(() => draftReleaseNotes({ changes: [], knownIssues: ['None.'] }));
});
test('compact record keeps effect results separate and refuses an incomplete header', () => {
  const tag = 'v0.1.0-rc.6',
    sha = 'a'.repeat(40);
  const header = {
    tag,
    sourceCommit: sha,
    authorizationReference: 'engineer-standing-grant',
    candidateRunId: 1,
    visibility: 'public',
    stages: [
      { name: 'app', result: 'passed', start: '2026-10-14T00:00:00Z', end: '2026-10-14T00:01:00Z' },
      {
        name: 'nanohost',
        result: 'unknown',
        start: '2026-10-14T00:01:00Z',
        end: '2026-10-14T00:02:00Z',
      },
    ],
  };
  const text = compactReleaseRecord({ tag, sha, header });
  assert.throws(() => compactReleaseRecord({ tag: '/example/private', sha, header }));
  assert.match(text, /app \| passed/);
  assert.match(text, /nanohost \| unknown/);
  delete header.authorizationReference;
  assert.throws(() => compactReleaseRecord({ tag, sha, header }), /incomplete/);
});
test('manifest CLI generates the asset and refuses changed downloaded bytes', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-manifest-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = manifestInput(),
    records = path.join(dir, 'records'),
    assertions = path.join(dir, 'assertions.json'),
    checksums = path.join(dir, 'SHA256SUMS'),
    output = path.join(dir, 'manifest.json');
  mkdirSync(records);
  for (const image of input.images)
    writeFileSync(path.join(records, `${image.id}.json`), JSON.stringify(image));
  writeFileSync(assertions, JSON.stringify(input.assertions));
  writeFileSync(checksums, input.checksums);
  const args = [
    path.resolve('scripts/release-notes.mjs'),
    '--tag',
    input.tag,
    '--sha',
    input.sha,
    '--repository',
    input.repository,
    '--records',
    records,
    '--assertions',
    assertions,
    '--checksum-file',
    checksums,
  ];
  const run = (extra) => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8' });
  assert.equal(run(['--manifest-output', output]).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), createReleaseManifest(input));
  assert.equal(run(['--compare-manifest', output]).status, 0);
  writeFileSync(output, readFileSync(output, 'utf8').replace(input.sha, 'f'.repeat(40)));
  const changed = run(['--compare-manifest', output]);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /differs/);
});

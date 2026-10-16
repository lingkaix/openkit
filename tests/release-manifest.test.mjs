import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReleaseNotes, parseReleaseNotesInput } from '../scripts/release-notes.mjs';
import {
  compactReleaseRecord,
  createReleaseManifest,
  createReleaseRecord,
  draftReleaseNotes,
} from '../scripts/release-record.mjs';

test('the invoked release-notes file is byte-identical to the proved baseline', () => {
  // Pin the raw blob bytes at proved baseline 23f3e2dc73676c61173005c0772fee6db6bdf09c; shallow CI has no baseline object.
  assert.equal(
    createHash('sha256').update(readFileSync('scripts/release-notes.mjs')).digest('hex'),
    '0e044491d24cf00e888866a744d944069bef3bcb895ceaf5dd02b90d0b93aa9f'
  );
});

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
test('record command reuses the unchanged published notes and generates the reviewed draft', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-record-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tag = 'v0.1.0-rc.6',
    digest = `sha256:${'b'.repeat(64)}`;
  mkdirSync(path.join(dir, 'release-notes'));
  mkdirSync(path.join(dir, 'records'));
  writeFileSync(
    path.join(dir, 'release-notes', `${tag}.md`),
    draftReleaseNotes({ changes: ['Reviewed change.'], knownIssues: ['Known limitation.'] })
  );
  writeFileSync(
    path.join(dir, 'records/app.json'),
    JSON.stringify({ id: 'app', digest, platforms: [{ platform: 'linux/arm64', digest }] })
  );
  writeFileSync(path.join(dir, 'records/app.md'), `App: ${digest}\n`);
  const input = {
    repoRoot: dir,
    recordsDir: path.join(dir, 'records'),
    tag,
    sha: 'a'.repeat(40),
    checksum: 'c'.repeat(64),
    visibility: 'public',
    runUrl: 'https://example.invalid/actions/runs/1',
  };
  const original = createReleaseNotes(input);
  assert.equal(createReleaseRecord(input), original);
  const header = {
    tag,
    sourceCommit: input.sha,
    authorizationReference: 'synthetic-grant',
    candidateRunId: 1,
    visibility: 'public',
    stages: [],
  };
  const compact = createReleaseRecord({ ...input, header });
  assert(compact.startsWith(original));
  assert.match(compact, /Compact Release Record/);
  const draftInput = path.join(dir, 'draft.json'),
    output = path.join(dir, 'draft.md');
  writeFileSync(
    draftInput,
    JSON.stringify({ changes: ['Reviewed change.'], knownIssues: ['Known limitation.'] })
  );
  const run = spawnSync(
    process.execPath,
    ['scripts/release-record.mjs', '--tag', tag, '--draft-input', draftInput, '--output', output],
    { encoding: 'utf8' }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    readFileSync(output, 'utf8').trimEnd(),
    readFileSync(path.join(dir, 'release-notes', `${tag}.md`), 'utf8').trimEnd()
  );
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
    path.resolve('scripts/release-record.mjs'),
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

test('publication attaches a fifth checksummed asset and compares all downloaded facts', async (t) => {
  const { publicationManifest } = await import('../scripts/release-record.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'release-published-manifest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = manifestInput();
  for (const name of ['release-notes', 'records', 'assets']) mkdirSync(path.join(dir, name));
  const { sourceCommit: _source, appDigest: _app, ...facts } = input.assertions;
  writeFileSync(
    path.join(dir, 'release-notes', `${input.tag}.manifest.json`),
    JSON.stringify(facts)
  );
  for (const image of input.images)
    writeFileSync(path.join(dir, 'records', `${image.id}.json`), JSON.stringify(image));
  const sums = `${input.checksums
    .trim()
    .split('\n')
    .map((line) => {
      const name = line.slice(66);
      const bytes = Buffer.from(`synthetic archive ${name}`);
      writeFileSync(path.join(dir, 'assets', name), bytes);
      return `${createHash('sha256').update(bytes).digest('hex')}  ${name}`;
    })
    .join('\n')}\n`;
  writeFileSync(path.join(dir, 'assets', 'SHA256SUMS'), sums);
  const params = {
    repoRoot: dir,
    tag: input.tag,
    sha: input.sha,
    repository: input.repository,
    recordsDir: path.join(dir, 'records'),
    assetsDir: path.join(dir, 'assets'),
  };
  publicationManifest(params);
  const name = `openkit-release-${input.tag}.json`;
  assert.equal(
    readFileSync(path.join(params.assetsDir, 'SHA256SUMS'), 'utf8').trim().split('\n').length,
    4
  );
  assert.equal(publicationManifest({ ...params, verify: true }).assets.length, 3);
  assert.throws(() => publicationManifest(params), /already written/);
  const original = readFileSync(path.join(params.assetsDir, name));
  writeFileSync(path.join(params.assetsDir, name), `${original}\n`);
  assert.throws(() => publicationManifest({ ...params, verify: true }), /manifest differs/);
  writeFileSync(path.join(params.assetsDir, name), original);
  writeFileSync(
    path.join(params.assetsDir, input.checksums.trim().split('\n')[0].slice(66)),
    'changed'
  );
  assert.throws(
    () => publicationManifest({ ...params, verify: true }),
    /portable checksum mismatch/
  );
});

test('reviewed publication assessment refuses absent, negative and caller-supplied binding facts', async (t) => {
  const { readReleaseAssessment } = await import('../scripts/release-record.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'release-assessment-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'release-notes'));
  const input = manifestInput();
  const { sourceCommit: _source, appDigest: _app, ...facts } = input.assertions;
  const file = path.join(dir, 'release-notes', `${input.tag}.manifest.json`);
  assert.throws(() => readReleaseAssessment(dir, input.tag), /ENOENT/);
  for (const key of Object.keys(facts)) {
    const missing = { ...facts };
    delete missing[key];
    writeFileSync(file, JSON.stringify(missing));
    assert.throws(() => readReleaseAssessment(dir, input.tag), /missing or unassessed/, key);
  }
  for (const changed of [
    { ...facts, migrationFree: false },
    { ...facts, recovery: 'unknown' },
    { ...facts, sourceCommit: input.sha },
    { ...facts, appDigest: input.assertions.appDigest },
  ]) {
    writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => readReleaseAssessment(dir, input.tag), /missing or unassessed/);
  }
  writeFileSync(file, JSON.stringify(facts));
  assert.deepEqual(readReleaseAssessment(dir, input.tag), facts);
});

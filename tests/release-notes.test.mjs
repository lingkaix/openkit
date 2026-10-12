import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = join(process.cwd(), 'scripts', 'release-notes.mjs');
const tag = 'v0.0.0-scratch.1';

/**
 * Runs the release-notes CLI.
 *
 * @param {string[]} args CLI arguments after the script path.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} CLI result.
 */
function runNotes(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

/**
 * Writes one tag notes input.
 *
 * @param {string} repoRoot Fixture root.
 * @param {string} body Markdown body.
 */
function writeInput(repoRoot, body) {
  const directory = join(repoRoot, 'release-notes');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${tag}.md`), body);
}

/** @returns {string} Empty fixture root. */
function fixtureRoot() {
  return mkdtempSync(join(tmpdir(), 'openkit-release-notes-'));
}

const validInput = `## Changes since the previous candidate

Shipped the notes fix.

## Known issues

R001 remains open.
`;

test('release notes check fails on a missing file, a bad heading, an empty section, and a duplicate heading', () => {
  const missingRoot = fixtureRoot();
  const missing = runNotes(['--check', '--repo-root', missingRoot, '--tag', tag]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Release notes input is missing/);

  const missingHeadingRoot = fixtureRoot();
  writeInput(
    missingHeadingRoot,
    `## Changes since the previous candidate

Shipped the notes fix.
`
  );
  const missingHeading = runNotes(['--check', '--repo-root', missingHeadingRoot, '--tag', tag]);
  assert.notEqual(missingHeading.status, 0);
  assert.match(missingHeading.stderr, /missing the heading "Known issues"/);

  const extraRoot = fixtureRoot();
  writeInput(
    extraRoot,
    `${validInput}
## Other

More.
`
  );
  const extra = runNotes(['--check', '--repo-root', extraRoot, '--tag', tag]);
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /extra level-2 heading: Other/);

  const emptyRoot = fixtureRoot();
  writeInput(
    emptyRoot,
    `## Changes since the previous candidate

## Known issues

R001 remains open.
`
  );
  const empty = runNotes(['--check', '--repo-root', emptyRoot, '--tag', tag]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /section "Changes since the previous candidate" is empty/);

  const duplicateRoot = fixtureRoot();
  writeInput(
    duplicateRoot,
    `## Changes since the previous candidate

Shipped the notes fix.

## Known issues

R001 remains open.

## Known issues

Repeated.
`
  );
  const duplicate = runNotes(['--check', '--repo-root', duplicateRoot, '--tag', tag]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /repeats the heading "Known issues"/);
});

test('release notes check passes on a valid file', () => {
  const repoRoot = fixtureRoot();
  writeInput(repoRoot, validInput);
  const result = runNotes(['--check', '--repo-root', repoRoot, '--tag', tag]);
  assert.equal(result.status, 0, result.stderr);
});

test('release notes generation includes the readiness sentence and the committed sections', () => {
  const repoRoot = fixtureRoot();
  writeInput(repoRoot, validInput);
  const records = join(repoRoot, 'release-records');
  mkdirSync(records);
  writeFileSync(
    join(records, 'app.md'),
    `### app

- Image: \`ghcr.io/example/openkit-app\`
- Digest: \`sha256:${'a'.repeat(64)}\`
- Platform manifest \`linux/amd64\`: \`sha256:${'b'.repeat(64)}\`
- Platform manifest \`linux/arm64\`: \`sha256:${'c'.repeat(64)}\`
- Reused immutable release identity: \`false\`
- Tags:
  - \`ghcr.io/example/openkit-app:${tag}\`
`
  );
  writeFileSync(
    join(records, 'app.json'),
    `${JSON.stringify(
      {
        id: 'app',
        digest: `sha256:${'a'.repeat(64)}`,
        platforms: [
          { platform: 'linux/amd64', digest: `sha256:${'b'.repeat(64)}` },
          { platform: 'linux/arm64', digest: `sha256:${'c'.repeat(64)}` },
        ],
      },
      null,
      2
    )}\n`
  );
  const output = join(repoRoot, 'release-notes.md');
  const result = runNotes([
    '--repo-root',
    repoRoot,
    '--tag',
    tag,
    '--records',
    records,
    '--checksum',
    'abc123',
    '--visibility',
    'public',
    '--sha',
    'd'.repeat(40),
    '--run-url',
    'https://github.com/example/openkit/actions/runs/1',
    '--output',
    output,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const notes = readFileSync(output, 'utf8');
  assert.match(notes, /supported Worker Agent execution is not yet release-ready/);
  assert.match(notes, /Shipped the notes fix\./);
  assert.match(notes, /R001 remains open\./);
  assert.match(notes, new RegExp(`sha256:${'b'.repeat(64)}`));
  assert.match(notes, new RegExp(`sha256:${'c'.repeat(64)}`));
});

/**
 * Writes one image record whose markdown reuse line is the only varying field.
 *
 * @param {string} repoRoot Fixture root.
 * @param {string} reused `true` or `false`.
 * @returns {string} Record directory.
 */
function writeRecords(repoRoot, reused) {
  const records = join(repoRoot, 'release-records');
  mkdirSync(records, { recursive: true });
  writeFileSync(
    join(records, 'app.md'),
    `### app

- Image: \`ghcr.io/example/openkit-app\`
- Digest: \`sha256:${'a'.repeat(64)}\`
- Platform manifest \`linux/amd64\`: \`sha256:${'b'.repeat(64)}\`
- Platform manifest \`linux/arm64\`: \`sha256:${'c'.repeat(64)}\`
- Reused immutable release identity: \`${reused}\`
- Tags:
  - \`ghcr.io/example/openkit-app:${tag}\`
`
  );
  writeFileSync(
    join(records, 'app.json'),
    `${JSON.stringify(
      {
        digest: `sha256:${'a'.repeat(64)}`,
        id: 'app',
        platforms: [
          { digest: `sha256:${'b'.repeat(64)}`, platform: 'linux/amd64' },
          { digest: `sha256:${'c'.repeat(64)}`, platform: 'linux/arm64' },
        ],
      },
      null,
      2
    )}\n`
  );
  return records;
}

/**
 * Generates notes for one reuse disposition.
 *
 * @param {string} reused `true` or `false`.
 * @returns {string} Generated notes.
 */
function generateNotes(reused) {
  const repoRoot = fixtureRoot();
  writeInput(repoRoot, validInput);
  const records = writeRecords(repoRoot, reused);
  const output = join(repoRoot, 'release-notes.md');
  const result = runNotes([
    '--checksum',
    'abc123',
    '--output',
    output,
    '--records',
    records,
    '--repo-root',
    repoRoot,
    '--run-url',
    'https://github.com/example/openkit/actions/runs/1',
    '--sha',
    'd'.repeat(40),
    '--tag',
    tag,
    '--visibility',
    'public',
  ]);
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output, 'utf8');
}

test('release notes for an initial publication and a same-tag reuse are equal', () => {
  assert.equal(generateNotes('false'), generateNotes('true'));
});

test('release notes check rejects a hidden or non-exact heading', () => {
  const cases = [
    [`${validInput}\n##\tOther\n`, /extra level-2 heading: Other/],
    [`${validInput}\n ## Other\n`, /extra level-2 heading: Other/],
    [`${validInput}\n##\n`, /empty level-2 heading/],
    [
      `## Changes since the previous candidate

Shipped the notes fix.

\`\`\`
## Known issues

R001 remains open.
`,
      /fence opener/,
    ],
    [`${validInput}========\n`, /setext heading underline/],
  ];
  for (const [body, pattern] of cases) {
    const repoRoot = fixtureRoot();
    writeInput(repoRoot, body);
    const result = runNotes(['--check', '--repo-root', repoRoot, '--tag', tag]);
    assert.notEqual(result.status, 0, body);
    assert.match(result.stderr, pattern, result.stderr);
  }

  const allowed = fixtureRoot();
  writeInput(
    allowed,
    `## Changes since the previous candidate

Shipped the notes fix.

### Detail

## Known issues

R001 remains open.
`
  );
  const level3 = runNotes(['--check', '--repo-root', allowed, '--tag', tag]);
  assert.equal(level3.status, 0, level3.stderr);
});

test('release notes check rejects trailing space or tab on a required heading', () => {
  const heading = '## Known issues';
  const bodies = [
    `## Changes since the previous candidate\n\nShipped the notes fix.\n\n${heading}  \n\nR001 remains open.\n`,
    `## Changes since the previous candidate\n\nShipped the notes fix.\n\n${heading}\t\n\nR001 remains open.\n`,
  ];
  for (const body of bodies) {
    const repoRoot = fixtureRoot();
    writeInput(repoRoot, body);
    const result = runNotes(['--check', '--repo-root', repoRoot, '--tag', tag]);
    assert.notEqual(result.status, 0, JSON.stringify(body));
    assert.match(result.stderr, /extra level-2 heading: Known issues/);
  }
});

test('release notes compare mode accepts one matching body and rejects a different body', () => {
  const repoRoot = fixtureRoot();
  writeInput(repoRoot, validInput);
  const records = writeRecords(repoRoot, 'false');
  const output = join(repoRoot, 'release-notes.md');
  const generated = runNotes([
    '--checksum',
    'abc123',
    '--output',
    output,
    '--records',
    records,
    '--repo-root',
    repoRoot,
    '--run-url',
    'https://github.com/example/openkit/actions/runs/1',
    '--sha',
    'd'.repeat(40),
    '--tag',
    tag,
    '--visibility',
    'public',
  ]);
  assert.equal(generated.status, 0, generated.stderr);
  const notes = readFileSync(output, 'utf8');
  const body = join(repoRoot, 'release-body.md');
  writeFileSync(body, `${notes}\n`);
  const args = [
    '--checksum',
    'abc123',
    '--compare-body',
    body,
    '--records',
    records,
    '--repo-root',
    repoRoot,
    '--run-url',
    'https://github.com/example/openkit/actions/runs/1',
    '--sha',
    'd'.repeat(40),
    '--tag',
    tag,
    '--visibility',
    'public',
  ];
  const match = runNotes(args);
  assert.equal(match.status, 0, match.stderr);
  writeFileSync(body, `${notes}\nchanged\n`);
  const differ = runNotes(args);
  assert.notEqual(differ.status, 0);
  assert.match(differ.stderr, /GitHub Release notes differ from the generated notes/);
});

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { runBiomeCheck } from '../scripts/check-biome.mjs';

function fakeChild({ status = 0, signal = null, stdout = '', stderr = '' }) {
  const child = new EventEmitter();
  child.stdout = Readable.from(stdout ? [stdout] : []);
  child.stderr = Readable.from(stderr ? [stderr] : []);
  queueMicrotask(() => {
    child.emit('exit', signal ? null : status, signal);
  });
  return child;
}

test('repository Biome commands use the checked-file guard', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.match(scripts['check:repo'], /node scripts\/check-biome\.mjs \./u);
  assert.match(
    scripts['format:check'],
    /node scripts\/check-biome\.mjs --formatter-enabled=true --linter-enabled=false \./u
  );
});

test('pinned Biome scans a checkout beneath temp while excluding checkout temp evidence', () => {
  const base = mkdtempSync(join(tmpdir(), 'openkit-biome-scope-'));
  try {
    const checkout = join(base, 'temp', 'checkout');
    mkdirSync(join(checkout, 'temp'), { recursive: true });
    copyFileSync('biome.json', join(checkout, 'biome.json'));
    writeFileSync(join(checkout, 'example.js'), 'export const kept = 1;\n');
    writeFileSync(join(checkout, 'temp', 'evidence.js'), 'this is not valid javascript\n');
    const result = spawnSync(
      'pnpm',
      ['exec', 'biome', 'check', '--config-path', checkout, checkout, '--verbose'],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /example\.js/u);
    assert.doesNotMatch(result.stdout, /evidence\.js/u);
    assert.match(result.stderr, /Checked 2 files in /u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a successful zero-file Biome scan is refused as source verification', async () => {
  const result = await runBiomeCheck(['.'], {
    spawn: () =>
      fakeChild({
        status: 0,
        stderr: 'Checked 0 files in 1ms. No fixes applied.\n',
      }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /zero files.*refus/iu);
});

test('Biome arguments and a positive checked-file result pass through unchanged', async () => {
  const calls = [];
  const result = await runBiomeCheck(['--formatter-enabled=true', '--linter-enabled=false', '.'], {
    spawn: (...args) => {
      calls.push(args);
      return fakeChild({
        status: 0,
        stdout: 'kept stdout\n',
        stderr: 'Checked 2 files in 1ms. No fixes applied.\n',
      });
    },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'kept stdout\n');
  assert.equal(result.stderr, 'Checked 2 files in 1ms. No fixes applied.\n');
  assert.deepEqual(calls, [
    [
      'pnpm',
      ['exec', 'biome', 'check', '--formatter-enabled=true', '--linter-enabled=false', '.'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ],
  ]);
});

test('a missing checked-file count or Biome failure cannot become a pass', async () => {
  const missing = await runBiomeCheck(['.'], {
    spawn: () => fakeChild({ status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /did not report its checked-file count/u);

  const failed = await runBiomeCheck(['.'], {
    spawn: () =>
      fakeChild({
        status: 7,
        stderr: 'Checked 0 files in 1ms. No fixes applied.\n',
      }),
  });
  assert.equal(failed.status, 7);
  assert.doesNotMatch(failed.stderr, /zero files.*refus/iu);
});

test('a large child result keeps its exit status and both output streams', async () => {
  const bytes = 67174400;
  const result = await runBiomeCheck(['.'], {
    spawn: () =>
      spawn(process.execPath, [
        '-e',
        `process.stdout.write(Buffer.alloc(${bytes}, 97), () => process.exit(7));`,
      ]),
  });
  assert.equal(result.status, 7);
  assert.equal(Buffer.byteLength(result.stdout), bytes);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stderr, /ENOBUFS/u);
});

test('SIGTERM keeps the signal exit status 143', async () => {
  const result = await runBiomeCheck(['.'], {
    spawn: () => spawn(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']),
  });
  assert.equal(result.status, 143);
  assert.doesNotMatch(result.stderr, /terminated by signal|ENOBUFS/u);
});

test('a colored Biome summary counts checked files and keeps its original bytes', async () => {
  const base = mkdtempSync(join(tmpdir(), 'openkit-biome-color-'));
  try {
    const file = join(base, 'example.js');
    writeFileSync(file, 'export const kept = 1;\n');
    const direct = spawnSync('pnpm', ['exec', 'biome', 'check', '--colors=force', file], {
      encoding: 'utf8',
    });
    assert.equal(direct.status, 0, direct.stderr);
    const result = await runBiomeCheck(['--colors=force', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, direct.stdout);
    assert.equal(result.stderr, direct.stderr);
    const esc = String.fromCharCode(0x1b);
    const coloredCount = `${esc}[34mChecked 1 file in `;
    assert.equal(result.stderr.includes(coloredCount), true);

    const coloredZero = [
      `${esc}[0m${esc}[34mChecked 0 files in 3`,
      `${esc}[0m${esc}[0m${esc}[2m${esc}[34mms${esc}[0m.\n`,
    ].join('');
    const refused = await runBiomeCheck(['.'], {
      spawn: () => fakeChild({ status: 0, stderr: coloredZero }),
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /zero files.*refus/iu);
    assert.equal(refused.stderr.includes(coloredZero), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

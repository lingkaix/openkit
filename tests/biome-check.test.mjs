import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runBiomeCheck } from '../scripts/check-biome.mjs';

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

test('a successful zero-file Biome scan is refused as source verification', () => {
  const result = runBiomeCheck(['.'], {
    spawn: () => ({
      status: 0,
      stdout: '',
      stderr: 'Checked 0 files in 1ms. No fixes applied.\n',
    }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /zero files.*refus/iu);
});

test('Biome arguments and a positive checked-file result pass through unchanged', () => {
  const calls = [];
  const result = runBiomeCheck(['--formatter-enabled=true', '--linter-enabled=false', '.'], {
    spawn: (...args) => {
      calls.push(args);
      return {
        status: 0,
        stdout: 'kept stdout\n',
        stderr: 'Checked 2 files in 1ms. No fixes applied.\n',
      };
    },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'kept stdout\n');
  assert.equal(result.stderr, 'Checked 2 files in 1ms. No fixes applied.\n');
  assert.deepEqual(calls, [
    [
      'pnpm',
      ['exec', 'biome', 'check', '--formatter-enabled=true', '--linter-enabled=false', '.'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ],
  ]);
});

test('a missing checked-file count or Biome failure cannot become a pass', () => {
  const missing = runBiomeCheck(['.'], {
    spawn: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /did not report its checked-file count/u);

  const failed = runBiomeCheck(['.'], {
    spawn: () => ({
      status: 7,
      stdout: '',
      stderr: 'Checked 0 files in 1ms. No fixes applied.\n',
    }),
  });
  assert.equal(failed.status, 7);
  assert.doesNotMatch(failed.stderr, /zero files.*refus/iu);
});

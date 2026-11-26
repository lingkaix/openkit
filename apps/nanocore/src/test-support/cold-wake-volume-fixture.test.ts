import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import {
  assertColdWakeVolumeBytes,
  seedColdWakeVolumeFixture,
} from './cold-wake-volume-fixture.js';

function moveRetainedVolume() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'openkit-cold-wake-'));
  onTestFinished(() => rmSync(tempRoot, { recursive: true, force: true }));
  const originalRoot = join(tempRoot, 'original');
  const successorRoot = join(tempRoot, 'successor');
  mkdirSync(originalRoot);
  const expected = seedColdWakeVolumeFixture(originalRoot);
  renameSync(originalRoot, successorRoot);
  return { successorRoot, expected };
}

it('checks dirty, ignored and untracked bytes at the successor root', () => {
  const { successorRoot, expected } = moveRetainedVolume();
  const status = execFileSync('git', ['status', '--porcelain=v1', '--ignored'], {
    cwd: successorRoot,
    encoding: 'utf8',
  });
  expect(status.split('\n')).toEqual(
    expect.arrayContaining([' M README.md', '!! ignored.bin', '?? untracked.bin'])
  );
  expect(() => assertColdWakeVolumeBytes(successorRoot, expected)).not.toThrow();
});

it('reports altered tracked bytes even when the file size matches', () => {
  const { successorRoot, expected } = moveRetainedVolume();
  writeFileSync(join(successorRoot, 'README.md'), '# Fixture?\n');
  expect(() => assertColdWakeVolumeBytes(successorRoot, expected)).toThrow(
    'Cold wake changed bytes at README.md'
  );
});

it.each(['ignored.bin', 'untracked.bin'])('reports a missing %s path', (path) => {
  const { successorRoot, expected } = moveRetainedVolume();
  const missing = join(successorRoot, path);
  rmSync(missing);
  expect(() => assertColdWakeVolumeBytes(successorRoot, expected)).toThrow(missing);
});

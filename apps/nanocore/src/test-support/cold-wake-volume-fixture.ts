import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedWritableGitRepository } from './git-repository.js';

/**
 * Seeds disposable work before sleep and captures the bytes expected after wake.
 * @param volumeRoot An empty, writable directory on the retained Volume.
 */
export function seedColdWakeVolumeFixture(volumeRoot: string): ReadonlyMap<string, Buffer> {
  seedWritableGitRepository(volumeRoot);
  const gitInfo = join(volumeRoot, '.git', 'info');
  mkdirSync(gitInfo, { recursive: true });
  appendFileSync(join(gitInfo, 'exclude'), '\n/ignored.bin\n');

  const bytes = new Map([
    ['README.md', Buffer.from('# Fixture!\n')],
    ['ignored.bin', Buffer.from([0x00, 0x80, 0xff])],
    ['untracked.bin', Buffer.from([0xff, 0x01, 0x00])],
  ]);
  for (const [path, contents] of bytes) {
    writeFileSync(join(volumeRoot, path), contents);
  }
  return bytes;
}

/** Checks the original paths and exact bytes under the successor's Volume root. */
export function assertColdWakeVolumeBytes(
  volumeRoot: string,
  expectedBytes: ReadonlyMap<string, Buffer>
): void {
  for (const [path, expected] of expectedBytes) {
    assert.ok(
      readFileSync(join(volumeRoot, path)).equals(expected),
      `Cold wake changed bytes at ${path}`
    );
  }
}

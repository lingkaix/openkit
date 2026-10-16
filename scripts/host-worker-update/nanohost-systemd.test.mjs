// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The supported systemd/cgroup posture is Linux-specific; no host manager is contacted.
if (process.platform === 'linux') {
  test('NanoHost maintenance requires current fencing and persistent inhibition', () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'nanohost-systemd-test-'));
    try {
      const result = spawnSync(
        '/usr/bin/python3',
        ['-I', '-B', fileURLToPath(new URL('./nanohost-systemd.test.py', import.meta.url))],
        {
          env: { ...process.env, TMPDIR: temporary },
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        }
      );
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

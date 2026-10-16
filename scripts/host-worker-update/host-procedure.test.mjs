// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Linux fixtures model external manager facts; no installed service is contacted.
if (process.platform === 'linux') {
  test('Fixed operator procedure keeps requests closed and bounds real child processes', () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'host-procedure-test-'));
    try {
      const result = spawnSync(
        '/usr/bin/python3',
        ['-I', '-B', fileURLToPath(new URL('./host-procedure.test.py', import.meta.url))],
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

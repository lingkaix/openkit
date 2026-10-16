// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// NanoHost replacement admits Linux; descriptor-relative fault observation uses procfs.
if (process.platform === 'linux') {
  /** Run the real filesystem custody regression without a service manager or host effects. */
  test('NanoHost replacement preserves verified custody before vacancy', () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'openkit-payload-custody-'));
    try {
      const result = spawnSync(
        '/usr/bin/python3',
        ['-I', '-B', fileURLToPath(new URL('./nanohost-replacement.test.py', import.meta.url))],
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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { scripts } = JSON.parse(
  readFileSync(new URL('../apps/nanocore/package.json', import.meta.url), 'utf8')
);

for (const command of ['start', 'dev']) {
  test(`source ${command} defaults the child pool before Node starts and preserves an override`, () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-source-launch-'));
    try {
      // Observe the child of the real package command without starting a server or watcher.
      const probe = join(root, 'probe.mjs');
      writeFileSync(probe, 'process.stdout.write(process.env.UV_THREADPOOL_SIZE ?? "unset");\n');
      const shim = `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${probe.replaceAll("'", "'\\''")}'\n`;
      for (const executable of ['node', 'tsx'])
        writeFileSync(join(root, executable), shim, { mode: 0o755 });
      for (const [incoming, expected] of [
        [undefined, '16'],
        ['7', '7'],
      ]) {
        const env = { PATH: root };
        if (incoming !== undefined) env.UV_THREADPOOL_SIZE = incoming;
        const child = spawnSync('/bin/sh', ['-c', scripts[command]], {
          cwd: root,
          env,
          encoding: 'utf8',
          timeout: 10_000,
        });
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout, expected);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

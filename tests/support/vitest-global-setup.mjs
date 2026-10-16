import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Isolate worker fixtures for one invocation and reclaim them after success or failure. */
export default function setup() {
  const names = ['TMPDIR', 'TMP', 'TEMP'];
  const previous = names.map((name) => process.env[name]);
  const root = mkdtempSync(join(tmpdir(), 'openkit-vitest-'));
  for (const name of names) process.env[name] = root;
  return () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } finally {
      for (const [index, name] of names.entries()) {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      }
    }
  };
}

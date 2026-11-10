import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readWorkerReleaseIdentity } from './release-identity.js';

it('reads tagged and known untagged immutable builds without environment identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-worker-identity-'));
  const path = join(root, 'identity.json');
  try {
    for (const releaseTag of [null, 'v0.1.0-rc.1']) {
      const identity = { sourceCommit: 'a'.repeat(40), releaseTag };
      await writeFile(path, JSON.stringify({ ...identity, future: 'inert' }));
      expect(await readWorkerReleaseIdentity(path)).toEqual(identity);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps missing, malformed, unknown and oversized build metadata unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-worker-identity-'));
  const path = join(root, 'identity.json');
  try {
    expect(await readWorkerReleaseIdentity(path)).toBeNull();
    for (const bytes of [
      '{',
      JSON.stringify({ sourceCommit: null, releaseTag: null }),
      JSON.stringify({ sourceCommit: 'A'.repeat(40), releaseTag: null }),
      JSON.stringify({ sourceCommit: 'a'.repeat(40) }),
      JSON.stringify({ sourceCommit: 'a'.repeat(40), releaseTag: 1 }),
      JSON.stringify({ sourceCommit: 'a'.repeat(40), releaseTag: null, junk: 'x'.repeat(4096) }),
    ]) {
      await writeFile(path, bytes);
      expect(await readWorkerReleaseIdentity(path)).toBeNull();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

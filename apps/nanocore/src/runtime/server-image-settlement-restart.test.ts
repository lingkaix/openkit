import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { testEntityId } from '../test-support/entity-ids.js';

it('settles a retained server-only image result through ordinary discovery after Core process loss', () => {
  const root = mkdtempSync(join(tmpdir(), 'server-image-restart-'));
  const identity = {
    authoredArtifactId: testEntityId('ar', 'server_image_restart'),
    authoredArtifactVersion: 1,
    authoredContentDigest: `sha256:${'a'.repeat(64)}`,
    inputDigest: `sha256:${'b'.repeat(64)}`,
  };
  const requestId = 'e'.repeat(64);
  const result = { requestId, digest: `sha256:${'c'.repeat(64)}` };
  const input = JSON.stringify({
    effect: {
      kind: 'image.acquire',
      requestId,
      input: { imageReference: 'openkit:test' },
      imageSettlement: identity,
    },
    result,
  });
  const probe = (phase: string) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../test-support/pending-publication-crash.ts', import.meta.url)),
        'server-image',
        phase,
        root,
        input,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 }
    );
  try {
    const crashed = probe('before-local-result');
    expect(crashed.error, crashed.stderr).toBeUndefined();
    expect(crashed.signal, `${crashed.stdout}\n${crashed.stderr}`).toBe('SIGKILL');
    expect(JSON.parse(crashed.stdout.trim().split('\n').at(-1)!)).toEqual({
      checkpoint: 'server-image-result-before-local-store',
      command: { imageReference: 'openkit:test', requestId },
      workspaceScopes: [],
    });
    const restarted = probe('ordinary-restart');
    expect(restarted.error, restarted.stderr).toBeUndefined();
    expect(restarted.status, `${restarted.stdout}\n${restarted.stderr}`).toBe(0);
    const cold = JSON.parse(restarted.stdout.trim().split('\n').at(-1)!);
    expect(cold.workspaceScopes).toEqual([]);
    expect(cold.ordinaryPass.startedTurns).toEqual([]);
    expect(cold.nextCommand, 'a lost result cannot justify another image acquisition').toBeNull();
    expect
      .soft(cold.resultError, 'ordinary server discovery must admit the retained exact result')
      .toBeNull();
    expect.soft(cold.settlement).toEqual({
      ...identity,
      requestId,
      operation: 'image.acquire',
      outcome: { kind: 'success', imageDigest: result.digest },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

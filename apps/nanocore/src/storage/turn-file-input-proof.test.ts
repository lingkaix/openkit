// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDemoStore } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID } from '../test-support/local-user.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  turnFilePayloadPath,
  verifyTurnFileInput,
  verifyTurnFileInputs,
} from './workspace-file-records.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses the real Turn writer and exact original payloads, with names kept outside path identity. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'turn-input-proof-'));
  roots.push(root);
  const store = createDemoStore({ dataRoot: root });
  const workspace = store.listWorkspaces().find((candidate) => candidate.kind === 'code')!;
  const thread = store.createThread(workspace.id, 'Selected input proof');
  const bodies = [Buffer.from([0, 0xff, 0x80]), Buffer.from('another original')];
  const sources = bodies.map((body, ordinal) => {
    const path = join(root, `source-${ordinal}`);
    writeFileSync(path, body);
    return path;
  });
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    'Read exact inputs',
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    {
      fileInputs: bodies.map((body, ordinal) => ({
        name: ordinal === 0 ? '../../display-name' : 'another.txt',
        mediaType: 'application/octet-stream',
        sizeBytes: body.length,
        contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      })),
      filePayloadPaths: sources,
      fileWriteAdmission: new FileStorageAdmission(root, () => 0n),
    }
  );
  const workspaceRoot = join(root, 'workspaces', workspace.id);
  return {
    root,
    turn,
    workspaceRoot,
    path: (ordinal: number) => turnFilePayloadPath(workspaceRoot, thread.id, turn.id, ordinal),
  };
}

it('verifies the addressed original without rescanning an unrelated corrupt input', () => {
  const state = fixture();
  expect(() => verifyTurnFileInputs(state.workspaceRoot, state.turn)).not.toThrow();
  writeFileSync(state.path(1), 'corrupt unrelated input');
  expect(() => verifyTurnFileInput(state.workspaceRoot, state.turn, 0)).not.toThrow();
  expect(() => verifyTurnFileInputs(state.workspaceRoot, state.turn)).toThrow(/recovery_required/);
  writeFileSync(state.path(0), Buffer.from([1, 2, 3]));
  expect(() => verifyTurnFileInput(state.workspaceRoot, state.turn, 0)).toThrow(
    /recovery_required/
  );
});

it.each(['missing', 'symlink', 'hardlink'] as const)('refuses a selected %s original', (kind) => {
  const state = fixture();
  if (kind === 'hardlink') linkSync(state.path(0), join(state.root, 'linked-owner'));
  else {
    rmSync(state.path(0));
    if (kind === 'symlink') symlinkSync(state.path(1), state.path(0));
  }
  expect(() => verifyTurnFileInput(state.workspaceRoot, state.turn, 0)).toThrow();
});

it.each([-1, 0.5, 2, Number.MAX_SAFE_INTEGER])('refuses an unavailable ordinal %s', (ordinal) => {
  const state = fixture();
  expect(() => verifyTurnFileInput(state.workspaceRoot, state.turn, ordinal)).toThrow(
    /unavailable/
  );
});

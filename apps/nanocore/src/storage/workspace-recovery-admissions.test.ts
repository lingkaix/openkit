// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import {
  prepareRecoveryAdmission,
  type RecoveryProof,
  readRecoveryAdmission,
} from './workspace-recovery-admissions.js';
import { runWorkspaceRecoveryCli, WorkspaceRecoveryError } from './workspace-recovery-cli.js';

let root: string;
let core: CoreDb;
const requestId = randomUUID();
let original: RecoveryProof;
let candidate: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'recovery-intent-'));
  const source = join(root, 'source');
  await createDemoStore({ dataRoot: source });
  const sourceCore = openCoreDb(source);
  const owner = ensureLocalUser(sourceCore);
  recordWorkspaceOwnerMembership({
    coreDb: sourceCore,
    workspaceId: DEMO_WORKSPACE_ID,
    ownerUserId: owner,
  });
  sourceCore.sqlite.close();
  await shutdownControlStoreWorkerClient();
  const releaseIdentityPath = join(root, 'release.json');
  writeFileSync(
    releaseIdentityPath,
    JSON.stringify({ releaseTag: 'v0.1.0-rc.11', sourceCommit: '1'.repeat(40) })
  );
  const bundle = join(root, 'bundle');
  const backupId = allocateEntityId('wsbak');
  const capture = await runWorkspaceRecoveryCli(
    [
      'capture',
      '--source-data-root',
      source,
      '--workspace-id',
      DEMO_WORKSPACE_ID,
      '--expected-source-deployment-id',
      readDataRootLayoutMarker(source).deploymentId,
      '--backup-id',
      backupId,
      '--bundle-root',
      bundle,
      '--purpose',
      'move',
    ],
    () => {},
    { releaseIdentityPath }
  );
  await runWorkspaceRecoveryCli(
    [
      'move-out',
      '--data-root',
      source,
      '--workspace-id',
      DEMO_WORKSPACE_ID,
      '--backup-id',
      backupId,
      '--bundle-root',
      bundle,
      '--expected-revision',
      String(capture.capture!.capturedRevision),
    ],
    () => {},
    { releaseIdentityPath }
  );
  const target = join(root, 'target');
  core = openCoreDb(target);
  applyMigrations(core);
  const targetOwner = ensureLocalUser(core);
  core.sqlite.close();
  const result = await runWorkspaceRecoveryCli(
    [
      'move-in',
      '--data-root',
      target,
      '--bundle-root',
      bundle,
      '--request-id',
      requestId,
      '--target-owner-id',
      targetOwner,
      '--member-map',
      `${owner}=${targetOwner}`,
    ],
    () => {},
    { releaseIdentityPath }
  );
  expect(result.disposition).toBe('imported');
  core = openCoreDb(target);
  const admitted = readRecoveryAdmission(core, requestId)!;
  original = structuredClone(admitted.proof);
  candidate = admitted.candidate_ref;
}, 120_000);

afterEach(() => {
  core.sqlite
    .prepare('UPDATE workspace_recovery_admissions SET proof_json=? WHERE admission_id=?')
    .run(JSON.stringify(original), requestId);
});
afterAll(async () => {
  core?.sqlite.close();
  await shutdownControlStoreWorkerClient();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Corrupts a genuine owner-produced record to exercise restart admission, not bundle parsing. */
function retain(input: Record<string, unknown>): void {
  core.sqlite
    .prepare('UPDATE workspace_recovery_admissions SET proof_json=? WHERE admission_id=?')
    .run(JSON.stringify({ ...original, input }), requestId);
}
/** The owner's bounded refusal must precede recovery use of the retained authority. */
function refuses(body: () => unknown): void {
  let error: unknown;
  try {
    body();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(WorkspaceRecoveryError);
  expect(error).toMatchObject({ code: 'recovery-required' });
}

// Target Admission And Rebinding binds the original request, owner and explicit injective map.
// Contract Evolution closes unknown authority-bearing intent, while descriptive additions are ignored.
const corruptions = [
  ['unknown command', { command: 'resume-with-grants' }],
  ['different request identity', { requestId: randomUUID() }],
  ['different owning data root', { dataRoot: '/unrelated-recovery-root' }],
  ['missing owner', { targetOwnerId: undefined }],
  ['wrong owner identity kind', { targetOwnerId: DEMO_WORKSPACE_ID }],
  ['missing explicit map', { memberMappings: undefined }],
  [
    'malformed account pair',
    {
      memberMappings: [{ sourceAccountId: DEMO_WORKSPACE_ID, targetAccountId: DEMO_WORKSPACE_ID }],
    },
  ],
  ['unknown effect-bearing input', { grantUnmappedAudiences: true }],
] as const;

describe('retained recovery admission intent', () => {
  it('reads the exact original MOVE identity and tolerates descriptive manifest annotations', () => {
    core.sqlite
      .prepare('UPDATE workspace_recovery_admissions SET proof_json=? WHERE admission_id=?')
      .run(
        JSON.stringify({
          ...original,
          manifest: { ...original.manifest, operatorNote: 'descriptive only' },
        }),
        requestId
      );
    expect(readRecoveryAdmission(core, requestId)?.proof.input).toEqual(original.input);
    expect(readRecoveryAdmission(core, requestId)?.proof.capture.manifestDigest).toBe(
      original.capture.manifestDigest
    );
  });

  it.each(corruptions)('refuses retained %s before restart recovery', (_name, changed) => {
    retain({ ...original.input, ...changed });
    refuses(() => readRecoveryAdmission(core, requestId));
  });

  it('refuses two explicit sources that share the resolved target owner', () => {
    const input = original.input;
    if (input.command !== 'move-in') throw new Error('Expected genuine MOVE target admission.');
    retain({
      ...input,
      memberMappings: [
        ...input.memberMappings,
        { sourceAccountId: allocateEntityId('usr'), targetAccountId: input.targetOwnerId },
      ],
    });
    refuses(() => readRecoveryAdmission(core, requestId));
  });

  it('refuses a retained capture identity that contradicts the original manifest', () => {
    core.sqlite
      .prepare('UPDATE workspace_recovery_admissions SET proof_json=? WHERE admission_id=?')
      .run(
        JSON.stringify({
          ...original,
          capture: { ...original.capture, backupId: allocateEntityId('wsbak') },
        }),
        requestId
      );
    refuses(() => readRecoveryAdmission(core, requestId));
  });

  it('refuses malformed intent before the existing writer persists ownership', () => {
    core.sqlite.exec('BEGIN');
    try {
      core.sqlite
        .prepare('DELETE FROM workspace_recovery_admissions WHERE admission_id=?')
        .run(requestId);
      const proof = {
        ...original,
        input: { ...original.input, command: 'resume-with-grants' },
      } as unknown as RecoveryProof;
      refuses(() => prepareRecoveryAdmission(core, requestId, candidate, proof));
      expect(
        core.sqlite
          .prepare('SELECT 1 FROM workspace_recovery_admissions WHERE admission_id=?')
          .get(requestId)
      ).toBeUndefined();
    } finally {
      core.sqlite.exec('ROLLBACK');
    }
  });
});

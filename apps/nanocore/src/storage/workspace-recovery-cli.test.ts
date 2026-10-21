import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDataRootLock } from '../bootstrap/lock.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import {
  parseWorkspaceBackupManifest,
  parseWorkspaceBackupSeal,
} from './workspace-backup-bundle.js';
import {
  parseWorkspaceRecoveryArgs,
  runWorkspaceRecoveryCli,
  type WorkspaceRecoveryCliArgs,
  type WorkspaceRecoveryCliReport,
  WorkspaceRecoveryError,
} from './workspace-recovery-cli.js';

// D0 release-policy ruling (12:23Z): the installed parser reads only this case's private identity.
const runCli: (
  argv: readonly string[],
  write?: (line: string) => void,
  deps?: { releaseIdentityPath?: string }
) => Promise<WorkspaceRecoveryCliReport> = runWorkspaceRecoveryCli;

// WM Operator Contract and the D0 callable grammar, including the H1 parent-lock ruling.
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const deploymentId = 'dep_00000000-0000-7000-8000-000000000002';
const backupId = 'wsbak_00000000-0000-7000-8000-000000000003';
const ownerId = 'usr_00000000-0000-7000-8000-000000000004';
const sourceMemberId = 'usr_00000000-0000-7000-8000-000000000005';
const targetMemberId = 'usr_00000000-0000-7000-8000-000000000006';
const requestId = '00000000-0000-4000-8000-000000000007';
const roots: string[] = [];
const capture = [
  'capture',
  '--source-data-root',
  '/source',
  '--workspace-id',
  workspaceId,
  '--expected-source-deployment-id',
  deploymentId,
  '--bundle-root',
  '/bundle',
  '--purpose',
  'backup',
];
const restore = [
  'restore',
  '--data-root',
  '/target',
  '--bundle-root',
  '/bundle',
  '--workspace-id',
  workspaceId,
  '--request-id',
  requestId,
];
const moveIn = [
  'move-in',
  '--data-root',
  '/target',
  '--bundle-root',
  '/bundle',
  '--request-id',
  requestId,
  '--target-owner-id',
  ownerId,
];
const reactivate = [
  'reactivate',
  '--data-root',
  '/source',
  '--workspace-id',
  workspaceId,
  '--backup-id',
  backupId,
  '--expected-revision',
  '0',
  '--acknowledge-target-fenced',
  '--acknowledge-copies-retired',
];

/** Owns only disposable fixture roots; the parser must never touch these paths. */
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'd0-cli-'));
  roots.push(value);
  return value;
}

/** Supplies the installed identity without reading or writing the machine-wide release file. */
function installedRelease(parent: string): { releaseIdentityPath: string } {
  const releaseIdentityPath = join(parent, 'release-identity.json');
  writeFileSync(
    releaseIdentityPath,
    JSON.stringify({ releaseTag: 'v0.1.0-rc.11', sourceCommit: '1'.repeat(40) })
  );
  return { releaseIdentityPath };
}

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('D0-4: strict offline command grammar (WM Operator Contract)', () => {
  const accepted: { name: string; argv: string[]; expected: WorkspaceRecoveryCliArgs }[] = [
    {
      name: 'capture stopped root with deferred backup identity allocation',
      argv: capture,
      expected: {
        command: 'capture',
        source: { kind: 'stopped-data-root', dataRoot: '/source' },
        workspaceId,
        expectedSourceDeploymentId: deploymentId,
        bundleRoot: '/bundle',
        purpose: 'backup',
      },
    },
    {
      name: 'capture H1 parent with explicit identity and MOVE purpose',
      argv: [
        '--',
        ...capture.map((value) =>
          value === '--source-data-root'
            ? '--source-backup-root'
            : value === 'backup'
              ? 'move'
              : value
        ),
        '--backup-id',
        backupId,
      ],
      expected: {
        command: 'capture',
        source: { kind: 'data-root-backup', backupRoot: '/source' },
        workspaceId,
        expectedSourceDeploymentId: deploymentId,
        bundleRoot: '/bundle',
        purpose: 'move',
        backupId,
      },
    },
    {
      name: 'verify',
      argv: ['verify', '--bundle-root', '/bundle'],
      expected: { command: 'verify', bundleRoot: '/bundle' },
    },
    {
      name: 'restore defaults to no lost-safety acknowledgement',
      argv: restore,
      expected: {
        command: 'restore',
        dataRoot: '/target',
        bundleRoot: '/bundle',
        workspaceId,
        requestId,
        acknowledgeLostSafety: false,
      },
    },
    {
      name: 'restore explicit lost-safety acknowledgement',
      argv: [...restore, '--acknowledge-lost-safety'],
      expected: {
        command: 'restore',
        dataRoot: '/target',
        bundleRoot: '/bundle',
        workspaceId,
        requestId,
        acknowledgeLostSafety: true,
      },
    },
    {
      name: 'move-out exact revision',
      argv: [
        'move-out',
        '--data-root',
        '/source',
        '--workspace-id',
        workspaceId,
        '--backup-id',
        backupId,
        '--bundle-root',
        '/bundle',
        '--expected-revision',
        '7',
      ],
      expected: {
        command: 'move-out',
        dataRoot: '/source',
        workspaceId,
        backupId,
        bundleRoot: '/bundle',
        expectedRevision: 7,
      },
    },
    {
      name: 'move-in has no inferred members',
      argv: moveIn,
      expected: {
        command: 'move-in',
        dataRoot: '/target',
        bundleRoot: '/bundle',
        requestId,
        targetOwnerId: ownerId,
        memberMappings: [],
      },
    },
    {
      name: 'move-in accepts repeated explicit member maps',
      argv: [
        ...moveIn,
        '--member-map',
        `${sourceMemberId}=${targetMemberId}`,
        '--member-map',
        `${ownerId}=${ownerId}`,
      ],
      expected: {
        command: 'move-in',
        dataRoot: '/target',
        bundleRoot: '/bundle',
        requestId,
        targetOwnerId: ownerId,
        memberMappings: [
          { sourceAccountId: sourceMemberId, targetAccountId: targetMemberId },
          { sourceAccountId: ownerId, targetAccountId: ownerId },
        ],
      },
    },
    ...(['inspect', 'finish', 'abandon'] as const).flatMap((command) => [
      {
        name: `${command} capture`,
        argv: [
          command,
          '--data-root',
          '/source',
          '--workspace-id',
          workspaceId,
          '--backup-id',
          backupId,
        ],
        expected: {
          command,
          dataRoot: '/source',
          workspaceId,
          selection: { kind: 'capture' as const, backupId },
        },
      },
      {
        name: `${command} admission`,
        argv: [
          command,
          '--data-root',
          '/source',
          '--workspace-id',
          workspaceId,
          '--request-id',
          requestId,
        ],
        expected: {
          command,
          dataRoot: '/source',
          workspaceId,
          selection: { kind: 'admission' as const, requestId },
        },
      },
    ]),
    {
      name: 'reactivate requires both acknowledgements and admits revision zero',
      argv: reactivate,
      expected: {
        command: 'reactivate',
        dataRoot: '/source',
        workspaceId,
        backupId,
        expectedRevision: 0,
        acknowledgeTargetFenced: true,
        acknowledgeCopiesRetired: true,
      },
    },
  ];
  it.each(accepted)('D0 grammar: $name', ({ argv, expected }) => {
    expect(parseWorkspaceRecoveryArgs(argv)).toEqual(expected);
  });

  const refused: { name: string; argv: string[] }[] = [
    { name: 'missing command', argv: [] },
    { name: 'unknown command', argv: ['copy'] },
    { name: 'second command', argv: ['verify', '--bundle-root', '/bundle', 'capture'] },
    { name: 'unknown flag', argv: [...capture, '--verified'] },
    { name: 'duplicate scalar', argv: [...capture, '--workspace-id', workspaceId] },
    { name: 'duplicate boolean', argv: [...reactivate, '--acknowledge-copies-retired'] },
    { name: 'missing flag value', argv: ['verify', '--bundle-root'] },
    { name: 'empty path', argv: ['verify', '--bundle-root', ''] },
    { name: 'both capture sources', argv: [...capture, '--source-backup-root', '/parent'] },
    {
      name: 'neither capture source',
      argv: capture.filter((_, index) => index !== 1 && index !== 2),
    },
    {
      name: 'unsupported purpose',
      argv: capture.map((value) => (value === 'backup' ? 'copy' : value)),
    },
    {
      name: 'wrong-kind Workspace identity',
      argv: capture.map((value) => (value === workspaceId ? ownerId : value)),
    },
    {
      name: 'wrong-kind deployment identity',
      argv: capture.map((value) => (value === deploymentId ? workspaceId : value)),
    },
    { name: 'wrong-kind backup identity', argv: [...capture, '--backup-id', deploymentId] },
    {
      name: 'malformed identity',
      argv: capture.map((value) => (value === workspaceId ? 'ws_invalid' : value)),
    },
    { name: 'missing explicit owner', argv: moveIn.slice(0, -2) },
    {
      name: 'malformed owner',
      argv: moveIn.map((value) => (value === ownerId ? workspaceId : value)),
    },
    { name: 'malformed member map', argv: [...moveIn, '--member-map', sourceMemberId] },
    {
      name: 'wrong-kind member map',
      argv: [...moveIn, '--member-map', `${workspaceId}=${targetMemberId}`],
    },
    {
      name: 'both selections',
      argv: [
        'inspect',
        '--data-root',
        '/source',
        '--workspace-id',
        workspaceId,
        '--backup-id',
        backupId,
        '--request-id',
        requestId,
      ],
    },
    {
      name: 'neither selection',
      argv: ['finish', '--data-root', '/source', '--workspace-id', workspaceId],
    },
    {
      name: 'missing fenced acknowledgement',
      argv: reactivate.filter((value) => value !== '--acknowledge-target-fenced'),
    },
    {
      name: 'missing retired acknowledgement',
      argv: reactivate.filter((value) => value !== '--acknowledge-copies-retired'),
    },
    ...['-1', '1.5', '9007199254740992', 'NaN'].map((number) => ({
      name: `invalid revision ${number}`,
      argv: reactivate.map((value) => (value === '0' ? number : value)),
    })),
    ...['--release', '--build-id', '--required-feature', '--supported-database-format'].map(
      (flag) => ({
        name: `forbidden policy override ${flag}`,
        argv: [...capture, flag, 'override'],
      })
    ),
    {
      name: 'backup parent cannot replace current move-out source',
      argv: [
        'move-out',
        '--source-backup-root',
        '/parent',
        '--workspace-id',
        workspaceId,
        '--backup-id',
        backupId,
        '--bundle-root',
        '/bundle',
        '--expected-revision',
        '1',
      ],
    },
  ];
  it.each(refused)('D0 grammar refuses $name with invalid-arguments', ({ argv }) => {
    expect(() => parseWorkspaceRecoveryArgs(argv)).toThrowError(
      expect.objectContaining({ name: 'WorkspaceRecoveryError', code: 'invalid-arguments' })
    );
  });

  it('WM existing-only boundary: parsing a missing path creates nothing', () => {
    const absent = join(root(), 'must-stay-absent');
    expect(parseWorkspaceRecoveryArgs(['verify', '--bundle-root', absent])).toEqual({
      command: 'verify',
      bundleRoot: absent,
    });
    expect(existsSync(absent)).toBe(false);
  });
});

describe('D0-4: real offline capture and verification', () => {
  /** Uses actual native product publication, registry membership and SQLite migrations, then stops the worker. */
  async function stoppedRoot() {
    const parent = root();
    const dataRoot = join(parent, 'source');
    await createDemoStore({ dataRoot });
    const db = openCoreDb(dataRoot);
    try {
      const ownerUserId = ensureLocalUser(db);
      recordWorkspaceOwnerMembership({ coreDb: db, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
    } finally {
      db.sqlite.close();
    }
    await shutdownControlStoreWorkerClient();
    return {
      parent,
      dataRoot,
      deploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      ...installedRelease(parent),
    };
  }

  it.each([
    'backup',
    'move',
  ] as const)('WM capture/seal: CLI %s returns one path-free report and allocates wsbak', async (purpose) => {
    const f = await stoppedRoot();
    const bundleRoot = join(f.parent, 'bundle');
    const lines: string[] = [];
    const report = await runCli(
      [
        'capture',
        '--source-data-root',
        f.dataRoot,
        '--workspace-id',
        workspaceId,
        '--expected-source-deployment-id',
        f.deploymentId,
        '--bundle-root',
        bundleRoot,
        '--purpose',
        purpose,
      ],
      (line) => lines.push(line),
      { releaseIdentityPath: f.releaseIdentityPath }
    );
    expect(report).toMatchObject({
      command: 'capture',
      disposition: purpose === 'backup' ? 'sealed' : 'prepared',
      workspaceId,
      droppedSourceMemberIds: [],
      restrictedRecovery: false,
      capture: {
        workspaceId,
        sourceDeploymentId: f.deploymentId,
        source: { kind: 'stopped-data-root' },
      },
    });
    expect(report.capture!.backupId).toMatch(
      /^wsbak_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(report);
    expect(lines[0]).not.toContain(f.parent);
    expect(lines[0]).not.toContain('Product focus');
    const manifest = parseWorkspaceBackupManifest(
      JSON.parse(readFileSync(join(bundleRoot, 'manifest.json'), 'utf8'))
    );
    expect(manifest.backupId).toBe(report.capture!.backupId);
    expect(manifest.capture.consistency).toBe('quiescent');
    if (purpose === 'move') {
      expect(existsSync(join(bundleRoot, 'seal.json'))).toBe(false);
    } else {
      const seal = parseWorkspaceBackupSeal(
        JSON.parse(readFileSync(join(bundleRoot, 'seal.json'), 'utf8'))
      );
      expect(seal.manifestDigest).toBe(report.capture!.manifestDigest);
      const verifyLines: string[] = [];
      const verification = await runCli(
        ['verify', '--bundle-root', bundleRoot],
        (line) => verifyLines.push(line),
        { releaseIdentityPath: f.releaseIdentityPath }
      );
      expect(verification).toMatchObject({
        command: 'verify',
        disposition: 'verified',
        workspaceId,
        capture: { backupId: manifest.backupId },
        droppedSourceMemberIds: [],
        restrictedRecovery: false,
        nextAction: 'none',
      });
      expect(verifyLines).toHaveLength(1);
      expect(JSON.parse(verifyLines[0]!)).toEqual(verification);
      expect(verifyLines[0]).not.toContain(f.parent);
    }
  }, 120_000);

  it('WM cold exclusion: CLI refuses a held source root with root-locked and no report', async () => {
    const f = await stoppedRoot();
    const lock = acquireDataRootLock(f.dataRoot, { bootId: 'd0-cli-owner' });
    const lines: string[] = [];
    try {
      await expect(
        runCli(
          [
            'capture',
            '--source-data-root',
            f.dataRoot,
            '--workspace-id',
            workspaceId,
            '--expected-source-deployment-id',
            f.deploymentId,
            '--bundle-root',
            join(f.parent, 'bundle'),
            '--purpose',
            'backup',
          ],
          (line) => lines.push(line),
          { releaseIdentityPath: f.releaseIdentityPath }
        )
      ).rejects.toMatchObject({ code: 'root-locked' });
      expect(lines).toEqual([]);
      expect(existsSync(join(f.parent, 'bundle'))).toBe(false);
    } finally {
      lock.release();
    }
  }, 120_000);

  it('WM seal admission: verify refuses an incomplete bundle with invalid-bundle and no disclosure', async () => {
    const parent = root();
    const bundleRoot = join(parent, 'bundle');
    mkdirSync(bundleRoot);
    writeFileSync(join(bundleRoot, 'manifest.json'), '{"private":"UNTRUSTED-CONTENT"}');
    const lines: string[] = [];
    const error: unknown = await runCli(
      ['verify', '--bundle-root', bundleRoot],
      (line) => lines.push(line),
      installedRelease(parent)
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceRecoveryError);
    expect(error).toMatchObject({ code: 'invalid-bundle' });
    expect(String(error)).not.toContain(bundleRoot);
    expect(String(error)).not.toContain('UNTRUSTED-CONTENT');
    expect(lines).toEqual([]);
  });

  it('D0 release ruling: capture with a missing installed identity refuses release-mismatch and writes nothing', async () => {
    const f = await stoppedRoot();
    const bundleRoot = join(f.parent, 'bundle');
    const releaseIdentityPath = join(f.parent, 'missing-identity.json');
    const lines: string[] = [];
    await expect(
      runCli(
        [
          'capture',
          '--source-data-root',
          f.dataRoot,
          '--workspace-id',
          workspaceId,
          '--expected-source-deployment-id',
          f.deploymentId,
          '--bundle-root',
          bundleRoot,
          '--purpose',
          'backup',
        ],
        (line) => lines.push(line),
        { releaseIdentityPath }
      )
    ).rejects.toMatchObject({ code: 'release-mismatch' });
    expect(lines).toEqual([]);
    expect(existsSync(bundleRoot)).toBe(false);
    expect(existsSync(releaseIdentityPath)).toBe(false);
  }, 120_000);
});

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkerLineage } from './transcript.js';
import {
  materializeWorkspaceGitInputs,
  prepareWorkspaceGitSnapshots,
  publishWorkspaceGitSnapshots,
  type WorkspaceGitInput,
} from './workspace-git.js';

const LINEAGE: WorkerLineage = {
  agentSessionId: 'as_workspace_git',
  packageSnapshotId: 'aepsnap_workspace_git',
  requestId: 'req_workspace_git',
  threadId: 'th_workspace_git',
  turnId: 'turn_workspace_git',
  workspaceId: 'ws_workspace_git',
};

const REVIEW_ARTIFACTS = [
  'workspace.patch',
  'workspace.patch.tmp',
  'workspace-changes.json',
  'workspace-changes.json.tmp',
  'workspace-git.index',
  'workspace-git.index.lock',
] as const;

describe('workspace Git materialization', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic-link workspace root without writing through it',
    async () => {
      const boundaryDir = mkdtempSync(join(tmpdir(), 'openkit-workspace-root-link-'));
      const outsideDir = join(boundaryDir, 'outside');
      const workspaceRoot = join(boundaryDir, 'workspace');
      const sessionDir = join(boundaryDir, 'session');
      const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
      mkdirSync(outsideDir);
      mkdirSync(sessionDir);
      writeFixtureFile(outsideDir, 'sentinel', 'outside must stay unchanged\n');
      symlinkSync(outsideDir, workspaceRoot, 'dir');
      const input = createWorkspaceGitInput(
        join(workspaceRoot, 'worktrees', 'main'),
        remote.commit,
        remote.path
      );
      const before = readdirSync(outsideDir);
      let rejection: unknown = null;

      try {
        await materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir);
      } catch (error) {
        rejection = error;
      }

      expect.soft(rejection).toBeInstanceOf(Error);
      expect(readdirSync(outsideDir)).toEqual(before);
      expect(readFileSync(join(outsideDir, 'sentinel'), 'utf8')).toBe(
        'outside must stay unchanged\n'
      );
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a target ancestor symbolic-link before creating an outside descendant',
    async () => {
      const boundaryDir = mkdtempSync(join(tmpdir(), 'openkit-workspace-ancestor-link-'));
      const outsideDir = join(boundaryDir, 'outside');
      const workspaceRoot = join(boundaryDir, 'workspace');
      const sessionDir = join(boundaryDir, 'session');
      const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
      mkdirSync(outsideDir);
      mkdirSync(workspaceRoot);
      mkdirSync(sessionDir);
      writeFixtureFile(outsideDir, 'sentinel', 'outside must stay unchanged\n');
      symlinkSync(outsideDir, join(workspaceRoot, 'worktrees'), 'dir');
      const input = createWorkspaceGitInput(
        join(workspaceRoot, 'worktrees', 'new-parent', 'main'),
        remote.commit,
        remote.path
      );
      const before = readdirSync(outsideDir);

      await expect(
        materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)
      ).rejects.toThrow(/escapes|root/i);
      expect(readdirSync(outsideDir)).toEqual(before);
      expect(readFileSync(join(outsideDir, 'sentinel'), 'utf8')).toBe(
        'outside must stay unchanged\n'
      );
    }
  );

  it('materializes an exact detached clean commit from a validated local Git transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-materialize-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
    mkdirSync(sessionDir);
    const input = createWorkspaceGitInput(target, remote.commit, remote.path);

    await expect(
      materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)
    ).resolves.toEqual(new Map([[input.id, remote.commit]]));

    expect(gitText(target, ['rev-parse', 'HEAD'])).toBe(remote.commit);
    expect(gitText(target, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(gitText(target, ['status', '--porcelain'])).toBe('');
    expect(gitText(target, ['config', '--get', 'remote.origin.url'])).toBe(remote.path);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves only the OpenShell Git transport environment for Git subprocesses',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-git-environment-'));
      const wrapperDir = join(root, 'bin');
      const observedEnvironmentPath = join(root, 'git-environment.json');
      const workspaceRoot = join(root, 'workspace');
      const sessionDir = join(root, 'session');
      const target = join(workspaceRoot, 'worktrees', 'main');
      const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
      const originalPath = process.env.PATH ?? '';
      const realGitPath = originalPath
        .split(delimiter)
        .map((entry) => join(entry, 'git'))
        .find((candidate) => existsSync(candidate));
      if (!realGitPath) {
        throw new Error('Workspace Git environment fixture requires Git on PATH.');
      }

      const proxyEnvironment = {
        ALL_PROXY: 'http://127.0.0.1:19001',
        HTTPS_PROXY: 'http://127.0.0.1:19002',
        HTTP_PROXY: 'http://127.0.0.1:19003',
        NO_PROXY: 'localhost,127.0.0.1',
        http_proxy: 'http://127.0.0.1:19004',
        https_proxy: 'http://127.0.0.1:19005',
        no_proxy: '127.0.0.1,localhost',
      };
      const environmentCanaries = {
        CURL_CA_BUNDLE: '/openkit/ca/curl.pem',
        DENO_CERT: '/openkit/ca/deno.pem',
        GITHUB_TOKEN: 'credential-canary-must-not-leak',
        GIT_SSL_CAINFO: '/ambient/ca/must-not-win.pem',
        NODE_EXTRA_CA_CERTS: '/openkit/ca/node.pem',
        OPENKIT_UNRELATED_CANARY: 'unrelated-canary-must-not-leak',
        REQUESTS_CA_BUNDLE: '/openkit/ca/python.pem',
        SSL_CERT_FILE: '/openkit/ca/tls.pem',
        all_proxy: 'http://127.0.0.1:19006',
      };
      const observedKeys = [...Object.keys(proxyEnvironment), ...Object.keys(environmentCanaries)];
      const previousEnvironment = Object.fromEntries(
        [...observedKeys, 'PATH'].map((key) => [key, process.env[key]])
      );
      mkdirSync(wrapperDir);
      mkdirSync(sessionDir);
      writeFileSync(
        join(wrapperDir, 'git'),
        `#!${process.execPath}\n` +
          `const { spawnSync } = require('node:child_process');\n` +
          `const { writeFileSync } = require('node:fs');\n` +
          `const keys = ${JSON.stringify(observedKeys)};\n` +
          `writeFileSync(${JSON.stringify(observedEnvironmentPath)}, JSON.stringify(Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))));\n` +
          `const result = spawnSync(${JSON.stringify(realGitPath)}, process.argv.slice(2), { env: process.env, stdio: 'inherit' });\n` +
          `if (result.error) throw result.error;\n` +
          `process.exit(result.status ?? 1);\n`
      );
      chmodSync(join(wrapperDir, 'git'), 0o755);

      try {
        Object.assign(process.env, proxyEnvironment, environmentCanaries);
        process.env.PATH = `${wrapperDir}${delimiter}${originalPath}`;
        const input = createWorkspaceGitInput(target, remote.commit, remote.path);

        await expect(
          materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)
        ).resolves.toEqual(new Map([[input.id, remote.commit]]));

        const observedEnvironment = JSON.parse(
          readFileSync(observedEnvironmentPath, 'utf8')
        ) as Record<string, string>;
        expect(observedEnvironment).toEqual({
          ...proxyEnvironment,
          GIT_SSL_CAINFO: environmentCanaries.SSL_CERT_FILE,
        });
        expect(observedEnvironment).not.toHaveProperty('CURL_CA_BUNDLE');
        expect(observedEnvironment).not.toHaveProperty('DENO_CERT');
        expect(observedEnvironment).not.toHaveProperty('GITHUB_TOKEN');
        expect(observedEnvironment).not.toHaveProperty('NODE_EXTRA_CA_CERTS');
        expect(observedEnvironment).not.toHaveProperty('OPENKIT_UNRELATED_CANARY');
        expect(observedEnvironment).not.toHaveProperty('REQUESTS_CA_BUNDLE');
        expect(observedEnvironment).not.toHaveProperty('SSL_CERT_FILE');
        expect(observedEnvironment).not.toHaveProperty('all_proxy');
      } finally {
        for (const [key, value] of Object.entries(previousEnvironment)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    }
  );

  it('replaces a dirty prior Turn worktree with a fresh exact checkout only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-rematerialize-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const nativeStatePath = join(sessionDir, 'native-state');
    const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
    mkdirSync(sessionDir);
    writeFixtureFile(sessionDir, 'native-state', 'native session state\n');
    const input = createWorkspaceGitInput(target, remote.commit, remote.path);
    await materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir);
    writeFixtureFile(target, 'README.md', '# Dirty prior Turn\n');
    writeFixtureFile(target, 'untracked.txt', 'discard me\n');

    await expect(
      materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)
    ).resolves.toEqual(new Map([[input.id, remote.commit]]));

    expect(gitText(target, ['rev-parse', 'HEAD'])).toBe(remote.commit);
    expect(gitText(target, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(gitText(target, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Exact remote source\n');
    expect(existsSync(join(target, 'untracked.txt'))).toBe(false);
    expect(readFileSync(nativeStatePath, 'utf8')).toBe('native session state\n');
  });
});

describe('workspace Git publication', () => {
  it('publishes a complete manifest and applicable patch against the captured base', async () => {
    const fixture = createGitFixture({ 'README.md': '# Before\n' });
    const bases = await prepare(fixture);
    writeFixtureFile(fixture.repoDir, 'README.md', '# After worker commit\n');
    writeFixtureFile(fixture.repoDir, 'temp/research/report.md', '# Worker Report\n');
    git(fixture.repoDir, ['add', '.']);
    git(fixture.repoDir, ['commit', '-m', 'worker change']);
    const headCommit = gitText(fixture.repoDir, ['rev-parse', 'HEAD']);

    await publish(fixture, bases);

    const manifest = readManifest(fixture.sessionDir);
    const patch = readFileSync(join(fixture.sessionDir, 'workspace.patch'));
    expect(manifest).toMatchObject({
      base: { commit: fixture.baseCommit, contentDigest: null },
      changedPaths: [
        { binary: false, path: 'README.md', status: 'modified' },
        { binary: false, path: 'temp/research/report.md', status: 'added' },
      ],
      evidenceRefs: [{ kind: 'worker', ref: LINEAGE.turnId }],
      head: { commit: headCommit, contentDigest: null },
      id: 'wcs_aepsnap_workspace_git_repo',
      inputSnapshotId: 'wis_aepsnap_workspace_git_repo',
      materializationRecordId: 'wmr_aepsnap_workspace_git_repo',
      patch: {
        bytes: patch.byteLength,
        digest: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
        ref: 'worker-session://workspace.patch',
      },
      resourceId: 'repo',
      strategy: 'git',
      workspaceId: LINEAGE.workspaceId,
    });
    expect(Number.isNaN(Date.parse(String(manifest.createdAt)))).toBe(false);
    expect(patch.toString('utf8').endsWith('\n')).toBe(true);

    const verificationDir = join(fixture.sessionDir, 'verification');
    git(fixture.repoDir, ['worktree', 'add', '--detach', verificationDir, fixture.baseCommit]);
    execFileSync('git', ['apply', '--check', '-'], {
      cwd: verificationDir,
      input: patch,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  });

  it('preserves trailing spaces on the final changed patch line', async () => {
    const fixture = createGitFixture({ 'README.md': '# Before\n' });
    const bases = await prepare(fixture);
    writeFixtureFile(fixture.repoDir, 'README.md', '# After   \n');

    await publish(fixture, bases);

    expect(readFileSync(join(fixture.sessionDir, 'workspace.patch'), 'utf8')).toContain(
      '+# After   \n'
    );
  });

  it.skipIf(process.platform === 'win32')(
    'publishes exact binary, path, and executable-mode review metadata',
    async () => {
      const nextBinary = Buffer.from([0, 1, 2, 3, 255, 254, 253, 0]);
      const fixture = createGitFixture({
        'artifact.bin': Buffer.from([0, 1, 2, 3]),
        'content.sh': '#!/bin/sh\necho before\n',
        'deleted.txt': 'Delete me.\n',
        'rename-before.txt': 'Rename me.\n',
        'run.sh': '#!/bin/sh\nexit 0\n',
      });
      chmodSync(join(fixture.repoDir, 'content.sh'), 0o644);
      chmodSync(join(fixture.repoDir, 'run.sh'), 0o644);
      git(fixture.repoDir, ['add', '.']);
      git(fixture.repoDir, ['commit', '--amend', '--no-edit']);
      fixture.baseCommit = gitText(fixture.repoDir, ['rev-parse', 'HEAD']);
      fixture.input.source.commit = fixture.baseCommit;
      const bases = await prepare(fixture);

      writeFixtureFile(fixture.repoDir, 'artifact.bin', nextBinary);
      writeFixtureFile(fixture.repoDir, 'content.sh', '#!/bin/sh\necho after\n');
      chmodSync(join(fixture.repoDir, 'content.sh'), 0o755);
      unlinkSync(join(fixture.repoDir, 'deleted.txt'));
      renameSync(
        join(fixture.repoDir, 'rename-before.txt'),
        join(fixture.repoDir, 'rename-after.txt')
      );
      chmodSync(join(fixture.repoDir, 'run.sh'), 0o755);

      await publish(fixture, bases);

      const digest = `sha256:${createHash('sha256').update(nextBinary).digest('hex')}`;
      expect(readManifest(fixture.sessionDir).changedPaths).toEqual(
        expect.arrayContaining([
          {
            binary: true,
            binaryReview: {
              bytes: nextBinary.byteLength,
              digest,
              mediaType: 'application/octet-stream',
              mode: 'artifact-only',
              reason: 'binary-path',
              summary: expect.any(String),
            },
            digest,
            path: 'artifact.bin',
            size: nextBinary.byteLength,
            status: 'modified',
          },
          {
            binary: false,
            newPermissions: '0755',
            oldPermissions: '0644',
            path: 'content.sh',
            status: 'modified',
          },
          { binary: false, path: 'deleted.txt', status: 'deleted' },
          {
            binary: false,
            oldPath: 'rename-before.txt',
            path: 'rename-after.txt',
            status: 'renamed',
          },
          {
            binary: false,
            newPermissions: '0755',
            oldPermissions: '0644',
            path: 'run.sh',
            status: 'mode_changed',
          },
        ])
      );
    }
  );

  it('describes binary changes using canonical staged blob bytes after EOL conversion', async () => {
    const nextWorktreeBytes = Buffer.from([0, 98, 13, 10]);
    const fixture = createGitFixture({
      '.gitattributes': 'artifact.bin text eol=lf\n',
      'artifact.bin': Buffer.from([0, 97, 10]),
    });
    const bases = await prepare(fixture);
    writeFixtureFile(fixture.repoDir, 'artifact.bin', nextWorktreeBytes);

    await publish(fixture, bases);

    const objectId = gitText(fixture.repoDir, [
      'hash-object',
      '-w',
      '--path=artifact.bin',
      'artifact.bin',
    ]);
    const canonicalBlob = execFileSync('git', ['cat-file', 'blob', objectId], {
      cwd: fixture.repoDir,
    });
    const digest = `sha256:${createHash('sha256').update(canonicalBlob).digest('hex')}`;
    expect(canonicalBlob.equals(nextWorktreeBytes)).toBe(false);
    expect(readManifest(fixture.sessionDir).changedPaths).toEqual([
      expect.objectContaining({
        binary: true,
        binaryReview: expect.objectContaining({ bytes: canonicalBlob.byteLength, digest }),
        digest,
        path: 'artifact.bin',
        size: canonicalBlob.byteLength,
        status: 'modified',
      }),
    ]);
  });

  it.each([
    {
      after: (credential: string) => Buffer.from(`# After\n${credential}\n`),
      before: Buffer.from('# Before\n'),
      credential: 'multiline-credential-first\nmultiline-credential-second',
      label: 'multiline text',
      path: 'README.md',
    },
    {
      after: (credential: string) =>
        Buffer.concat([
          Buffer.from([0, 255]),
          Buffer.from(credential, 'utf8'),
          Buffer.from([0, 1]),
        ]),
      before: Buffer.from([0, 1]),
      credential: 'binary-credential-secret-canary',
      label: 'binary',
      path: 'artifact.bin',
    },
  ])('rejects injected credentials in exact staged $label bytes', async (testCase) => {
    const fixture = createGitFixture({ [testCase.path]: testCase.before });
    const bases = await prepare(fixture);
    writeFixtureFile(fixture.repoDir, testCase.path, testCase.after(testCase.credential));

    await expect(publish(fixture, bases, [testCase.credential])).rejects.toThrow(
      'Git workspace staged content contains an injected credential.'
    );

    expect(reviewArtifactPresence(fixture.sessionDir)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('rejects a changed path with a custom clean filter without executing it', async () => {
    const fixture = createGitFixture({
      '.gitattributes': 'artifact.bin filter=openkit-review -text\n',
      'artifact.bin': Buffer.from([0, 1]),
    });
    const bases = await prepare(fixture);
    const markerPath = join(fixture.sessionDir, 'filter-ran');
    git(fixture.repoDir, ['config', 'filter.openkit-review.clean', 'tee ../filter-ran']);
    git(fixture.repoDir, ['config', 'filter.openkit-review.required', 'true']);
    writeFixtureFile(fixture.repoDir, 'artifact.bin', Buffer.from([0, 2]));

    await expect(publish(fixture, bases)).rejects.toThrow(/filter/i);

    expect(existsSync(markerPath)).toBe(false);
    expect(reviewArtifactPresence(fixture.sessionDir)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('does not execute a clean filter on an unchanged sibling while publishing another path', async () => {
    const fixture = createGitFixture({
      '.gitattributes': 'unchanged.bin filter=openkit-review -text\n',
      'changed.txt': 'Before\n',
      'unchanged.bin': Buffer.from([0, 1]),
    });
    const bases = await prepare(fixture);
    const markerPath = join(fixture.sessionDir, 'filter-ran');
    git(fixture.repoDir, ['config', 'filter.openkit-review.clean', 'tee ../filter-ran']);
    git(fixture.repoDir, ['config', 'filter.openkit-review.required', 'true']);
    writeFixtureFile(fixture.repoDir, 'changed.txt', 'After\n');

    await publish(fixture, bases);

    expect(existsSync(markerPath)).toBe(false);
    expect(readManifest(fixture.sessionDir).changedPaths).toEqual([
      { binary: false, path: 'changed.txt', status: 'modified' },
    ]);
  });

  it('fails closed when the worker changes Git attributes', async () => {
    const fixture = createGitFixture({ 'README.md': '# Before\n' });
    const bases = await prepare(fixture);
    writeFixtureFile(fixture.repoDir, '.gitattributes', '*.txt text eol=lf\n');

    await expect(publish(fixture, bases)).rejects.toThrow(/attributes/i);

    expect(reviewArtifactPresence(fixture.sessionDir)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('removes stale review outputs during prepare and when publication has no changes', async () => {
    const fixture = createGitFixture({ 'README.md': '# Unchanged\n' });
    seedStaleReviewArtifacts(fixture.sessionDir);

    const bases = await prepare(fixture);
    expect(reviewArtifactPresence(fixture.sessionDir)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    seedStaleReviewArtifacts(fixture.sessionDir);

    await publish(fixture, bases);

    expect(reviewArtifactPresence(fixture.sessionDir)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('removes every review output when manifest publication fails after patch publication', async () => {
    const fixture = createGitFixture({ 'README.md': '# Before\n' });
    const bases = await prepare(fixture);
    writeFixtureFile(fixture.repoDir, 'README.md', '# After\n');
    mkdirSync(join(fixture.sessionDir, 'workspace-changes.json'));

    await expect(publish(fixture, bases)).rejects.toThrow();

    expect(reviewArtifactPresence(fixture.sessionDir)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('workspace Git preparation', () => {
  it('rejects a repository without an available base commit', async () => {
    const fixture = createGitFixture({ 'README.md': '# Before\n' });
    rmSync(join(fixture.repoDir, '.git'), { recursive: true });
    git(fixture.repoDir, ['init']);

    await expect(prepare(fixture)).rejects.toThrow(/base commit|HEAD/i);
  });

  it('rejects pre-existing dirty workspace state', async () => {
    const fixture = createGitFixture({ 'README.md': '# Before\n' });
    writeFixtureFile(fixture.repoDir, 'README.md', '# Preexisting change\n');

    await expect(prepare(fixture)).rejects.toThrow(/clean/i);
  });

  it('accepts clean content when transport changes only filesystem metadata', async () => {
    const fixture = createGitFixture({ 'README.md': '# Clean transported repository\n' });
    utimesSync(join(fixture.repoDir, 'README.md'), new Date(0), new Date(0));

    await expect(prepare(fixture)).resolves.toEqual(
      new Map([[fixture.input.id, fixture.baseCommit]])
    );
  });

  it.each([
    '--assume-unchanged',
    '--skip-worktree',
  ] as const)('rejects dirty state hidden by %s', async (flag) => {
    const fixture = createGitFixture({ 'README.md': '# Before\n' });
    git(fixture.repoDir, ['update-index', flag, 'README.md']);
    writeFixtureFile(fixture.repoDir, 'README.md', '# Hidden preexisting change\n');

    await expect(prepare(fixture)).rejects.toThrow(/hide|index|lineage/i);
  });

  it('ignores ambient GIT_DIR when capturing and publishing a workspace', async () => {
    const fixture = createGitFixture({ 'README.md': '# Before\n' });
    const decoy = createGitFixture({ 'DECOY.md': '# Wrong repository\n' });
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(decoy.repoDir, '.git');

    try {
      const bases = await prepare(fixture);
      writeFixtureFile(fixture.repoDir, 'README.md', '# After\n');
      await publish(fixture, bases);
    } finally {
      if (previousGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previousGitDir;
      }
    }

    expect(readManifest(fixture.sessionDir).base.commit).toBe(fixture.baseCommit);
  });
});

interface GitFixture {
  baseCommit: string;
  input: WorkspaceGitInput;
  repoDir: string;
  sessionDir: string;
}

interface PublishedManifest extends Record<string, unknown> {
  base: { commit: string };
  changedPaths: unknown[];
  createdAt: string;
}

function createBareGitRemote(files: Readonly<Record<string, string | Buffer>>): {
  commit: string;
  path: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-git-remote-'));
  const sourceDir = join(root, 'source');
  const remotePath = join(root, 'remote.git');
  mkdirSync(sourceDir);
  git(sourceDir, ['init']);
  git(sourceDir, ['config', 'user.email', 'worker@example.com']);
  git(sourceDir, ['config', 'user.name', 'Worker']);
  for (const [path, content] of Object.entries(files)) {
    writeFixtureFile(sourceDir, path, content);
  }
  git(sourceDir, ['add', '.']);
  git(sourceDir, ['commit', '-m', 'initial']);
  const commit = gitText(sourceDir, ['rev-parse', 'HEAD']);
  execFileSync('git', ['clone', '--bare', sourceDir, remotePath], { stdio: 'ignore' });
  return { commit, path: remotePath };
}

function createWorkspaceGitInput(target: string, commit: string, url: string): WorkspaceGitInput {
  return {
    access: 'read-write',
    id: 'repo',
    materialization: {
      changeSetManifestPath: '/openkit/session/workspace-changes.json',
      strategy: 'git',
    },
    source: {
      catalogEntryDigest: `sha256:${'1'.repeat(64)}`,
      commit,
      kind: 'git',
      sensitivity: 'internal',
      sourceId: 'repo',
      sourceRef: 'main-repo',
      url,
    },
    target,
  };
}

function createGitFixture(files: Readonly<Record<string, string | Buffer>>): GitFixture {
  const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-workspace-git-'));
  const repoDir = join(sessionDir, 'repo');
  mkdirSync(repoDir);
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'worker@example.com']);
  git(repoDir, ['config', 'user.name', 'Worker']);
  for (const [path, content] of Object.entries(files)) {
    writeFixtureFile(repoDir, path, content);
  }
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initial']);
  const baseCommit = gitText(repoDir, ['rev-parse', 'HEAD']);
  return {
    baseCommit,
    input: createWorkspaceGitInput(repoDir, baseCommit, 'https://git.example.test/repo.git'),
    repoDir,
    sessionDir,
  };
}

async function prepare(fixture: GitFixture): Promise<Map<string, string>> {
  return await prepareWorkspaceGitSnapshots([fixture.input], fixture.sessionDir);
}

async function publish(
  fixture: GitFixture,
  bases: ReadonlyMap<string, string>,
  credentialValues: readonly string[] = []
): Promise<void> {
  await publishWorkspaceGitSnapshots({
    bases,
    credentialValues,
    inputs: [fixture.input],
    lineage: LINEAGE,
    sessionDir: fixture.sessionDir,
  });
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function gitText(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeFixtureFile(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function readManifest(sessionDir: string): PublishedManifest {
  return JSON.parse(
    readFileSync(join(sessionDir, 'workspace-changes.json'), 'utf8')
  ) as PublishedManifest;
}

function reviewArtifactPresence(sessionDir: string): boolean[] {
  return REVIEW_ARTIFACTS.map((name) => existsSync(join(sessionDir, name)));
}

function seedStaleReviewArtifacts(sessionDir: string): void {
  writeFileSync(join(sessionDir, 'workspace.patch'), 'stale patch\n');
  writeFileSync(join(sessionDir, 'workspace-changes.json'), '{"stale":true}\n');
  writeFileSync(join(sessionDir, 'workspace-git.index'), 'stale index\n');
}

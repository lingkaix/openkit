import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { inspectGitPushRepository } from './git-push-repository.js';

/**
 * Creates one committed repository with the requested origin URL.
 *
 * @param remoteUrl Origin URL stored in the repository.
 * @param objectFormat Git object format used by the fixture repository.
 * @returns Repository path and current commit id.
 */
function createRepository(
  remoteUrl: string,
  objectFormat: 'sha1' | 'sha256' = 'sha1'
): {
  readonly commitId: string;
  readonly objectDirectory: string;
  readonly path: string;
} {
  const path = mkdtempSync(join(tmpdir(), 'openkit-git-push-inspection-'));

  execFileSync('git', ['init', `--object-format=${objectFormat}`], { cwd: path, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
    cwd: path,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'OpenKit'], { cwd: path, stdio: 'ignore' });
  writeFileSync(join(path, 'README.md'), '# OpenKit\n');
  execFileSync('git', ['add', 'README.md'], { cwd: path, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'Initial'], { cwd: path, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: path, stdio: 'ignore' });

  return {
    commitId: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim(),
    objectDirectory: execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
      { cwd: path, encoding: 'utf8' }
    ).trim(),
    path,
  };
}

describe('Git push repository inspection', () => {
  it('inspects a differently owned linked checkout with scrubbed HOME without exposing credentials or changing ownership', () => {
    const repository = createRepository('https://github.com/openkit/openkit.git');
    const otherUid = process.getuid?.() === 0 ? 1001 : 0;
    const originalUid = statSync(repository.path).uid;
    const originalGid = statSync(repository.path).gid;
    const credential = 'ghp_inspection_credential_canary';
    const hostileConfig = join(mkdtempSync(join(tmpdir(), 'openkit-git-global-config-')), 'config');
    const savedHome = process.env.HOME;
    const savedToken = process.env.GITHUB_TOKEN;
    const savedGlobalConfig = process.env.GIT_CONFIG_GLOBAL;

    /** Changes only the disposable fixture's owner. */
    const setOwner = (uid: number, gid?: number): void => {
      if (process.getuid?.() === 0) {
        chownSync(repository.path, uid, gid ?? originalGid);
        chownSync(join(repository.path, '.git'), uid, gid ?? originalGid);
      } else {
        execFileSync('sudo', [
          '-n',
          'chown',
          '-R',
          gid === undefined ? String(uid) : `${uid}:${gid}`,
          repository.path,
        ]);
      }
    };

    try {
      chmodSync(repository.path, 0o755);
      setOwner(otherUid);
      const ownerBefore = statSync(repository.path).uid;
      expect(ownerBefore).toBe(otherUid);
      expect(() =>
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repository.path,
          env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null' },
          stdio: 'pipe',
        })
      ).toThrow();

      delete process.env.HOME;
      process.env.GITHUB_TOKEN = credential;
      writeFileSync(
        hostileConfig,
        `[url "https://github.com/${credential}/"]\n\tinsteadOf = https://github.com/\n`
      );
      process.env.GIT_CONFIG_GLOBAL = hostileConfig;
      const inspection = inspectGitPushRepository(repository.path, 'HEAD');
      expect(inspection.sourceCommit).toBe(repository.commitId);
      expect(inspection.provider).toBe('github');
      expect(JSON.stringify(inspection)).not.toContain(credential);
      expect(statSync(repository.path).uid).toBe(ownerBefore);
      expect(statSync(join(repository.path, '.git')).uid).toBe(ownerBefore);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedToken;
      if (savedGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = savedGlobalConfig;
      setOwner(originalUid, originalGid);
      rmSync(repository.path, { recursive: true, force: true });
      rmSync(join(hostileConfig, '..'), { recursive: true, force: true });
    }
  });

  it('derives GitHub authority and the source commit from the repository', () => {
    const repository = createRepository('https://github.com/openkit/openkit.git');

    expect(inspectGitPushRepository(repository.path, 'HEAD')).toEqual({
      objectDirectory: repository.objectDirectory,
      objectFormat: 'sha1',
      provider: 'github',
      pushTarget: 'https://github.com/openkit/openkit.git',
      remoteIdentity: 'github:openkit/openkit',
      remoteName: 'origin',
      remoteSummary: 'GitHub repository openkit/openkit on origin',
      sourceCommit: repository.commitId,
    });
  });

  it('reports the repository object format required by an isolated execution view', () => {
    const repository = createRepository('https://github.com/openkit/openkit.git', 'sha256');

    expect(inspectGitPushRepository(repository.path, 'HEAD')).toMatchObject({
      objectDirectory: repository.objectDirectory,
      objectFormat: 'sha256',
      sourceCommit: repository.commitId,
    });
    expect(repository.commitId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed and redacts unsupported remote locations', () => {
    const remotePath = mkdtempSync(join(tmpdir(), 'ghp_do_not_expose_remote-'));
    const repository = createRepository(remotePath);
    const inspection = inspectGitPushRepository(repository.path, repository.commitId);

    expect(inspection).toMatchObject({
      provider: 'unsupported',
      pushTarget: 'origin',
      remoteName: 'origin',
      remoteSummary: 'Unsupported Git remote on origin',
      sourceCommit: repository.commitId,
    });
    expect(inspection.remoteIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(inspection)).not.toContain(remotePath);
    expect(JSON.stringify(inspection)).not.toContain('ghp_do_not_expose_remote');
  });

  it.each([
    'git@github.com:openkit/openkit.git',
    'ssh://git@github.com/openkit/openkit.git',
  ])('refuses GitHub SSH push URL %s instead of synthesizing HTTPS authority', (remoteUrl) => {
    const repository = createRepository(remoteUrl);

    expect(inspectGitPushRepository(repository.path, 'HEAD')).toMatchObject({
      provider: 'unsupported',
      pushTarget: 'origin',
      remoteSummary: 'Unsupported Git remote on origin',
    });
  });

  it('refuses a canonical HTTPS origin rewritten by repository-local config', () => {
    const remotePath = mkdtempSync(join(tmpdir(), 'openkit-git-push-rewrite-target-'));
    const repository = createRepository('https://github.com/openkit/openkit.git');

    execFileSync('git', ['config', `url.file://${remotePath}/.insteadOf`, 'https://github.com/'], {
      cwd: repository.path,
      stdio: 'ignore',
    });

    expect(inspectGitPushRepository(repository.path, 'HEAD')).toMatchObject({
      provider: 'unsupported',
      pushTarget: 'origin',
    });
  });

  it('uses the configured push URL instead of the GitHub fetch URL', () => {
    const remotePath = mkdtempSync(join(tmpdir(), 'openkit-non-github-pushurl-'));
    const repository = createRepository('https://github.com/openkit/openkit.git');

    execFileSync('git', ['config', 'remote.origin.pushurl', remotePath], {
      cwd: repository.path,
      stdio: 'ignore',
    });

    expect(inspectGitPushRepository(repository.path, 'HEAD')).toMatchObject({
      provider: 'unsupported',
      remoteSummary: 'Unsupported Git remote on origin',
    });
  });

  it('rejects multiple configured push URLs', () => {
    const repository = createRepository('https://github.com/openkit/openkit.git');

    execFileSync(
      'git',
      ['config', '--add', 'remote.origin.pushurl', 'https://github.com/openkit/openkit.git'],
      { cwd: repository.path, stdio: 'ignore' }
    );
    execFileSync(
      'git',
      ['config', '--add', 'remote.origin.pushurl', 'https://github.com/openkit/mirror.git'],
      { cwd: repository.path, stdio: 'ignore' }
    );

    expect(() => inspectGitPushRepository(repository.path, 'HEAD')).toThrow(
      'Git push repository inspection failed.'
    );
  });
});

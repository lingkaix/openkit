import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

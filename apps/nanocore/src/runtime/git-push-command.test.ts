import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { buildGitPushCommand } from './git-push-command.js';

describe('Git push command', () => {
  it('does not read GitHub credentials implicitly from the process environment', () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_process_secret';

    try {
      expect(
        buildGitPushCommand({
          expectedRemoteHead: '0'.repeat(40),
          remoteName: 'https://github.com/openkit/openkit.git',
          sourceRef: 'HEAD',
          targetBranch: 'openkit/release',
        }).env
      ).toEqual({
        GIT_TERMINAL_PROMPT: '0',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previous;
      }
    }
  });

  it.each([
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ] as const)('converts %s into Git-scoped HTTPS authorization', (tokenKey) => {
    const token = 'ghp_secret';
    const authorization = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const command = buildGitPushCommand({
      env: {
        [tokenKey]: token,
        HOME: '/home/openkit',
        NPM_TOKEN: 'npm_secret',
        PATH: '/usr/bin',
      },
      expectedRemoteHead: '0'.repeat(40),
      remoteName: 'https://github.com/openkit/openkit.git',
      sourceRef: 'HEAD',
      targetBranch: 'openkit/release',
    });

    expect(command).toEqual({
      args: [
        'push',
        '--porcelain',
        '--no-verify',
        `--force-with-lease=refs/heads/openkit/release:${'0'.repeat(40)}`,
        '--',
        'https://github.com/openkit/openkit.git',
        'HEAD:refs/heads/openkit/release',
      ],
      command: 'git',
      env: {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_VALUE_1: authorization,
        GIT_TERMINAL_PROMPT: '0',
        HOME: '/home/openkit',
        PATH: '/usr/bin',
      },
    });
    expect(JSON.stringify(command)).not.toContain(token);
    expect(
      execFileSync(
        command.command,
        ['config', '--get-urlmatch', 'http.extraheader', 'https://github.com/openkit/openkit.git'],
        { encoding: 'utf8', env: command.env }
      ).trim()
    ).toBe(authorization);
  });

  it('accepts one canonical GitHub HTTPS push target', () => {
    expect(
      buildGitPushCommand({
        expectedRemoteHead: '0'.repeat(40),
        remoteName: 'https://github.com/openkit/openkit.git',
        sourceRef: 'abc123',
        targetBranch: 'openkit/release',
      }).args
    ).toEqual([
      'push',
      '--porcelain',
      '--no-verify',
      `--force-with-lease=refs/heads/openkit/release:${'0'.repeat(40)}`,
      '--',
      'https://github.com/openkit/openkit.git',
      'abc123:refs/heads/openkit/release',
    ]);
  });

  it('refuses option, force, delete, and compound refspec shapes', () => {
    const base = {
      expectedRemoteHead: '0'.repeat(40),
      remoteName: 'https://github.com/openkit/openkit.git',
      sourceRef: 'HEAD',
      targetBranch: 'openkit/release',
    };

    expect(() => buildGitPushCommand({ ...base, remoteName: 'origin' })).toThrow(
      'Git push target is not a canonical GitHub HTTPS URL.'
    );
    expect(() => buildGitPushCommand({ ...base, remoteName: '/tmp/local.git' })).toThrow(
      'Git push target is not a canonical GitHub HTTPS URL.'
    );
    expect(() => buildGitPushCommand({ ...base, remoteName: '--upload-pack=evil' })).toThrow(
      'Git push target is not a canonical GitHub HTTPS URL.'
    );
    expect(() => buildGitPushCommand({ ...base, sourceRef: '+HEAD' })).toThrow(
      'Git push source ref is not safe.'
    );
    expect(() => buildGitPushCommand({ ...base, sourceRef: '' })).toThrow(
      'Git push source ref is not safe.'
    );
    expect(() => buildGitPushCommand({ ...base, targetBranch: 'main:evil' })).toThrow(
      'Git push target branch is not safe.'
    );
    expect(() => buildGitPushCommand({ ...base, expectedRemoteHead: '' })).toThrow(
      'Git push expected remote head is not safe.'
    );
    expect(() => buildGitPushCommand({ ...base, expectedRemoteHead: 'A'.repeat(40) })).toThrow(
      'Git push expected remote head is not safe.'
    );
    expect(() => buildGitPushCommand({ ...base, expectedRemoteHead: 'a'.repeat(39) })).toThrow(
      'Git push expected remote head is not safe.'
    );
    expect(() => buildGitPushCommand({ ...base, expectedRemoteHead: 'a'.repeat(41) })).toThrow(
      'Git push expected remote head is not safe.'
    );
  });
});

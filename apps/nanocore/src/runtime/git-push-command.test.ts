import { describe, expect, it } from 'vitest';

import { buildGitPushCommand } from './git-push-command.js';

describe('Git push command', () => {
  it('does not read GitHub credentials implicitly from the process environment', () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_process_secret';

    try {
      expect(
        buildGitPushCommand({
          remoteName: 'origin',
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

  it('builds a fixed argument vector with GitHub credential env for branch pushes', () => {
    expect(
      buildGitPushCommand({
        env: {
          GITHUB_TOKEN: 'ghp_secret',
          HOME: '/home/openkit',
          NPM_TOKEN: 'npm_secret',
          PATH: '/usr/bin',
        },
        remoteName: 'origin',
        sourceRef: 'HEAD',
        targetBranch: 'openkit/release',
      })
    ).toEqual({
      args: ['push', '--porcelain', '--', 'origin', 'HEAD:refs/heads/openkit/release'],
      command: 'git',
      env: {
        GITHUB_TOKEN: 'ghp_secret',
        GIT_TERMINAL_PROMPT: '0',
        HOME: '/home/openkit',
        PATH: '/usr/bin',
      },
    });
  });

  it('refuses option, force, delete, and compound refspec shapes', () => {
    const base = {
      remoteName: 'origin',
      sourceRef: 'HEAD',
      targetBranch: 'openkit/release',
    };

    expect(() => buildGitPushCommand({ ...base, remoteName: '--upload-pack=evil' })).toThrow(
      'Git push remote name is not safe.'
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
  });
});

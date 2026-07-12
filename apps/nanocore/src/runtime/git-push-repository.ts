import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REMOTE_NAME = 'origin' as const;
const GIT_READ_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
  LANG: 'C',
  LC_ALL: 'C',
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
};

/**
 * Inspects the fixed V1 push remote and resolves the approved source ref to one commit.
 *
 * @param cwd Linked repository working directory.
 * @param sourceRef Source ref requested for publication.
 * @returns Canonical provider, redacted remote identity, and resolved source commit.
 * @throws Error when the repository, origin, or source ref cannot be inspected.
 */
export function inspectGitPushRepository(
  cwd: string,
  sourceRef: string
): {
  readonly provider: 'github' | 'unsupported';
  readonly objectDirectory: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly pushTarget: string;
  readonly remoteIdentity: string;
  readonly remoteName: typeof REMOTE_NAME;
  readonly remoteSummary: string;
  readonly sourceCommit: string;
} {
  let remoteUrl: string;
  let objectDirectory: string;
  let objectFormat: 'sha1' | 'sha256';
  let sourceCommit: string;

  try {
    const pushUrls = runGitRead(cwd, ['remote', 'get-url', '--push', '--all', REMOTE_NAME])
      .split(/\r?\n/)
      .filter(Boolean);

    if (pushUrls.length !== 1) {
      throw new Error('Git push requires exactly one origin push URL.');
    }

    remoteUrl = pushUrls[0] ?? '';
    objectDirectory = runGitRead(cwd, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'objects',
    ]);
    const inspectedObjectFormat = runGitRead(cwd, ['rev-parse', '--show-object-format=storage']);
    if (inspectedObjectFormat !== 'sha1' && inspectedObjectFormat !== 'sha256') {
      throw new Error('Git repository object format is not supported.');
    }
    objectFormat = inspectedObjectFormat;
    sourceCommit = runGitRead(cwd, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${sourceRef}^{commit}`,
    ]);
    if (
      !/^[a-f0-9]+$/.test(sourceCommit) ||
      sourceCommit.length !== (objectFormat === 'sha1' ? 40 : 64)
    ) {
      throw new Error('Git source ref did not resolve to a commit.');
    }
  } catch {
    throw new Error('Git push repository inspection failed.');
  }

  const githubRepository = parseGitHubRepository(remoteUrl);

  if (githubRepository) {
    return {
      provider: 'github',
      objectDirectory,
      objectFormat,
      pushTarget: remoteUrl,
      remoteIdentity: `github:${githubRepository}`,
      remoteName: REMOTE_NAME,
      remoteSummary: `GitHub repository ${githubRepository} on origin`,
      sourceCommit,
    };
  }

  return {
    provider: 'unsupported',
    objectDirectory,
    objectFormat,
    pushTarget: REMOTE_NAME,
    remoteIdentity: `sha256:${createHash('sha256').update(remoteUrl).digest('hex')}`,
    remoteName: REMOTE_NAME,
    remoteSummary: 'Unsupported Git remote on origin',
    sourceCommit,
  };
}

/**
 * Runs one fixed read-only Git command with a scrubbed process environment.
 *
 * @param cwd Linked repository working directory.
 * @param args Fixed Git arguments.
 * @returns Trimmed command output.
 */
function runGitRead(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: GIT_READ_ENV,
    maxBuffer: 64 * 1024,
    timeout: 5_000,
  }).trim();
}

/**
 * Parses one canonical credential-free GitHub HTTPS remote into an owner/repository slug.
 *
 * @param remoteUrl Stored origin URL.
 * @returns Canonical lowercase GitHub slug, or null for unsupported remotes.
 */
function parseGitHubRepository(remoteUrl: string): string | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/.exec(
    remoteUrl
  );

  return match ? `${match[1]?.toLowerCase()}/${match[2]?.toLowerCase()}` : null;
}

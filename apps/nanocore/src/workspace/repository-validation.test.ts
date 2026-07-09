import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateRepositoryPath } from './repository-validation.js';

/**
 * Creates a temporary root for repository validation tests.
 *
 * @returns Temporary filesystem root path.
 */
function createTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-repository-validation-'));
}

describe('repository path validation', () => {
  it('accepts an existing local git repository directory', () => {
    const tempRoot = createTempRoot();
    const repositoryPath = join(tempRoot, 'ready-repository');
    mkdirSync(join(repositoryPath, '.git'), { recursive: true });

    const result = validateRepositoryPath(repositoryPath);

    expect(result).toMatchObject({
      ok: true,
      resourceKind: 'git_repository',
      status: 'ready',
    });
    expect(result.summary).toContain('ready');
  });

  it('accepts a git repository directory with a .git file', () => {
    const tempRoot = createTempRoot();
    const repositoryPath = join(tempRoot, 'worktree-repository');
    mkdirSync(repositoryPath, { recursive: true });
    writeFileSync(join(repositoryPath, '.git'), 'gitdir: ../.git/worktrees/worktree-repository\n');

    const result = validateRepositoryPath(repositoryPath);

    expect(result).toMatchObject({
      ok: true,
      resourceKind: 'git_repository',
      status: 'ready',
    });
  });

  it('rejects missing paths', () => {
    const tempRoot = createTempRoot();
    const repositoryPath = join(tempRoot, 'missing-repository');

    const result = validateRepositoryPath(repositoryPath);

    expect(result).toMatchObject({
      ok: false,
      resourceKind: 'git_repository',
      status: 'missing',
    });
  });

  it('rejects non-directory paths', () => {
    const tempRoot = createTempRoot();
    const repositoryPath = join(tempRoot, 'repository-file');
    writeFileSync(repositoryPath, 'not a directory');

    const result = validateRepositoryPath(repositoryPath);

    expect(result).toMatchObject({
      ok: false,
      resourceKind: 'git_repository',
      status: 'not_directory',
    });
  });

  it('rejects directories that do not look like git repositories', () => {
    const tempRoot = createTempRoot();
    const repositoryPath = join(tempRoot, 'plain-directory');
    mkdirSync(repositoryPath, { recursive: true });

    const result = validateRepositoryPath(repositoryPath);

    expect(result).toMatchObject({
      ok: false,
      resourceKind: 'git_repository',
      status: 'not_git',
    });
  });

  it('returns diagnostics without raw paths or secret-like token fragments', () => {
    const tempRoot = createTempRoot();
    const secretFragment = 'secret-fragment-123456';
    const repositoryPath = join(tempRoot, `repo-sk-test-${secretFragment}`);
    mkdirSync(repositoryPath, { recursive: true });

    const result = validateRepositoryPath(repositoryPath);
    const diagnostics = JSON.stringify(result);

    expect(diagnostics).not.toContain(tempRoot);
    expect(diagnostics).not.toContain(repositoryPath);
    expect(diagnostics).not.toContain(secretFragment);
    expect(result.pathSummary).toContain('[redacted]');
  });
});

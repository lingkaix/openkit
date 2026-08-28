// openkit-test-platform: posix
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { inspectRepositoryPath, validateRepositoryPath } from './repository-validation.js';

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

  it('rejects a repository whose normalized path equals DATA_ROOT', () => {
    const dataRoot = createTempRoot();
    mkdirSync(join(dataRoot, '.git'), { recursive: true });
    const result = validateRepositoryPath(join(dataRoot, '.'), { dataRoot });
    const diagnostics = JSON.stringify(result);

    expect(result.ok).toBe(false);
    expect(result.status).not.toBe('ready');
    expect(diagnostics).not.toContain(dataRoot);
  });

  it('rejects a repository that is a path-segment descendant of DATA_ROOT', () => {
    const dataRoot = createTempRoot();
    const repositoryPath = join(dataRoot, 'repos', 'nested');
    mkdirSync(join(repositoryPath, '.git'), { recursive: true });
    const result = validateRepositoryPath(repositoryPath, { dataRoot });
    const diagnostics = JSON.stringify(result);

    expect(result.ok).toBe(false);
    expect(result.status).not.toBe('ready');
    expect(diagnostics).not.toContain(dataRoot);
    expect(diagnostics).not.toContain(repositoryPath);
  });

  it('rejects a repository symlink whose real path aliases into DATA_ROOT', () => {
    const parent = createTempRoot();
    const dataRoot = join(parent, 'data-root');
    const inside = join(dataRoot, 'poisoned-repo');
    mkdirSync(join(inside, '.git'), { recursive: true });
    const alias = join(parent, 'alias-repo');
    symlinkSync(inside, alias);
    const result = validateRepositoryPath(alias, { dataRoot });
    const diagnostics = JSON.stringify(result);

    expect(result.ok).toBe(false);
    expect(result.status).not.toBe('ready');
    expect(diagnostics).not.toContain(dataRoot);
    expect(diagnostics).not.toContain(inside);
    expect(diagnostics).not.toContain(alias);
  });

  it('accepts a sibling whose name only shares the DATA_ROOT string prefix', () => {
    const parent = createTempRoot();
    const dataRoot = join(parent, 'data-root');
    mkdirSync(dataRoot, { recursive: true });
    const sibling = join(parent, 'data-root-extra');
    mkdirSync(join(sibling, '.git'), { recursive: true });
    const result = validateRepositoryPath(sibling, { dataRoot });

    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
    });
  });

  it('accepts a lexically normalized external repository', () => {
    const parent = createTempRoot();
    const dataRoot = join(parent, 'data-root');
    mkdirSync(dataRoot, { recursive: true });
    const external = join(parent, 'outside', 'repo');
    mkdirSync(join(external, '.git'), { recursive: true });
    const result = validateRepositoryPath(join(dataRoot, '..', 'outside', 'repo'), { dataRoot });

    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
    });
  });

  it('marks a ready external repository unresolved when DATA_ROOT realpath fails', () => {
    const parent = createTempRoot();
    const dataRoot = join(parent, 'data-root');
    symlinkSync(dataRoot, dataRoot);
    const repositoryPath = join(parent, 'external-repo');
    mkdirSync(join(repositoryPath, '.git'), { recursive: true });
    const inspection = inspectRepositoryPath(repositoryPath, { dataRoot });
    const diagnostics = JSON.stringify(inspection.validation);

    expect(inspection.boundary).toBe('unresolved');
    expect(inspection.canonicalPath).toBeNull();
    expect(inspection.validation.ok).toBe(false);
    expect(inspection.validation.status).not.toBe('ready');
    expect(diagnostics).not.toContain(dataRoot);
    expect(diagnostics).not.toContain(repositoryPath);
  });

  it('rejects a repository contained by a DATA_ROOT symlink realpath', () => {
    const parent = createTempRoot();
    const realRoot = join(parent, 'real-data-root');
    mkdirSync(realRoot, { recursive: true });
    const dataRoot = join(parent, 'data-root');
    symlinkSync(realRoot, dataRoot);
    const repositoryPath = join(realRoot, 'repo');
    mkdirSync(join(repositoryPath, '.git'), { recursive: true });
    const inspection = inspectRepositoryPath(repositoryPath, { dataRoot });
    const diagnostics = JSON.stringify(inspection.validation);

    expect(inspection.boundary).toBe('contained');
    expect(inspection.canonicalPath).toBeNull();
    expect(inspection.validation.ok).toBe(false);
    expect(inspection.validation.status).not.toBe('ready');
    expect(diagnostics).not.toContain(dataRoot);
    expect(diagnostics).not.toContain(realRoot);
    expect(diagnostics).not.toContain(repositoryPath);
  });
});

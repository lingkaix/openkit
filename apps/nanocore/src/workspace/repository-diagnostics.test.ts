import { describe, expect, it } from 'vitest';
import {
  createWorkspaceRepositoryDeveloperDiagnostic,
  createWorkspaceRepositoryDiagnostic,
} from './repository-diagnostics.js';
import type { WorkspaceRepositoryResourceRecord } from './repository-store.js';

const timestamp = '2026-05-31T00:00:00.000Z';

/**
 * Builds a stored repository record for diagnostics read-model tests.
 *
 * @param overrides Record fields to override.
 * @returns Repository resource record.
 */
function repositoryRecord(
  overrides: Partial<WorkspaceRepositoryResourceRecord>
): WorkspaceRepositoryResourceRecord {
  return {
    workspaceId: 'ws_demo',
    resourceId: 'repo_default',
    type: 'git_repository',
    displayName: 'OpenKit',
    localPath: '/Users/example/openkit',
    diagnosticsStatus: 'unknown',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe('workspace repository diagnostics read models', () => {
  it('distinguishes stable readiness states without exposing raw local paths', () => {
    const records = [
      repositoryRecord({
        resourceId: 'repo_ready',
        validation: {
          ok: true,
          resourceKind: 'git_repository',
          status: 'ready',
          summary: 'local directory "ready" is ready as a git repository.',
          pathSummary: 'local directory "ready"',
        },
      }),
      repositoryRecord({
        resourceId: 'repo_missing',
        validation: {
          ok: false,
          resourceKind: 'git_repository',
          status: 'missing',
          summary: 'local directory "missing" does not exist.',
          pathSummary: 'local directory "missing"',
        },
      }),
      repositoryRecord({
        resourceId: 'repo_not_git',
        validation: {
          ok: false,
          resourceKind: 'git_repository',
          status: 'not_git',
          summary: 'local directory "plain" is not a git repository directory.',
          pathSummary: 'local directory "plain"',
        },
      }),
      repositoryRecord({
        resourceId: 'repo_inaccessible',
        validation: {
          ok: false,
          resourceKind: 'git_repository',
          status: 'inaccessible',
          summary: 'local directory "private" could not be inspected.',
          pathSummary: 'local directory "private"',
        },
      }),
    ];

    const diagnostics = records.map((record) => createWorkspaceRepositoryDiagnostic(record));
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.map((diagnostic) => diagnostic.diagnosticsStatus)).toEqual([
      'ready',
      'missing',
      'not_git',
      'inaccessible',
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.ready)).toEqual([true, false, false, false]);
    expect(serialized).not.toContain('/Users/example/openkit');
    expect(serialized).not.toContain('localPath');
  });

  it('keeps raw local paths only in the developer diagnostic read model', () => {
    const record = repositoryRecord({
      validation: {
        ok: true,
        resourceKind: 'git_repository',
        status: 'ready',
        summary: 'local directory "openkit" is ready as a git repository.',
        pathSummary: 'local directory "openkit"',
      },
    });

    expect(createWorkspaceRepositoryDiagnostic(record)).not.toHaveProperty('localPath');
    expect(createWorkspaceRepositoryDeveloperDiagnostic(record)).toMatchObject({
      kind: 'developer',
      localPath: '/Users/example/openkit',
      resourceId: 'repo_default',
    });
  });

  it('sanitizes stable display names that embed unrelated absolute host paths', () => {
    const record = repositoryRecord({
      displayName: 'OpenKit at /Users/example/other',
      localPath: '/tmp/openkit/repo',
      validation: {
        ok: true,
        resourceKind: 'git_repository',
        status: 'ready',
        summary: 'local directory "repo" is ready as a git repository.',
        pathSummary: 'local directory "repo"',
      },
    });

    const diagnostic = createWorkspaceRepositoryDiagnostic(record);
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic.displayName).toBe('local directory "repo"');
    expect(serialized).not.toContain('/Users/example/other');
    expect(serialized).not.toContain('/tmp/openkit/repo');
    expect(createWorkspaceRepositoryDeveloperDiagnostic(record).localPath).toBe(
      '/tmp/openkit/repo'
    );
  });
});

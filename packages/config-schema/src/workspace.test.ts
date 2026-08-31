// openkit-test-platform: posix
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  getConfigPolicyCatalog,
  getConfigSchemaCatalog,
  materializeWorkspaceRoots,
  WorkspaceConfigSchema,
  WorkspaceRootSchema,
  WorkspaceRootValidationError,
} from './index.js';

/**
 * Creates a temporary workspace root for materialization tests.
 *
 * @returns Workspace root path.
 */
function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-workspace-config-'));
}

describe('workspace config schema', () => {
  it('accepts host-dir roots and defaults createIfMissing to false', () => {
    const parsed = WorkspaceConfigSchema.parse({
      schemaVersion: 1,
      workspace: {
        name: 'Config schema workspace',
        defaultAgentId: 'agent_codex',
        assistant: {
          repositoryInspection: {
            enabled: false,
            excludedPaths: ['private', 'secrets.env'],
          },
        },
        roots: [
          {
            id: 'data',
            kind: 'host-dir',
            path: 'files/data',
            access: 'read-only',
          },
        ],
      },
    });

    expect(parsed.workspace?.roots[0]).toMatchObject({
      id: 'data',
      path: 'files/data',
      createIfMissing: false,
    });
    expect(parsed.workspace?.assistant?.repositoryInspection?.enabled).toBe(false);
    expect(parsed.workspace?.assistant?.repositoryInspection?.excludedPaths).toEqual([
      'private',
      'secrets.env',
    ]);
    expect(parsed.workspace?.name).toBe('Config schema workspace');
    expect(parsed.workspace?.defaultAgentId).toBe('agent_codex');
  });

  it('requires a name and rejects retired workspace-global execution defaults', () => {
    expect(() => WorkspaceConfigSchema.parse({ workspace: {} })).toThrow();
    expect(() =>
      WorkspaceConfigSchema.parse({
        workspace: {
          name: 'Retired defaults workspace',
          defaultModelId: 'reasoning',
          defaultSkillIds: ['skill_protocol'],
        },
      })
    ).toThrow();
  });

  it('binds reusable Agent credential requirements and rejects direct Workspace grants', () => {
    const parsed = WorkspaceConfigSchema.parse({
      schemaVersion: 1,
      workspace: {
        name: 'Credential workspace',
        agents: [
          {
            agentId: 'agent_codex',
            credentialBindings: [
              { requirementId: 'github-token', vaultGrantId: 'grant_workspace_github' },
            ],
            sandbox: {
              credentialDeclarations: [
                {
                  id: 'github_token',
                  purpose: 'Authenticate GitHub CLI.',
                  requirementId: 'github-token',
                  targetEnvVarName: 'GITHUB_TOKEN',
                  visibility: 'runtime-env',
                },
              ],
            },
          },
        ],
      },
    });

    expect(parsed.workspace.agents[0]?.credentialBindings).toEqual([
      { requirementId: 'github-token', vaultGrantId: 'grant_workspace_github' },
    ]);
    expect(() =>
      WorkspaceConfigSchema.parse({
        workspace: {
          name: 'Invalid direct grant workspace',
          agents: [
            {
              agentId: 'agent_codex',
              sandbox: {
                credentialDeclarations: [
                  {
                    id: 'github_token',
                    targetEnvVarName: 'GITHUB_TOKEN',
                    vaultGrantId: 'grant_workspace_github',
                    visibility: 'runtime-env',
                  },
                ],
              },
            },
          ],
        },
      })
    ).toThrow(/must bind reusable credential requirements/);
  });

  it('rejects unsupported kinds, absolute paths, traversal, and duplicate ids', () => {
    expect(() =>
      WorkspaceRootSchema.parse({
        id: 'data',
        kind: 's3',
        path: 'files/data',
        access: 'read-only',
      })
    ).toThrow();
    expect(() =>
      WorkspaceRootSchema.parse({
        id: 'data',
        kind: 'host-dir',
        path: '/tmp/data',
        access: 'read-only',
      })
    ).toThrow();
    expect(() =>
      WorkspaceRootSchema.parse({
        id: 'data',
        kind: 'host-dir',
        path: '../data',
        access: 'read-only',
      })
    ).toThrow();
    expect(() =>
      WorkspaceConfigSchema.parse({
        workspace: {
          name: 'Duplicate roots workspace',
          roots: [
            { id: 'data', kind: 'host-dir', path: 'files/data', access: 'read-only' },
            { id: 'data', kind: 'host-dir', path: 'files/other', access: 'read-only' },
          ],
        },
      })
    ).toThrow();
  });

  it('allows createIfMissing only for read-write roots', () => {
    expect(() =>
      WorkspaceRootSchema.parse({
        id: 'data',
        kind: 'host-dir',
        path: 'files/data',
        access: 'read-only',
        createIfMissing: true,
      })
    ).toThrow();
    expect(
      WorkspaceRootSchema.parse({
        id: 'outputs',
        kind: 'host-dir',
        path: 'artifacts',
        access: 'read-write',
        createIfMissing: true,
      }).createIfMissing
    ).toBe(true);
  });
});

describe('workspace root materialization', () => {
  it('materializes host roots inside the workspace root', () => {
    const workspaceRoot = createWorkspaceRoot();
    mkdirSync(join(workspaceRoot, 'files', 'data'), { recursive: true });

    const roots = materializeWorkspaceRoots({
      workspaceRoot,
      config: {
        workspace: {
          name: 'Materialized workspace',
          roots: [{ id: 'data', kind: 'host-dir', path: 'files/data', access: 'read-only' }],
        },
      },
    });
    const expectedPath = realpathSync(join(workspaceRoot, 'files', 'data'));

    expect(roots).toEqual([
      {
        id: 'data',
        sourceKind: 'host-dir',
        sourcePath: expectedPath,
        workerPath: expectedPath,
        access: 'read-only',
      },
    ]);
  });

  it('creates allowed read-write output roots and rejects missing inputs', () => {
    const workspaceRoot = createWorkspaceRoot();

    expect(() =>
      materializeWorkspaceRoots({
        workspaceRoot,
        config: {
          workspace: {
            name: 'Missing input workspace',
            roots: [{ id: 'data', kind: 'host-dir', path: 'files/data', access: 'read-only' }],
          },
        },
      })
    ).toThrow(WorkspaceRootValidationError);

    const roots = materializeWorkspaceRoots({
      workspaceRoot,
      createMissing: true,
      config: {
        workspace: {
          name: 'Output workspace',
          roots: [
            {
              id: 'outputs',
              kind: 'host-dir',
              path: 'artifacts',
              access: 'read-write',
              createIfMissing: true,
            },
          ],
        },
      },
    });

    expect(roots[0]?.sourcePath).toBe(realpathSync(join(workspaceRoot, 'artifacts')));
  });

  it('rejects symlink escapes during materialization', () => {
    const workspaceRoot = createWorkspaceRoot();
    const outsideRoot = mkdtempSync(join(tmpdir(), 'openkit-outside-root-'));
    symlinkSync(outsideRoot, join(workspaceRoot, 'linked'));

    expect(() =>
      materializeWorkspaceRoots({
        workspaceRoot,
        config: {
          workspace: {
            name: 'Symlink workspace',
            roots: [{ id: 'linked', kind: 'host-dir', path: 'linked', access: 'read-only' }],
          },
        },
      })
    ).toThrow(WorkspaceRootValidationError);
  });
});

describe('config catalogs', () => {
  it('exports workspace schemas and policy entries', () => {
    expect(getConfigSchemaCatalog().some((entry) => entry.kind === 'workspace')).toBe(true);
    expect(getConfigPolicyCatalog()).toContainEqual(
      expect.objectContaining({
        kind: 'workspace',
        path: '$.workspace.roots',
        owner: 'workspace',
        reloadClass: 'session-scoped',
      })
    );
  });
});

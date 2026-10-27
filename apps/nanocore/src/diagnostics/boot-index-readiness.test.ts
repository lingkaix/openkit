import { readFileSync } from 'node:fs';
import {
  createSourceFile,
  forEachChild,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  ModuleKind,
  type Node,
  type ObjectLiteralExpression,
  ScriptTarget,
  transpileModule,
} from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { type BootPhase, runBootPhases } from '../bootstrap/phases.js';
import { restoreWorkspaceRetirementAdmission } from '../bootstrap/readiness.js';
import { restoreWorkspaceRecoveryAdmission } from '../bootstrap/workspace-recovery.js';
import { createApp } from '../test-support/app.js';
import { operationRequest } from '../test-support/operation-request.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

/** Evaluates the actual entrypoint migration phase with only its storage effects substituted. */
function entrypointMigrationPhase(rebuild: () => unknown[]): BootPhase {
  const source = createSourceFile(
    'index.ts',
    readFileSync(new URL('../index.ts', import.meta.url), 'utf8'),
    ScriptTarget.Latest,
    true
  );
  let phase: ObjectLiteralExpression | undefined;
  const visit = (node: Node): void => {
    if (
      isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          isPropertyAssignment(property) &&
          property.name.getText(source) === 'name' &&
          isStringLiteral(property.initializer) &&
          property.initializer.text === 'migrations'
      )
    ) {
      phase = node;
    }
    forEachChild(node, visit);
  };
  visit(source);
  if (!phase) throw new Error('Entrypoint migrations phase is missing.');
  const javascript = transpileModule(`const phase = ${phase.getText(source)};`, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  return new Function(
    'openCoreDbWithIntegrityCheck',
    'applyMigrations',
    'restoreWorkspaceRetirementAdmission',
    'restoreWorkspaceRecoveryAdmission',
    'workspaceMutationAdmission',
    'recoverRunningCapabilityCalls',
    'verifyAndMigrateExistingScopedDatabases',
    'rebuildInvalidExistingWorkspaceDerivedIndexes',
    'recordBootStartAudit',
    'readDataRootLayoutMarker',
    'requireBootValue',
    'listAppliedMigrationIds',
    'FsStore',
    'existsSync',
    'workspaceDbPath',
    'refuseScope',
    `let coreDb; let sharedStore; const dataRoot = '/fixture'; const dataRootLock = {}; const freshCoreInitialization = false;\n${javascript}\nreturn phase;`
  )(
    // Keep both real admission owners; the Core fixture has no registered Workspaces or decisions.
    vi.fn(() => ({
      dataRoot: '/fixture',
      sqlite: {
        prepare: vi.fn(() => ({ all: vi.fn(() => []), pluck: vi.fn().mockReturnThis() })),
      },
    })),
    vi.fn(),
    restoreWorkspaceRetirementAdmission,
    restoreWorkspaceRecoveryAdmission,
    new WorkspaceMutationAdmission(),
    vi.fn(),
    vi.fn((_dataRoot: string, validateFileAuthority?: () => void) => validateFileAuthority?.()),
    rebuild,
    vi.fn(),
    vi.fn(() => ({ layoutVersion: 1 })),
    vi.fn(() => ({ acquisition: 'fixture' })),
    vi.fn(() => []),
    Object.assign(vi.fn(), {
      validateFileAuthority: vi.fn(),
      prototype: { setWorkspaceMutationAdmission: vi.fn() },
    }),
    vi.fn(() => true),
    vi.fn(
      (dataRoot: string, workspaceId: string) =>
        `${dataRoot}/workspaces/${workspaceId}/db/workspace.sqlite`
    ),
    vi.fn()
  ) as BootPhase;
}

describe('entrypoint index-rebuild classification', () => {
  it('reports a completed rebuild as nonblocking information through App diagnostics', async () => {
    const rebuild = vi.fn(() => [{ workspaceId: 'ws_00000000-0000-7981-ab18-24cc470147b4' }]);
    const result = await runBootPhases({
      bootId: 'boot_actual_index_rebuild',
      phases: [entrypointMigrationPhase(rebuild)],
    });
    expect(rebuild).toHaveBeenCalledWith('/fixture');
    expect(result.outcomes[0]?.outcome).toEqual({
      status: 'ok',
      reasons: [
        {
          code: 'storage.index-rebuilt',
          message: 'Rebuilt 1 workspace index set(s).',
          blocks: [],
        },
      ],
    });
    const app = createApp({ bootReadiness: result.readiness });
    const response = await app.request(...operationRequest('diagnostics.app', {}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      boot: {
        overall: 'ready',
        acceptingProductWork: true,
        subsystems: {
          storage: { state: 'ready', reasons: [{ code: 'storage.index-rebuilt', blocks: [] }] },
        },
      },
      readiness: { productWork: 'ready' },
    });
  });

  it('keeps a thrown rebuild blocking rather than classifying it as completed', async () => {
    const rebuild = vi.fn(() => {
      throw new Error('Rebuild failed.');
    });
    const result = await runBootPhases({
      bootId: 'boot_failed_index_rebuild',
      phases: [entrypointMigrationPhase(rebuild)],
    });
    expect(rebuild).toHaveBeenCalledWith('/fixture');
    expect(result.readiness).toMatchObject({
      overall: 'failed',
      acceptingProductWork: false,
      subsystems: { storage: { state: 'failed' } },
    });
  });
});

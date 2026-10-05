import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_ADAPTER_SUPPLY_FORMS } from '@openkit/worker-protocol';
import {
  createSourceFile,
  forEachChild,
  isArrayLiteralExpression,
  isFunctionDeclaration,
  isStringLiteral,
  type Node,
  ScriptTarget,
} from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importWorkspaceSkill } from '../catalog/resource-catalog.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { DeterministicAgentPreparationError } from './agent-preparation-error.js';
import type { WorkerGovernanceBackend } from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';

describe('release-declared catalog Skill supply', () => {
  let coreDb: ReturnType<typeof openCoreDb>;
  let store: ReturnType<typeof createDemoStore>;
  let turn: ReturnType<typeof store.createTurn>;
  let digest: string;

  beforeEach(() => {
    coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-skill-supply-')));
    applyMigrations(coreDb);
    store = createDemoStore({ dataRoot: coreDb.dataRoot });
    turn = store.createTurn('ws_demo', 'th_demo', 'Use catalog Skill', {
      kind: 'user',
      id: 'user_local',
    });
    digest = importWorkspaceSkill({
      activate: true,
      createdAt: '2026-10-05T00:00:00.000Z',
      dataRoot: coreDb.dataRoot,
      displayName: 'Repo guidelines',
      expectedRevision: 0,
      producer: { id: 'user_local', kind: 'user' },
      tree: [
        {
          contentBase64: Buffer.from('# Hello\n').toString('base64'),
          kind: 'file',
          path: 'SKILL.md',
        },
      ],
      workspaceId: turn.workspaceId,
    }).version.digest;
  });

  afterEach(() => {
    coreDb.sqlite.close();
    rmSync(coreDb.dataRoot, { recursive: true, force: true });
  });

  it.each([
    'codex',
    'pi',
    'opencode',
    'deepseek',
  ])('admits qualified %s catalog Skill materialization', (adapter) => {
    const resolved = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: createTestAgentSetup({ adapter, skillIds: ['repo-guidelines'] }),
      agentSessionId: 'as_skill_supply',
      backend: { kind: 'openshell' },
      coreDb,
      createdAt: '2026-10-05T00:00:00.000Z',
      requestId: null,
      turn,
      triggerActor: turn.triggerActor,
      workspaceRoots: [],
    });
    expect(resolved.supply.skills).toEqual([
      expect.objectContaining({
        id: 'repo-guidelines',
        integrity: { sha256: digest },
        allowedRuntimeAdapters: Object.entries(WORKER_ADAPTER_SUPPLY_FORMS)
          .filter(([, forms]) => forms.includes('skill-filesystem-copy'))
          .map(([id]) => id),
        materialization: {
          kind: 'filesystem-copy',
          targetPath: '/openkit/sessions/as_skill_supply/supply/inputs/repo-guidelines',
        },
      }),
    ]);
  });

  it.each([
    'unqualified',
    '__proto__',
  ])('refuses undeclared %s with a typed error before Sandbox effects despite a supply self-report', async (adapter) => {
    const agentSetup = createTestAgentSetup({ adapter, skillIds: ['repo-guidelines'] });
    // Inert runtime additions cannot grant release-owned supply qualification.
    Object.assign(agentSetup.manifest.runtime, { supplyForms: ['skill-filesystem-copy'] });
    admitTestNativeEnvironment(coreDb, agentSetup.manifest);
    const unexpectedBackendCall = vi.fn(() => {
      throw new Error('Unexpected backend effect');
    });
    const backend: WorkerGovernanceBackend = {
      describeCapabilities: unexpectedBackendCall,
      validatePackage: unexpectedBackendCall,
      planSession: unexpectedBackendCall,
      prepareAgentSessionContinuity: unexpectedBackendCall,
      cleanupSession: unexpectedBackendCall,
      materialize: unexpectedBackendCall,
      launch: unexpectedBackendCall,
      update: unexpectedBackendCall,
      collectEvidence: unexpectedBackendCall,
      collectProviderRefreshStatuses: unexpectedBackendCall,
      collectTranscript: unexpectedBackendCall,
      collectWorkspaceChanges: unexpectedBackendCall,
    };
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
    const failure = await executor
      .prepareAgentSessionForTurn(store, {
        agentSetup,
        freshAgentSessionId: 'as_skill_supply',
        requestId: null,
        turn,
        turnInput: 'Use catalog Skill',
        workspaceCwd: null,
        workspaceRoots: [],
      })
      .catch((error: unknown) => error);
    expect(unexpectedBackendCall).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(DeterministicAgentPreparationError);
    expect(failure).toMatchObject({
      code: 'turn_start_failed',
      message: `Worker skill catalog entry is not allowed for ${adapter}: repo-guidelines`,
    });
    expect(store.listThreadAgentSessions(turn.workspaceId, turn.threadId)).toEqual([]);
  });
});

it('contains no literal runtime-name list at Core Skill admission', () => {
  const source = createSourceFile(
    'agent-environment.ts',
    readFileSync(new URL('./agent-environment.ts', import.meta.url), 'utf8'),
    ScriptTarget.Latest,
    true
  );
  const lists: string[] = [];
  const inspect = (node: Node): void => {
    if (
      isArrayLiteralExpression(node) &&
      node.elements.some(
        (element) =>
          isStringLiteral(element) && ['codex', 'pi', 'opencode', 'deepseek'].includes(element.text)
      )
    )
      lists.push(node.getText(source));
    forEachChild(node, inspect);
  };
  for (const statement of source.statements) {
    if (
      isFunctionDeclaration(statement) &&
      ['resolveWorkerSkillSupply', 'assertRuntimeAdapterAllowed'].includes(
        statement.name?.text ?? ''
      )
    )
      inspect(statement);
  }
  expect(lists).toEqual([]);
});

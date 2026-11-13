import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolicyBindingV1, PolicyDocumentV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeWorkspace } from '../auth/operation-authorizer.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { preparePolicyConfiguration } from './configuration.js';
import { preparePolicyDocument, validatePolicyDocument } from './statements.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const otherUserId = 'usr_00000000-0000-7000-8000-000000000002';
const unavailableWorkspaceId = 'ws_00000000-0000-7000-8000-000000000099';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** Authored Policy input, not a fabricated storage receipt or permission decision. */
function gate(workspaceId: string, subjectId = otherUserId): PolicyBindingV1 {
  const scope = {
    subjects: [{ kind: 'human' as const, id: subjectId }],
    actions: ['tool.use'],
    resources: [
      {
        kind: 'mcp-tool' as const,
        workspaceId,
        serverId: 'issues',
        toolName: 'read',
      },
    ],
  };
  return {
    kind: 'binding',
    id: 'required-review',
    state: 'active',
    author: { kind: 'human', id: userId },
    authority: { kind: 'human', userId },
    authoredAt: '2026-11-01T00:00:00.000Z',
    scope,
    lifetime: {
      anchor: {
        owner: { kind: 'workspace', workspaceId },
        kind: 'workspace',
        id: workspaceId,
      },
      notAfter: '2099-12-31T00:00:00.000Z',
    },
    operation: 'mcp.call-tool',
    stage: 'decide',
    mode: 'gate',
    participant: {
      kind: 'deterministic',
      id: 'review',
      version: `sha256:${'1'.repeat(64)}`,
    },
    inputDisclosure: scope,
    order: 0,
    timeoutMs: 100,
    failure: 'escalate-to-human',
    circuit: { failures: 2, recoveryAfterMs: 100 },
  };
}

/** Real identity, current authority, config parser and candidate boundary; no authority double. */
async function fixture(current: PolicyDocumentV1) {
  validatePolicyDocument(current);
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-e10-ceiling-'));
  const coreDb = createTestCoreDb(dataRoot);
  cleanup.push(() => disposeTestStore(dataRoot, coreDb));
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: DEMO_WORKSPACE_ID,
    ownerUserId: userId,
  });
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config/server.jsonc'),
    JSON.stringify({ schemaVersion: 1, policy: { mediation: current } })
  );
  const manager = createRuntimeConfigManager({ dataRoot });
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId,
    workspaceIds: [DEMO_WORKSPACE_ID],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const actor = { kind: 'local' as const, userId };
  return {
    authority(workspaceId: string) {
      return authorizeWorkspace(coreDb, actor, workspaceId, {
        mutating: true,
        policyOperation: 'tool.use',
      });
    },
    prepare(statements: PolicyDocumentV1['statements']) {
      return preparePolicyConfiguration({
        request: {
          targetFamily: 'policy',
          targetId: 'server',
          expectedRevision: files.readFile('server.jsonc').file.revision!,
          changes: {
            proposed: { schemaVersion: 1, statements },
            rationale: 'Review the complete authority change.',
          },
        },
        actor,
        coreDb,
        files,
        loadedPolicy: current,
        store,
        repositoryWorkspaceDb: () => {
          throw new Error('This deterministic candidate needs no Workspace decision reader.');
        },
      });
    },
  };
}

/** Removing an existing Tool prohibition restores the exact subject's blocked capability. */
function prohibition(
  workspaceId: string,
  subjectId = otherUserId
): PolicyDocumentV1['statements'][number] {
  const source = gate(workspaceId, subjectId);
  return {
    kind: 'permission',
    id: 'no-issues-read',
    state: 'active',
    author: source.author,
    authority: source.authority,
    authoredAt: source.authoredAt,
    scope: source.scope,
    lifetime: source.lifetime,
    effect: 'prohibit',
    grant: { kind: 'ordinary' },
  };
}

// Runtime Security E10 Ceiling; Policy Model: Administrative Operations.
// These checks decide refusal at the existing candidate boundary, not an internal call sequence.
describe('E10 full-diff Policy mutation ceiling', () => {
  it.each(['remove', 'inactive', 'shadow', 'shorter-lifetime'] as const)(
    'refuses %s of a required gate outside the author current resource authority',
    async (mutation) => {
      const before = gate(unavailableWorkspaceId);
      const current: PolicyDocumentV1 = {
        schemaVersion: 1,
        statements: [before],
      };
      const f = await fixture(current);
      expect(f.authority(unavailableWorkspaceId)).toBeNull();
      const after =
        mutation === 'remove'
          ? []
          : [
              {
                ...before,
                ...(mutation === 'inactive' || mutation === 'shadow' ? { state: mutation } : {}),
                ...(mutation === 'shorter-lifetime'
                  ? {
                      lifetime: {
                        ...before.lifetime,
                        notAfter: '2098-12-31T00:00:00.000Z',
                      },
                    }
                  : {}),
              },
            ];
      expect(
        preparePolicyDocument({
          current,
          proposed: { schemaVersion: 1, statements: after },
          userId,
          now: '2026-11-13T00:00:00.000Z',
        }).classification
      ).toBe('widening');
      expect(() => f.prepare(after)).toThrow();
    }
  );

  it('refuses deletion of a prohibition outside current resource authority', async () => {
    const f = await fixture({
      schemaVersion: 1,
      statements: [prohibition(unavailableWorkspaceId)],
    });
    expect(f.authority(unavailableWorkspaceId)).toBeNull();
    expect(() => f.prepare([])).toThrow();
  });

  it('refuses extending an allow lifetime outside current resource authority', async () => {
    const source = gate(unavailableWorkspaceId);
    const container = source.lifetime.anchor;
    const before: PolicyDocumentV1['statements'][number] = {
      kind: 'permission',
      id: 'finite-read',
      state: 'active',
      effect: 'allow',
      author: source.author,
      authority: source.authority,
      authoredAt: source.authoredAt,
      scope: {
        subjects: source.scope.subjects,
        actions: ['knowledge.read'],
        resources: [{ kind: 'container', container }],
      },
      lifetime: { anchor: container, notAfter: '2098-12-31T00:00:00.000Z' },
      grant: {
        kind: 'storage-lease',
        knowledgeBaseId: 'kb_00000000-0000-7000-8000-000000000001',
        mount: 'documents',
        pathPrefix: 'shared',
        mode: 'read-only',
      },
    };
    const f = await fixture({ schemaVersion: 1, statements: [before] });
    expect(f.authority(unavailableWorkspaceId)).toBeNull();
    expect(() =>
      f.prepare([
        {
          ...before,
          lifetime: {
            ...before.lifetime,
            notAfter: '2099-12-31T00:00:00.000Z',
          },
        },
      ])
    ).toThrow();
  });

  it('refuses an author removing a prohibition over their own authority', async () => {
    const f = await fixture({
      schemaVersion: 1,
      statements: [prohibition(DEMO_WORKSPACE_ID, userId)],
    });
    expect(f.authority(DEMO_WORKSPACE_ID)).not.toBeNull();
    expect(() => f.prepare([])).toThrow();
  });

  it('permits an in-scope non-self gate withdrawal as a reviewed widening candidate', async () => {
    const f = await fixture({
      schemaVersion: 1,
      statements: [gate(DEMO_WORKSPACE_ID)],
    });
    expect(f.authority(DEMO_WORKSPACE_ID)).not.toBeNull();
    expect(f.prepare([]).after.statements).toEqual([]);
  });
});

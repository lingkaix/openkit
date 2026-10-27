import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policyKernel from '@openkit/policy-kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import {
  initializeScopedNotebook,
  pinScopedNotebook,
  resolveScopedNotebookOwner,
} from '../knowledge/scoped-notebook-owner.js';
import {
  listServerKnowledgeSources,
  registerServerKnowledgeSource,
} from '../knowledge/server-knowledge-owner.js';
import { readUserMemoryNotebookAdmission } from '../knowledge/user-memory-agent-maintenance.js';
import {
  createUserMemoryProposal,
  decideUserMemoryProposal,
  readUserMemoryProposal,
} from '../knowledge/user-memory-proposals.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { createApp } from '../test-support/app.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestUserDb,
} from '../test-support/store.js';
import {
  createOpenKitAccessTokenRecord,
  verifyOpenKitAccessTokenRecord,
} from './access-token-store.js';
import { createBetterAuth } from './better-auth.js';
import type { Actor } from './identity.js';

const cleanups: Array<() => void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Uses the real identity, Token, scoped storage and notebook owners for each admission. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-qp2-knowledge-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const { userDb, close: closeUserDb } = createTestUserDb(dataRoot, userId);
  cleanups.push(() => {
    closeUserDb();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const auth = createBetterAuth(coreDb, { env: { PORT: '3000' } });
  const response = await auth.handler(
    new Request('http://127.0.0.1:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Knowledge administrator',
        email: 'qp2-knowledge-admin@example.invalid',
        password: 'qp2-knowledge-fixture-password-12345',
      }),
    })
  );
  expect(response.status).toBe(200);
  const administratorId: string = (await response.json()).user.id;
  const issued = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: administratorId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const verified = verifyOpenKitAccessTokenRecord(coreDb, issued.secret);
  if (!verified) throw new Error('Fixture administrator must authenticate.');
  const administrator: Actor = {
    kind: 'token',
    userId: verified.ownerUserId,
    tokenId: verified.tokenId,
    tokenScope: verified.scope,
  };
  const actor: Actor = { kind: 'session', userId };
  const initialization = () => ({
    requestId: randomUUID(),
    instructionReference: 'test:qp2-knowledge-authority',
  });
  return {
    dataRoot,
    coreDb,
    userDb,
    userId,
    actor,
    administrator,
    store: createTestStore({ dataRoot }),
    inflightCommands: new WeakMap(),
    initializeUser: () =>
      initializeScopedNotebook({
        coreDb,
        userDb,
        actor,
        target: { kind: 'user' },
        initialization: initialization(),
      }),
    initializeServer: () =>
      initializeScopedNotebook({
        coreDb,
        actor: administrator,
        target: { kind: 'server' },
        initialization: initialization(),
      }),
  };
}

/** Injects a real missing-association denial at the public Kernel boundary, keeping its evaluator active. */
function removeOperationGrants(operation: 'knowledge.read' | 'knowledge.write' | 'review.apply') {
  const evaluate = policyKernel.evaluateAccess;
  vi.spyOn(policyKernel, 'evaluateAccess').mockImplementation((policy, request) =>
    evaluate(request.operation === operation ? { ...policy, associations: [] } : policy, request)
  );
}

describe('QP-2c Knowledge operation authority', () => {
  it('refuses the public first Memory save before binding or publication when Knowledge write is denied', async () => {
    const f = await fixture();
    const app = createApp({ dataRoot: f.dataRoot, coreDb: f.coreDb, store: f.store });
    const owner = { dataRoot: f.dataRoot, scope: { kind: 'user' as const, userId: f.userId } };
    expect(() => readDefaultKnowledgeBaseId(owner)).toThrow();
    const content = serializeKnowledgePageFixture(
      {
        title: 'Explicit first preference',
        content: 'Keep this exact preference.',
        createdAt: '2026-10-27T00:00:00.000Z',
        updatedAt: '2026-10-27T00:00:00.000Z',
      },
      owner.scope
    );
    removeOperationGrants('knowledge.write');
    // Core Knowledge Lifecycle: first publication requires its own current mutation authority.
    const response = await app.request(
      ...operationRequest(
        'memory.create',
        { baseRevision: null, pageId: 'preferences', content, summary: 'First explicit save' },
        { headers: { 'x-openkit-request-id': randomUUID() } }
      )
    );
    expect(response.status).toBe(403);
    expect(existsSync(join(f.dataRoot, 'users', f.userId, 'memory'))).toBe(false);
    expect(() => readDefaultKnowledgeBaseId(owner)).toThrow();
  });

  it('does not lend a write-selected context to a later raw notebook read', async () => {
    const f = await fixture();
    f.initializeUser();
    const context = {
      coreDb: f.coreDb,
      actor: f.actor,
      target: { kind: 'user' } as const,
      operation: 'knowledge.write' as const,
    };
    const pinned = pinScopedNotebook(context);
    expect(pinned.read().revision).toBe(pinned.notebookRevision);
    // Core Knowledge historical reads require current read permission independently of a writer's admission.
    removeOperationGrants('knowledge.read');
    expect(() => pinned.read()).toThrow();
  });

  it.each([
    { operation: 'review.apply', decision: 'rejected' },
    { operation: 'knowledge.write', decision: 'accepted' },
  ] as const)('keeps a retained candidate unchanged when $operation is denied before a $decision decision', async ({
    operation,
    decision,
  }) => {
    const f = await fixture();
    const baseRevision = f.initializeUser();
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(f.dataRoot, 'users', f.userId, 'memory', 'notebook.git'),
    });
    const runtimeConfigManager = createRuntimeConfigManager({ dataRoot: f.dataRoot });
    const context = {
      ...f,
      runtimeConfigManager,
      revalidate: (files: Readonly<Record<string, string>>, paths?: readonly string[]) =>
        readUserMemoryNotebookAdmission({ ...f, runtimeConfigManager }, files, paths),
    };
    const proposal = await createUserMemoryProposal(
      context,
      {
        requestId: randomUUID(),
        baseRevision,
        changes: [
          {
            path: 'index.md',
            content: `${notebook.readRevision(baseRevision).files['index.md']}\nPending navigation change.\n`,
          },
        ],
        summary: 'Review this navigation change',
      },
      { kind: 'agent', id: 'knowledge-manager', responsibleUserId: f.userId },
      []
    );
    const selected = readUserMemoryProposal(context, proposal.id);
    expect(selected.reviews).toEqual([]);
    // Core Knowledge Proposal Review: a retained candidate grants neither a human decision nor publication.
    removeOperationGrants(operation);
    await expect(
      decideUserMemoryProposal(context, {
        requestId: randomUUID(),
        proposalId: proposal.id,
        proposalDigest: selected.proposalDigest,
        baseRevision: proposal.baseRevision,
        candidateRevision: proposal.candidateRevision,
        decision,
      })
    ).rejects.toThrow();
    expect(notebook.publishedRevision()).toBe(baseRevision);
    expect(readUserMemoryProposal(context, proposal.id)).toEqual(selected);
  });

  it('refuses an unknown scoped target even for an administrator with an existing User target', async () => {
    const f = await fixture();
    // Contract Evolution closed-core semantics: administrator eligibility cannot interpret an unknown target kind.
    expect(() =>
      resolveScopedNotebookOwner({
        coreDb: f.coreDb,
        actor: f.administrator,
        target: { kind: 'unsupported', userId: f.userId } as never,
      })
    ).toThrow();
  });

  it.each([
    'self',
    'administrator-inspection',
    'server',
  ] as const)('refuses a pinned %s read when the current Knowledge read association is absent', async (target) => {
    const f = await fixture();
    if (target === 'server') f.initializeServer();
    else f.initializeUser();
    const input = {
      coreDb: f.coreDb,
      actor: target === 'self' ? f.actor : f.administrator,
      target:
        target === 'self'
          ? ({ kind: 'user' } as const)
          : target === 'server'
            ? ({ kind: 'server' } as const)
            : ({ kind: 'user-inspection', userId: f.userId } as const),
    };
    const pinned = pinScopedNotebook(input);
    expect(pinned.ownerScope).toEqual(
      target === 'server' ? { kind: 'server' } : { kind: 'user', userId: f.userId }
    );
    expect(pinned.read().revision).toBe(pinned.notebookRevision);
    // Core Policy: every governed read uses current authority; a pin grants no later access.
    removeOperationGrants('knowledge.read');
    expect(() => pinned.read()).toThrow();
  });

  it.each([
    'user',
    'server',
  ] as const)('refuses fresh %s notebook effects when the Knowledge write association is absent', async (target) => {
    const f = await fixture();
    removeOperationGrants('knowledge.write');
    // Core Policy Personal Conversation And Scoped Learning requires governed Memory/Knowledge mutation.
    expect(target === 'user' ? f.initializeUser : f.initializeServer).toThrow();
    const root =
      target === 'user'
        ? join(f.dataRoot, 'users', f.userId, 'memory')
        : join(f.dataRoot, 'server', 'knowledge');
    expect(existsSync(root)).toBe(false);
  });

  it('refuses Server Source metadata after a Knowledge read denial despite a usable administrator credential', async () => {
    const f = await fixture();
    const input = { ...f, actor: f.administrator };
    const source = await registerServerKnowledgeSource(input, {
      requestId: randomUUID(),
      kind: 'document',
      title: 'Server metadata sentinel',
      content: 'Server original sentinel.',
    });
    expect(listServerKnowledgeSources(input)).toEqual([source]);
    // Core Policy Administrator Eligibility is refined by the Kernel; credential eligibility is insufficient.
    removeOperationGrants('knowledge.read');
    expect(() => listServerKnowledgeSources(input)).toThrow();
  });
});

// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import {
  createOpenKitAccessTokenRecord,
  listOpenKitAccessTokenRecords,
} from '../auth/access-token-store.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { evaluateProductAuthorization } from '../auth/operation-authorizer.js';
import { disableCanonicalUser, isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { createOperationInvocation } from '../operation-composition.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { armCommit, releaseCommit } from '../test-support/control-native-transport.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  getWorkspaceMember,
  getWorkspaceRegistryFact,
  removeWorkspaceMember,
  resolveWorkspaceMembershipRelation,
} from '../workspace-sharing.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { nativeProductScope } from './workspace-file-records.js';

const interception = vi.hoisted(() => ({
  issueWorker: undefined as NativeWorker | undefined,
  issueInputs: [] as string[],
  audits: 0,
  holdIssue: false,
  forward: undefined as (() => void) | undefined,
}));

// Observe the actual existing lifecycle family and real SQLite FULL COMMIT. A held
// request is forwarded unchanged; neither the native writer nor its reply is replaced.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  class ObservedWorker extends actual.Worker {
    override postMessage(
      value: unknown,
      transferList?: readonly import('node:worker_threads').Transferable[]
    ): void {
      const request = value as
        | { operation?: string; input?: { kind?: string; stage?: string } }
        | undefined;
      if (request?.operation === 'access-token-lifecycle' && request.input?.kind === 'issue') {
        interception.issueWorker = this;
        interception.issueInputs.push(JSON.stringify(value));
        if (interception.holdIssue) {
          interception.holdIssue = false;
          interception.forward = () => super.postMessage(value, transferList);
          return;
        }
      }
      if (request?.operation === 'standalone-audit' && request.input?.stage === 'auth.token.issue')
        interception.audits += 1;
      super.postMessage(value, transferList);
    }
  }
  return { ...actual, Worker: nativeCommitWorker(ObservedWorker) };
});

/** Completes the exact retained request without inventing a result or native mutation. */
function forwardIssue() {
  const forward = interception.forward;
  interception.forward = undefined;
  interception.holdIssue = false;
  forward?.();
}

/** Creates Users and a Workspace through their owners before any deliberate failure. */
async function fixture(ordinaryMember = false) {
  await shutdownControlStoreWorkerClient();
  releaseCommit();
  forwardIssue();
  interception.issueWorker = undefined;
  const root = mkdtempSync(join(tmpdir(), 'token-issue-native-'));
  const db = createTestCoreDb(root);
  const handles = [db];
  const pending: Promise<unknown>[] = [];
  onTestFinished(async () => {
    forwardIssue();
    releaseCommit();
    await Promise.allSettled(pending);
    await shutdownControlStoreWorkerClient();
    for (const handle of handles) if (handle.sqlite.open) handle.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  const administratorId = ensureLocalUser(db);
  const auth = createBetterAuth(db, { env: {} });
  const sdk = await auth.$context;
  vi.spyOn(sdk.logger, 'error').mockImplementation(() => {});
  vi.spyOn(sdk.logger, 'warn').mockImplementation(() => {});
  const signup = await auth.handler(
    new Request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Issue target',
        email: 'target@example.test',
        password: 'synthetic-issue-password',
      }),
    })
  );
  expect(signup.status).toBe(200);
  const target = (await signup.json()).user;
  if (typeof target?.id !== 'string')
    throw new Error('SDK fixture did not create its target User.');
  const administrator = createOpenKitAccessTokenRecord(db, {
    ownerUserId: administratorId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const workspace = await createTestStore({ dataRoot: root }).createWorkspace(
    'Issue target Workspace'
  );
  recordWorkspaceOwnerMembership({
    coreDb: db,
    ownerUserId: ordinaryMember ? administratorId : target.id,
    workspaceId: workspace.id,
  });
  const scope = nativeProductScope(root, { kind: 'server' });
  await getControlStoreWorkerClient().open({
    database: `core:${scope.path}`,
    path: scope.path,
    dataRoot: root,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  const context: AdmittedOperationContext = {
    kind: 'public',
    actor: {
      kind: 'token',
      userId: administratorId,
      tokenId: administrator.tokenId,
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
    },
    actorRef: { kind: 'user', id: administratorId },
    scope: { kind: 'server' },
  };
  if (ordinaryMember) {
    // Reach ordinary membership through its invitation owners and a real current Kernel result.
    const invitation = db.sqlite.transaction(() =>
      createWorkspaceInvitation({
        coreDb: db,
        workspaceId: workspace.id,
        inviterUserId: administratorId,
        inviteeEmail: 'target@example.test',
        authorization: evaluateProductAuthorization(
          db,
          context.actor,
          { kind: 'workspace', workspaceId: workspace.id },
          'membership.manage',
          true
        ),
      })
    )();
    if (invitation.kind !== 'created') throw new Error('Fixture invitation was not created.');
    const accepted = db.sqlite.transaction(() =>
      acceptWorkspaceInvitation({
        coreDb: db,
        workspaceId: workspace.id,
        invitationId: invitation.invitation.invitationId,
        inviteeUserId: target.id,
        expectedRevision: invitation.invitation.revision,
      })
    )();
    if (accepted.kind !== 'accepted') throw new Error('Fixture invitation was not accepted.');
    expect(resolveWorkspaceMembershipRelation(db, workspace.id, target.id)).toBe('member');
  }
  const operations = createAccessTokenOperationImplementations({ coreDb: db, mode: 'server' });
  const input = {
    ownerUserId: target.id as string,
    scope: 'workspace-readonly' as const,
    workspaceIds: [workspace.id, workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  interception.issueInputs.length = 0;
  interception.audits = 0;
  const records = () => listOpenKitAccessTokenRecords(db);
  const auditCount = () =>
    listServerAuditEvents(db).filter((event) => event.action === 'auth.token.issue').length;
  const before = records().length;
  const beforeAudit = auditCount();
  const start = (invoke = () => operations['token.create'](input, context)) => {
    let finished = false;
    const result = invoke()
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({
          ok: false as const,
          code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
          status:
            error && typeof error === 'object' && 'status' in error ? error.status : undefined,
        })
      )
      .then((value) => {
        finished = true;
        return value;
      });
    pending.push(result);
    return { result, finished: () => finished };
  };
  const reopen = async () => {
    await shutdownControlStoreWorkerClient();
    if (db.sqlite.open) db.sqlite.close();
    const cold = openCoreDb(root);
    handles.push(cold);
    return cold;
  };
  return {
    db,
    input,
    context,
    administrator,
    workspace,
    before,
    beforeAudit,
    records,
    auditCount,
    start,
    reopen,
  };
}

/** Detects OLD synchronous completion without ever printing its returned credential. */
async function reached(predicate: () => boolean, work: { finished(): boolean }) {
  await vi.waitFor(() => expect(predicate() || work.finished()).toBe(true), { timeout: 5000 });
  await nextTurn();
  expect(predicate()).toBe(true);
  expect(work.finished()).toBe(false);
}

it('rechecks the admitted caller administrator after native revoke while its separately eligible target issue waits', async () => {
  const f = await fixture();
  // Compose actual Primary Kernel admission with the actual public Token implementation.
  const invoke = createOperationInvocation({ coreDb: f.db, mode: 'server' });
  interception.holdIssue = true;
  const work = f.start(() => invoke('token.create', f.input, f.context));
  await reached(() => interception.forward !== undefined, work);
  const revoked = await invoke('token.revoke', { tokenId: f.administrator.tokenId }, f.context);
  expect(revoked.record.status === 'revoked').toBe(true);
  expect(f.input.ownerUserId !== f.context.actor.userId).toBe(true);
  expect(isCanonicalUserActive(f.db, f.input.ownerUserId)).toBe(true);
  expect(
    resolveWorkspaceMembershipRelation(f.db, f.workspace.id, f.input.ownerUserId) !== null
  ).toBe(true);
  // Pin the existing public refusal; this queued request carries no durable admission grant.
  const fresh = await invoke('token.create', f.input, f.context).then(
    () => ({ refused: false, code: undefined, status: undefined }),
    (error: unknown) => ({
      refused: true,
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
      status: error && typeof error === 'object' && 'status' in error ? error.status : undefined,
    })
  );
  expect(fresh.refused && fresh.code === 'deployment_admin_required' && fresh.status === 403).toBe(
    true
  );
  forwardIssue();
  const result = await work.result;
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.code === 'deployment_admin_required' && result.status === 403).toBe(true);
  expect(f.records().length).toBe(f.before);
  expect(f.auditCount()).toBe(f.beforeAudit);
  expect(interception.audits).toBe(0);
});

it('issues with Main query-only and waits for the real canonical FULL acknowledgement before later Audit and secret return', async () => {
  const f = await fixture();
  f.db.sqlite.pragma('query_only = ON');
  const gate = armCommit(2);
  const work = f.start();
  await reached(() => Atomics.load(gate, 0) === 1, work);
  expect(Atomics.load(gate, 5)).toBe(2);
  expect(interception.issueInputs.length).toBe(1);
  expect(interception.audits).toBe(0);
  expect(f.records().length).toBe(f.before + 1);
  expect(f.auditCount()).toBe(f.beforeAudit);
  expect(f.db.sqlite.inTransaction).toBe(false);
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  releaseCommit();
  const result = await work.result;
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { record, token } = result.value;
  expect(record.ownerUserId === f.input.ownerUserId && record.scope === f.input.scope).toBe(true);
  expect(record.workspaceIds.length === 1 && record.workspaceIds[0] === f.workspace.id).toBe(true);
  expect(record.expiresAt === f.input.expiresAt).toBe(true);
  expect(Number.isFinite(Date.parse(record.issuedAt))).toBe(true);
  expect(interception.audits).toBe(1);
  expect(f.auditCount()).toBe(f.beforeAudit + 1);
  // Inspect only booleans: neither fixture nor newly generated secrets may cross the native arm.
  expect(
    interception.issueInputs.every(
      (text) => !text.includes(token) && !text.includes(f.administrator.secret)
    )
  ).toBe(true);
  const row = f.db.sqlite
    .prepare('SELECT token_hash FROM openkit_access_tokens WHERE token_id = ?')
    .get(record.tokenId) as { token_hash: string };
  expect(row.token_hash.startsWith('sha256:') && !row.token_hash.includes(token)).toBe(true);
});

it('retains a lost canonical issue result after reopen without later Audit or automatic replay, while a new explicit issue stays legal', async () => {
  const f = await fixture();
  const gate = armCommit(2);
  const work = f.start();
  await reached(() => Atomics.load(gate, 0) === 1, work);
  expect(interception.issueInputs.length).toBe(1);
  expect(interception.audits).toBe(0);
  expect(f.records().length).toBe(f.before + 1);
  const worker = interception.issueWorker;
  if (!worker) throw new Error('The actual issue-request Worker was not observed.');
  await worker.terminate();
  expect((await work.result).ok).toBe(false);
  expect(interception.issueInputs.length).toBe(1);
  releaseCommit();
  const cold = await f.reopen();
  expect(listOpenKitAccessTokenRecords(cold).length).toBe(f.before + 1);
  expect(
    listServerAuditEvents(cold).filter((event) => event.action === 'auth.token.issue').length
  ).toBe(f.beforeAudit);
  expect(interception.audits).toBe(0);
  const operations = createAccessTokenOperationImplementations({ coreDb: cold, mode: 'server' });
  const second = await operations['token.create'](f.input, f.context);
  expect(typeof second.token === 'string').toBe(true);
  expect(listOpenKitAccessTokenRecords(cold).length).toBe(f.before + 2);
});

it('rolls back a real late Token INSERT refusal and preserves the original records after reopen', async () => {
  const f = await fixture();
  const before = JSON.stringify(f.records());
  // Fault after the real INSERT starts; valid setup still comes from the owned User/Workspace/Token operations.
  f.db.sqlite.exec(`CREATE TRIGGER reject_test_issue AFTER INSERT ON openkit_access_tokens
    BEGIN SELECT RAISE(ABORT, 'Synthetic late issue SQL refusal'); END`);
  expect((await f.start().result).ok).toBe(false);
  expect(JSON.stringify(f.records()) === before).toBe(true);
  expect(f.auditCount()).toBe(f.beforeAudit);
  expect(interception.audits).toBe(0);
  const cold = await f.reopen();
  expect(JSON.stringify(listOpenKitAccessTokenRecords(cold)) === before).toBe(true);
});

it('allows two concurrent independent issues for the same target with distinct usable credentials', async () => {
  const f = await fixture();
  const attempts = [f.start(), f.start()];
  expect(f.db.sqlite.inTransaction).toBe(false);
  const results = await Promise.all(attempts.map((work) => work.result));
  expect(results.every((result) => result.ok)).toBe(true);
  const issued = results.flatMap((result) => (result.ok ? [result.value] : []));
  expect(
    issued.length === 2 &&
      issued[0]?.record.tokenId !== issued[1]?.record.tokenId &&
      issued[0]?.token !== issued[1]?.token
  ).toBe(true);
  expect(f.records().length).toBe(f.before + 2);
  expect(f.auditCount()).toBe(f.beforeAudit + 2);
  for (const value of issued) {
    expect(
      value.record.ownerUserId === f.input.ownerUserId &&
        value.record.expiresAt === f.input.expiresAt
    ).toBe(true);
    expect(
      (await verifyOpenKitAccessTokenRecord(f.db, value.token))?.tokenId === value.record.tokenId
    ).toBe(true);
  }
});

it.each(['owner', 'membership', 'registry'] as const)(
  'rechecks current target %s facts after preparation waits before the native effect',
  async (kind) => {
    const f = await fixture(kind === 'membership');
    interception.holdIssue = true;
    const work = f.start();
    await reached(() => interception.forward !== undefined, work);
    if (kind === 'owner') {
      f.db.sqlite.transaction(() => disableCanonicalUser(f.db, f.input.ownerUserId))();
    } else if (kind === 'membership') {
      const member = getWorkspaceMember(f.db, f.workspace.id, f.input.ownerUserId);
      if (!member) throw new Error('The ordinary target membership was not established.');
      const removed = f.db.sqlite.transaction(() =>
        removeWorkspaceMember({
          coreDb: f.db,
          workspaceId: f.workspace.id,
          actorUserId: f.context.actor.userId,
          memberUserId: f.input.ownerUserId,
          expectedRevision: member.revision,
          authorization: evaluateProductAuthorization(
            f.db,
            f.context.actor,
            { kind: 'workspace', workspaceId: f.workspace.id },
            'membership.manage',
            true
          ),
        })
      )();
      expect(removed.kind).toBe('removed');
      expect(
        getWorkspaceRegistryFact(f.db, f.workspace.id)?.ownerUserId === f.context.actor.userId
      ).toBe(true);
      expect(
        isCanonicalUserActive(f.db, f.context.actor.userId) &&
          isCanonicalUserActive(f.db, f.input.ownerUserId)
      ).toBe(true);
    } else {
      f.db.sqlite
        .prepare(
          "UPDATE workspace_registry SET status = 'retired', revision = revision + 1 WHERE workspace_id = ?"
        )
        .run(f.workspace.id);
    }
    forwardIssue();
    const result = await work.result;
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(
        result.code ===
          (kind === 'owner' ? 'access_token_owner_invalid' : 'core.auth.scope_forbidden')
      ).toBe(true);
    expect(f.records().length).toBe(f.before);
    expect(f.auditCount()).toBe(f.beforeAudit);
    expect(interception.audits).toBe(0);
  }
);

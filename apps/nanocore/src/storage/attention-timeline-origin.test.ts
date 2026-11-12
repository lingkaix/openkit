import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StartTaskModeResponseSchema } from '@openkit/app-api-schemas';
import {
  type ActorRef,
  allocateEntityId,
  type Item,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHumanAttention, readScopedHumanAttention } from '../action-center.js';
import * as authorization from '../auth/operation-authorizer.js';
import { isThreadVisible } from '../auth/thread-visibility.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import * as productTurnStart from '../runtime/product-turn-start.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { recordActiveHumanWorkspaceMember } from '../test-support/active-human-member.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { commandInputHash } from './control-store-input.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';

const cleanups: Array<() => Promise<void>> = [];
const startedAt = '2026-11-11T10:00:00.000Z';
const requestedAt = '2026-11-11T10:05:00.000Z';
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type QuestionItem = Extract<Item, { type: 'user-input-request' }>;

/** Uses actual native stores and the existing canonical identity/membership builders; no SQL or private record writes. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'attention-timeline-origin-'));
  const coreDb = createTestCoreDb(root);
  const handles: WorkspaceDb[] = [];
  cleanups.push(() => disposeTestStore(root, ...handles, coreDb));
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  handles.push(workspaceDb);
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Attention provenance');
  const viewer = { kind: 'local', userId } as const;
  const human = { kind: 'user', id: userId } as const;
  const input = {
    store,
    coreDb,
    workspaceDb,
    workspaceId: DEMO_WORKSPACE_ID,
    actor: viewer,
    administratorEligible: authorization.isCurrentDeploymentAdministrator(coreDb, viewer),
  };
  const full = () =>
    readHumanAttention({
      ...input,
      repositoryWorkspaceDb: () => openWorkspaceDb(root, DEMO_WORKSPACE_ID),
    }).items;
  const scoped = () => readScopedHumanAttention({ ...input, threadIds: [thread.id] }).items;
  const both = (rowId: string) => {
    // Control only the read clock, after all producer acknowledgements, so whole-row equality is stable.
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      const complete = full().find((row) => row.id === rowId);
      const selected = scoped().find((row) => row.id === rowId);
      expect(complete, `Missing full attention row ${rowId}`).toBeDefined();
      expect(selected, `Missing scoped attention row ${rowId}`).toBeDefined();
      expect(selected).toEqual(complete);
      return complete!;
    } finally {
      vi.useRealTimers();
    }
  };
  /** Publishes the request and exact source Item together through the original Pending owner. */
  const question = async (
    options: {
      actor?: ActorRef;
      source?: 'user-input' | 'handoff' | 'automation';
      texts?: string[];
      secret?: boolean;
    } = {}
  ) => {
    const actor = options.actor ?? human;
    const responsible = responsibleUserIdForActor(actor);
    if (!responsible) throw new Error('A canonical question requires its actual responsible User.');
    const turn = await store.createTurn(
      DEMO_WORKSPACE_ID,
      thread.id,
      'Original admission input',
      actor,
      null,
      {
        agentId: 'agent_demo',
        startedAt,
        ...(options.source
          ? {
              triggerSource: {
                kind: options.source,
                summary: 'Descriptive text is not the causal oracle.',
              },
            }
          : {}),
      }
    );
    const requestId = randomUUID();
    const questions = (
      options.texts ?? ['  Which exact path should be used?\nKeep the recorded spacing.  ']
    ).map((text, index) => ({
      id: `question-${index}`,
      header: `Header, not the question ${index}`,
      question: text,
      options: [{ label: 'Option, not the question', description: 'Option description only' }],
      isOther: true,
      isSecret: options.secret ?? false,
    }));
    const item: QuestionItem = {
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: responsible,
      userInputRequestId: requestId,
      prompt: 'Prompt metadata is deliberately different from the decision question.',
      questions,
      createdAt: requestedAt,
      completedAt: requestedAt,
    };
    await raiseRecordedPendingRequest(
      store,
      workspaceDb.sqlite,
      {
        requestId,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: thread.id,
        raisingTurnId: turn.id,
        requestItemId: item.id,
        kind: 'user-input',
        requesterKind: 'assistant',
        responsibleUserId: responsible,
        questions,
        questionDigest: commandInputHash(questions),
        now: requestedAt,
      },
      item
    );
    expect(readPendingRequest(workspaceDb.sqlite, requestId)).toMatchObject({
      state: 'pending',
      requestItemId: item.id,
    });
    expect(store.getTurnById(turn.id).items.find((candidate) => candidate.id === item.id)).toEqual(
      item
    );
    return { turn, item, requestId, rowId: `question:${requestId}` };
  };
  return {
    root,
    coreDb,
    store,
    workspaceDb,
    thread,
    userId,
    human,
    viewer,
    input,
    full,
    scoped,
    both,
    question,
  };
}

describe('Shared attention run origin and exact question summary', () => {
  it('uses the exact raising run actor/time, not request creation or the later current run, across full and scoped reads', async () => {
    const f = await fixture();
    const q = await f.question({ source: 'user-input' });
    const row = f.both(q.rowId);
    expect(row.createdAt).toBe(requestedAt);
    expect(row.origin).toEqual({
      startedBy: f.human,
      startedAt,
      viewerStartedRun: true,
      viewerCausedHandoff: false,
    });
    expect(row.questionSummary).toEqual({ text: q.item.questions[0]!.question, truncated: false });
    expect(row.questionSummary!.text).not.toBe(q.item.prompt);
    await f.store.completeTurn(q.turn.id, {
      status: 'completed',
      completedAt: '2026-11-11T10:10:00.000Z',
    });
    await f.store.createTurn(DEMO_WORKSPACE_ID, f.thread.id, 'A later run', f.human, null, {
      startedAt: '2026-11-11T10:15:00.000Z',
      triggerSource: { kind: 'handoff', summary: 'Unrelated later cause' },
    });
    const later = f.both(q.rowId);
    expect(later.origin).toEqual(row.origin);
    expect(later.questionSummary).toEqual(row.questionSummary);
    expect(later.blocking).toBe(false);
  }, 30_000);

  it('joins actual question strings in their canonical order with exactly two newlines', async () => {
    const f = await fixture();
    const texts = ['  First question?  ', 'Second question?\nWith its own line.'];
    const q = await f.question({ texts });
    const row = f.both(q.rowId);
    expect(row.questionSummary).toEqual({
      text: '  First question?  \n\nSecond question?\nWith its own line.',
      truncated: false,
    });
    expect(row.origin).toMatchObject({ viewerStartedRun: true, viewerCausedHandoff: null });
  }, 30_000);

  it.each(['agent', 'system'] as const)(
    'preserves the %s starter without treating viewer accountability as initiation or handoff causation',
    async (kind) => {
      const f = await fixture();
      const actor = { kind, id: 'agent_demo', responsibleUserId: f.userId } as const;
      const q = await f.question({ actor, source: 'handoff' });
      expect(f.both(q.rowId).origin).toEqual({
        startedBy: actor,
        startedAt,
        viewerStartedRun: null,
        viewerCausedHandoff: null,
      });
    },
    30_000
  );

  it('computes human handoff relationships separately for each admitted viewer', async () => {
    const f = await fixture();
    const otherId = allocateEntityId('usr');
    recordActiveHumanWorkspaceMember(f.coreDb, {
      userId: otherId,
      email: 'other@example.invalid',
      workspaceId: DEMO_WORKSPACE_ID,
      joinedAt: startedAt,
      nowMs: Date.parse(startedAt),
    });
    const actor = { kind: 'user', id: otherId } as const;
    const q = await f.question({ actor, source: 'handoff' });
    expect(f.both(q.rowId).origin).toEqual({
      startedBy: actor,
      startedAt,
      viewerStartedRun: false,
      viewerCausedHandoff: false,
    });
    const otherViewer = { kind: 'session', userId: otherId } as const;
    const member = {
      ...f.input,
      actor: otherViewer,
      administratorEligible: authorization.isCurrentDeploymentAdministrator(f.coreDb, otherViewer),
    };
    const memberFull = readHumanAttention({
      ...member,
      repositoryWorkspaceDb: () => openWorkspaceDb(f.root, DEMO_WORKSPACE_ID),
    }).items;
    const memberScoped = readScopedHumanAttention({ ...member, threadIds: [f.thread.id] }).items;
    for (const rows of [memberFull, memberScoped]) {
      const own = rows.find((row) => row.id === q.rowId);
      expect(own).toBeDefined();
      expect(own!.origin).toEqual({
        startedBy: actor,
        startedAt,
        viewerStartedRun: true,
        viewerCausedHandoff: true,
      });
    }
  }, 30_000);

  it('does not use request-response permission as independent thread.read permission', async () => {
    const f = await fixture();
    const q = await f.question({ source: 'user-input' });
    const baseline = f.both(q.rowId);
    expect(
      authorization.isWorkspaceOperationAuthorized(f.coreDb, f.viewer, DEMO_WORKSPACE_ID, {
        mutating: false,
        policyOperation: 'thread.read',
      })
    ).toBe(true);
    // Deny only the independent Workspace operation decision. Do not also revoke the row's Thread audience.
    const authorize = authorization.isWorkspaceOperationAuthorized;
    const permission = vi
      .spyOn(authorization, 'isWorkspaceOperationAuthorized')
      .mockImplementation((...args) =>
        args[3].policyOperation === 'thread.read' ? false : authorize(...args)
      );
    expect(isThreadVisible(f.store, f.thread, f.userId, f.input.administratorEligible)).toBe(true);
    expect(
      authorization.isWorkspaceOperationAuthorized(f.coreDb, f.viewer, DEMO_WORKSPACE_ID, {
        mutating: false,
        policyOperation: 'thread.read',
      })
    ).toBe(false);
    expect(
      authorization.isWorkspaceOperationAuthorized(f.coreDb, f.viewer, DEMO_WORKSPACE_ID, {
        mutating: true,
        policyOperation: 'approval.respond',
      })
    ).toBe(true);
    const denied = f.both(q.rowId);
    expect(denied.origin).toBeNull();
    expect(denied.questionSummary).toBeNull();
    expect(denied.actions).toEqual(baseline.actions);
    expect(denied.source).toEqual(baseline.source);
    expect(denied.summary).toBe(baseline.summary);
    for (const text of [
      q.item.prompt,
      q.item.questions[0]!.question,
      q.item.questions[0]!.header,
    ]) {
      expect(JSON.stringify(denied)).not.toContain(JSON.stringify(text).slice(1, -1));
    }
    expect(denied.blocking).toBe(baseline.blocking);
    permission.mockRestore();
    const restored = f.both(q.rowId);
    expect(restored.origin).toEqual(baseline.origin);
    expect(restored.questionSummary).toEqual(baseline.questionSummary);
  }, 30_000);

  it('keeps an admitted viewer row but publishes no new source value without the Core read-admission owner', async () => {
    const f = await fixture();
    const q = await f.question();
    const rows = readScopedHumanAttention({
      store: f.store,
      workspaceDb: f.workspaceDb,
      workspaceId: DEMO_WORKSPACE_ID,
      actor: f.viewer,
      administratorEligible: f.input.administratorEligible,
      threadIds: [f.thread.id],
    }).items;
    const row = rows.find((candidate) => candidate.id === q.rowId);
    expect(row).toBeDefined();
    expect(row!.origin).toBeNull();
    expect(row!.questionSummary).toBeNull();
  }, 30_000);

  it('does not publish secret question text or change its disabled decision semantics', async () => {
    const f = await fixture();
    const q = await f.question({ secret: true });
    const row = f.both(q.rowId);
    expect(row.questionSummary).toBeNull();
    expect(row.origin).toMatchObject({ startedBy: f.human, viewerStartedRun: true });
    expect(row.actions.find((action) => action.kind === 'answer_question')).toMatchObject({
      disabled: true,
    });
  }, 30_000);

  it.each([1022, 1023])(
    'applies the 1024 UTF-8 JSON text bound to an original question of %i ASCII characters',
    async (length) => {
      const f = await fixture();
      const text = 'a'.repeat(length);
      const q = await f.question({ texts: [text] });
      const preview = f.both(q.rowId).questionSummary;
      expect(preview).not.toBeNull();
      expect(Buffer.byteLength(JSON.stringify(preview!.text))).toBeLessThanOrEqual(1024);
      expect(preview!.truncated).toBe(length === 1023);
      if (length === 1022) expect(preview!.text).toBe(text);
      else {
        expect(preview!.text.length).toBeGreaterThan(0);
        expect(text.startsWith(preview!.text)).toBe(true);
      }
    },
    30_000
  );

  it('marks a bounded escaped-Unicode prefix without replacement bytes, ellipsis or rewritten content', async () => {
    const f = await fixture();
    const text = '🧭"\n\\'.repeat(150);
    const q = await f.question({ texts: [text] });
    const preview = f.both(q.rowId).questionSummary;
    expect(preview).not.toBeNull();
    expect(preview!.truncated).toBe(true);
    expect(preview!.text.length).toBeGreaterThan(0);
    expect(text.startsWith(preview!.text)).toBe(true);
    expect(preview!.text).not.toContain('\uFFFD');
    expect(Buffer.byteLength(JSON.stringify(preview!.text))).toBeLessThanOrEqual(1024);
  }, 30_000);

  it('keeps contradictory request lineage inspect-only without presenting either competing question as its summary', async () => {
    const f = await fixture();
    const q = await f.question();
    await f.store.completeTurn(q.turn.id, {
      status: 'completed',
      completedAt: '2026-11-11T10:10:00.000Z',
    });
    const next = await f.store.createTurn(
      DEMO_WORKSPACE_ID,
      f.thread.id,
      'Later original run',
      f.human
    );
    // Deliberate post-setup contradiction through the real Item publisher, never a fake Pending row or receipt.
    await f.store.createItem({
      ...q.item,
      id: allocateEntityId('it'),
      turnId: next.id,
      prompt: 'Conflicting metadata',
      questions: [
        {
          ...q.item.questions[0]!,
          question: 'A competing question must not replace the original.',
        },
      ],
    });
    const row = f.both(q.rowId);
    expect(row.questionSummary).toBeNull();
    expect(row.actions.map((action) => action.kind)).toEqual(['open_thread']);
  }, 30_000);

  it('keeps a real scheduler row without inventing origin before its source Turn has been published', async () => {
    const f = await fixture();
    // This is the original admission owner's normal queue-before-Turn interval, not a forged missing pointer.
    const entry = createSchedulerAdmissionEntry(f.coreDb, {
      backendId: 'nanohost',
      requestId: randomUUID(),
      queueEntryId: randomUUID(),
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: f.thread.id,
      turnId: allocateEntityId('tu'),
      turnInput: 'Existing scheduler admission',
      triggerActor: f.human,
      requestedAgentId: 'agent_demo',
    });
    const row = f
      .full()
      .find((candidate) => candidate.id === `scheduler-admission:${entry.queueEntryId}`);
    expect(row).toBeDefined();
    expect(row!.source.type).toBe('scheduler_admission');
    expect(row!.origin).toBeNull();
    expect(row!.questionSummary).toBeNull();
  }, 30_000);

  it('derives positive viewer-caused handoff only from the real public Task producer metadata', async () => {
    const f = await fixture();
    await recordTestNativeRuntimeTarget(f.coreDb);
    const setup = createTestAgentSetup();
    const fileAdmission = new FileStorageAdmission(f.root, () => 1_000_000n);
    const executor = new SimulatedTurnExecutor({ coreDb: f.coreDb, fileAdmission });
    const closeouts: Promise<unknown>[] = [];
    const observe = productTurnStart.observeTurnAdmission;
    vi.spyOn(productTurnStart, 'observeTurnAdmission').mockImplementation((input) => {
      const observed = observe(input);
      closeouts.push(observed.closeout);
      return observed;
    });
    cleanups.push(async () => {
      await Promise.allSettled(closeouts);
    });
    const app = createApp({
      coreDb: f.coreDb,
      store: f.store,
      fileAdmission,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    });
    const response = await app.request(
      ...operationRequest(
        'task.start',
        { workspaceId: DEMO_WORKSPACE_ID, threadId: f.thread.id },
        {
          body: JSON.stringify({
            requestId: randomUUID(),
            input: 'Ask the actual Task owner for the recorded path.',
          }),
        }
      )
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(202);
    const accepted = StartTaskModeResponseSchema.parse(body);
    await Promise.all(closeouts);
    const turn = f.store.getTurnById(accepted.turn.id);
    expect(turn.triggerActor).toEqual(f.human);
    expect(turn.triggerSource?.kind).toBe('handoff');
    const item = turn.items.find(
      (candidate): candidate is QuestionItem => candidate.type === 'user-input-request'
    );
    expect(item).toBeDefined();
    const row = f.both(`question:${item!.userInputRequestId}`);
    expect(row.origin).toEqual({
      startedBy: turn.triggerActor,
      startedAt: turn.startedAt,
      viewerStartedRun: true,
      viewerCausedHandoff: true,
    });
    expect(row.questionSummary).toEqual({
      text: item!.questions.map((question) => question.question).join('\n\n'),
      truncated: false,
    });
  }, 45_000);
});

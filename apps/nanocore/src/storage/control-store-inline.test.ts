import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ArtifactSchema,
  allocateEntityId,
  ItemSchema,
  PROTOCOL_VERSION,
  SseEventEnvelopeSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareAuditEvent } from '../audit-events.js';
import { commandRequestKey } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { testGoalDomainProposal } from '../test-support/goal-domain.js';
import { createTestStore } from '../test-support/store.js';
import type { ControlAdmission } from './control-store-admission.js';
import { openControlStoreProductReadHandle } from './control-store-products.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { CONTROL_WORKER_VERSION, isControlWorkerRequest } from './control-store-worker-protocol.js';
import { publishImmutableProductJson } from './immutable-content.js';
import { nativeProductScope, readNativeProductEntries } from './workspace-file-records.js';

const roots: string[] = [];
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates acknowledged native dependencies through the shared Store builder. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'control-store-inline-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Inline retained bytes');
  const thread = await store.createThread(workspace.id, 'Exact byte boundary');
  const turn = await store.createTurn(workspace.id, thread.id, 'Input', actor);
  const item = ItemSchema.parse({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    actor,
    text: 'Acknowledged original',
    status: 'completed',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
  return { root, store, workspace, thread, turn, item, scope };
}

/** Reads the committed owner cut, including receipts, without interpreting body storage layout. */
function cut(f: Awaited<ReturnType<typeof fixture>>) {
  const reader = openControlStoreProductReadHandle(f.scope.path, f.scope.owner);
  try {
    return {
      turn: reader.get('turn', f.turn.id)!,
      items: reader.entries(f.turn.id, 'item'),
      events: reader.entries(f.turn.id, 'event'),
      receipts: reader.sqlite
        .prepare('SELECT * FROM idempotency_requests ORDER BY request_key')
        .all(),
    };
  } finally {
    reader.close();
  }
}

/** Makes a boundary body with multibyte text and JSON escapes rather than a character-count proxy. */
function boundaryItem(f: Awaited<ReturnType<typeof fixture>>, byteLength: number) {
  const item = { ...f.item, id: allocateEntityId('it'), text: 'é😀\n"\\' };
  const missing = byteLength - Buffer.byteLength(JSON.stringify(writeRetainedV1(item)), 'utf8');
  item.text += 'x'.repeat(missing);
  expect(Buffer.byteLength(JSON.stringify(writeRetainedV1(item)), 'utf8')).toBe(byteLength);
  return item;
}

/** Describes the same supplied original JSON bytes in either existing retained representation. */
function retainedContent(owner: ReturnType<typeof nativeProductScope>['owner'], body: string) {
  const contentDigest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const metadata = { byteLength: Buffer.byteLength(body), mediaType: 'application/json' };
  return {
    inline: {
      ...metadata,
      reference: { representation: 'inline' as const, body, contentDigest, ownerScope: owner },
    },
    file: {
      ...metadata,
      reference: {
        knowledgeBaseId: null,
        contentDigest,
        locator: {
          ownerScope: owner,
          mount: 'backend-evidence',
          path: `sha256/${contentDigest.slice('sha256:'.length)}`,
        },
        range: null,
        availability: 'available' as const,
      },
    },
  };
}

/** Observes the storage-owned exact representation through the native reader's public descriptor. */
function exactBytes(f: Awaited<ReturnType<typeof fixture>>, content: unknown): Buffer {
  const descriptor = content as {
    reference: { representation?: string; body?: string; locator?: { path: string } };
  };
  if (descriptor.reference.representation === 'inline')
    return Buffer.from(descriptor.reference.body!, 'utf8');
  expect(descriptor.reference.locator).toBeDefined();
  return readFileSync(join(f.scope.contentMount.root, descriptor.reference.locator!.path));
}

/** Reopens current source owners in a fresh process and compares original bytes after public decoding. */
async function expectFreshProcessBytes(
  f: Awaited<ReturnType<typeof fixture>>,
  expected: Array<{
    kind: 'item' | 'event';
    row: ReturnType<typeof cut>['items'][number];
    bytes: Buffer;
  }>
) {
  const child = await new Promise<{
    error: Error | undefined;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const processChild = execFile(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const { register } = await import(process.argv[1]);
register();
const { nativeProductScope, readNativeProductEntries } = await import(process.argv[2]);
const { openControlStoreProductReadHandle } = await import(process.argv[3]);
const input = JSON.parse(readFileSync(0, 'utf8'));
const scope = nativeProductScope(input.dataRoot, input.owner);
const validated = new Map(['item', 'event'].map(kind => [
  kind, readNativeProductEntries(scope, input.turnId, kind),
]));
const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
const entries = [];
try {
  for (const kind of ['item', 'event']) {
    for (const row of reader.entries(input.turnId, kind)) {
      const decoded = validated.get(kind).find(entry => entry.sequence === row.sequence);
      if (!decoded || decoded.id !== row.id || decoded.revision !== row.revision)
        throw new Error('Fresh-process public decoding did not validate the retained row.');
      const reference = row.content.reference;
      const bytes = reference.representation === 'inline'
        ? Buffer.from(reference.body, 'utf8')
        : readFileSync(join(scope.contentMount.root, reference.locator.path));
      entries.push({
        kind, sequence: row.sequence, id: row.id, revision: row.revision, value: decoded.value,
        representation: reference.representation ?? 'file', byteLength: row.content.byteLength,
        contentDigest: reference.contentDigest,
        digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.toString('base64'),
      });
    }
  }
} finally {
  reader.close();
}
process.stdout.write(JSON.stringify({ pid: process.pid, entries }));`,
        pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href,
        new URL('./workspace-file-records.ts', import.meta.url).href,
        new URL('./control-store-products.ts', import.meta.url).href,
      ],
      { encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ error: error ?? undefined, stdout, stderr })
    );
    processChild.stdin!.end(
      JSON.stringify({ dataRoot: f.root, owner: f.scope.owner, turnId: f.turn.id })
    );
  });
  expect(child.error, child.stderr).toBeUndefined();
  const observed = JSON.parse(child.stdout);
  expect(observed.pid).not.toBe(process.pid);
  for (const { kind, row, bytes } of expected) {
    const entry = observed.entries.find(
      (entry: { kind: string; sequence: number }) =>
        entry.kind === kind && entry.sequence === row.sequence
    );
    expect(entry).toEqual({
      kind,
      sequence: row.sequence,
      id: row.id,
      revision: row.revision,
      value: JSON.parse(bytes.toString('utf8')),
      representation:
        (row.content.reference as { representation?: string }).representation ?? 'file',
      byteLength: bytes.length,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      bytes: bytes.toString('base64'),
    });
  }
}

/** Requests a real native command tuple; the native owner alone can create its receipt. */
function candidate(f: Awaited<ReturnType<typeof fixture>>, content: unknown): ControlAdmission {
  const before = cut(f);
  const requestId = randomUUID();
  const scope = { workspaceId: f.workspace.id, threadId: f.thread.id };
  const createdAt = f.turn.startedAt!;
  return {
    receipt: {
      key: commandRequestKey('turn.input.submit', requestId, scope),
      command: 'turn.input.submit',
      requestId,
      scope,
      inputHash: commandInputHash({ requestId }),
      response: { kind: 'turn', id: f.turn.id },
      createdAt,
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    products: [
      { kind: 'turn', expectedRevision: before.turn.revision, record: before.turn.record },
    ],
    entries: [
      {
        kind: 'item',
        turnId: f.turn.id,
        sequence: before.items.at(-1)!.sequence + 1,
        expectedRevision: before.items.filter((entry) => entry.id === f.item.id).at(-1)!.revision,
        content,
      },
    ],
    audit: {
      id: allocateEntityId('aud'),
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: f.turn.id,
      itemId: null,
      capabilityCallId: null,
      permissionDecisionId: null,
      vaultGrantId: null,
      requestId,
      actor: null,
      subject: null,
      agentId: null,
      agentSessionId: null,
      category: 'command',
      action: 'turn.input.submit',
      resource: null,
      resourceRevision: null,
      outcome: 'succeeded',
      severity: 'info',
      summary: 'Inline byte proof',
      errorCode: null,
      createdAt,
      occurredAt: createdAt,
    },
  } as ControlAdmission;
}

describe('native inline retained work bodies', () => {
  it('preserves the raw file-reference metadata limit for descriptive additions', () => {
    const digest = createHash('sha256').update('{}').digest('hex');
    const request = {
      version: CONTROL_WORKER_VERSION,
      id: 0,
      operation: 'products',
      database: 'server:fixture',
      transition: {
        products: [],
        entries: [
          {
            kind: 'item',
            turnId: allocateEntityId('tu'),
            sequence: 1,
            expectedRevision: 0,
            content: {
              reference: {
                knowledgeBaseId: null,
                contentDigest: `sha256:${digest}`,
                locator: {
                  ownerScope: { kind: 'server' },
                  mount: 'backend-evidence',
                  path: `sha256/${digest}`,
                },
                range: null,
                availability: 'available',
                operatorNote: 'Admitted descriptive metadata',
              },
              byteLength: 2,
              mediaType: 'application/json',
            },
          },
        ],
      },
    };
    expect(isControlWorkerRequest(request)).toBe(true);
    const oversized = structuredClone(request);
    oversized.transition.entries[0]!.content.reference.operatorNote = 'x'.repeat(2 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(oversized.transition))).toBeGreaterThan(
      2 * 1024 * 1024
    );
    // The inline decision preserves existing admission limits; parsing cannot erase incoming metadata charges.
    expect(isControlWorkerRequest(oversized)).toBe(false);
  });

  it('preserves Pending admission for bounded inline bodies in both nested entry owners', () => {
    const workspaceId = allocateEntityId('ws');
    const threadId = allocateEntityId('th');
    const turnId = allocateEntityId('tu');
    const owner = { kind: 'workspace' as const, workspaceId };
    const now = '2026-10-27T00:00:00.000Z';
    const requestId = randomUUID();
    const scope = { workspaceId, threadId };
    const turn = {
      kind: 'turn' as const,
      expectedRevision: 1,
      record: {
        schemaVersion: 1,
        id: turnId,
        owner,
        threadId,
        agentSessionId: null,
        triggerActor: actor,
        error: null,
        configVersion: null,
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        status: 'completed',
        captureCoverage: { scope: 'workspace', value: 'on' },
      },
    };
    const entries = Array.from({ length: 17 }, (_, index) => {
      const item = ItemSchema.parse({
        id: allocateEntityId('it'),
        owner,
        threadId,
        turnId,
        type: 'user-message',
        actor,
        text: 'Nested retained body',
        status: 'completed',
        createdAt: now,
        completedAt: now,
      });
      item.text += 'x'.repeat(65_536 - Buffer.byteLength(JSON.stringify(writeRetainedV1(item))));
      const body = JSON.stringify(writeRetainedV1(item));
      return {
        kind: 'item' as const,
        turnId,
        sequence: index + 1,
        expectedRevision: 0,
        content: retainedContent(owner, body).inline,
      };
    });
    expect(entries.map((entry) => entry.content.byteLength)).toEqual(Array(17).fill(65_536));
    const fileEntries = entries.map(({ content, ...entry }) => ({
      ...entry,
      content: retainedContent(owner, content.reference.body).file,
    }));
    const terminal = {
      owner,
      turn,
      products: [],
      entries: fileEntries,
      reap: { reason: 'completed', inferredBy: 'pending-envelope-test' },
      evidence: [],
      evidenceContent: [],
      command: null,
      execution: null,
    };
    const admission = {
      receipt: {
        key: commandRequestKey('turn.input.submit', requestId, scope),
        command: 'turn.input.submit',
        requestId,
        scope,
        inputHash: commandInputHash({ requestId }),
        response: { kind: 'turn', id: turnId },
        createdAt: now,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      products: [turn],
      entries: fileEntries,
      audit: prepareAuditEvent({
        workspaceId,
        threadId,
        turnId,
        requestId,
        category: 'command',
        action: 'turn.input.submit',
        outcome: 'succeeded',
        summary: 'Pending envelope proof',
        now: new Date(now),
      }),
    };
    const admitted = [];
    for (const [field, nested] of [
      ['terminal', terminal],
      ['admission', admission],
    ] as const) {
      const request = {
        version: CONTROL_WORKER_VERSION,
        id: 0,
        database: 'workspace:fixture',
        operation: 'pending',
        input: {
          input: {
            action: 'finish',
            workspaceId,
            threadId,
            requestId,
            now,
            disposition: 'outcome-unknown',
            reason: 'Bounded Pending metadata',
          },
          products: [],
          entries: [],
          receipt: null,
          [field]: nested,
        },
      };
      expect(Buffer.byteLength(JSON.stringify(request.input))).toBeLessThan(1024 * 1024);
      expect(isControlWorkerRequest(request)).toBe(true);
      const inline = {
        ...request,
        input: { ...request.input, [field]: { ...nested, entries } },
      };
      expect(Buffer.byteLength(JSON.stringify(inline.input))).toBeGreaterThan(1024 * 1024);
      expect(
        isControlWorkerRequest({
          ...inline,
          input: {
            ...inline.input,
            input: { ...inline.input.input, reason: 'x'.repeat(1024 * 1024) },
          },
        })
      ).toBe(false);
      admitted.push(isControlWorkerRequest(inline));
    }
    // The inline decision preserves admission limits at each existing nested entry owner.
    expect(admitted).toEqual([true, true]);
  });

  it('preserves the Goal and Review descriptor envelopes when their retained entry bodies are inline', () => {
    const workspaceId = allocateEntityId('ws');
    const threadId = allocateEntityId('th');
    const turnId = allocateEntityId('tu');
    const owner = { kind: 'workspace' as const, workspaceId };
    const now = '2026-10-27T00:00:00.000Z';
    const requestId = randomUUID();
    const frozen = Array.from({ length: 16 }, (_, index) => {
      const item = ItemSchema.parse({
        id: allocateEntityId('it'),
        owner,
        threadId,
        turnId,
        type: 'user-message',
        actor,
        text: '"\\\n'.repeat(10_000),
        status: 'completed',
        createdAt: now,
        completedAt: now,
      });
      item.text += 'x'.repeat(65_536 - Buffer.byteLength(JSON.stringify(writeRetainedV1(item))));
      return {
        entry: { kind: 'item' as const, turnId, sequence: index + 1, expectedRevision: 0 },
        content: retainedContent(owner, JSON.stringify(writeRetainedV1(item))),
      };
    });
    expect(frozen.map((item) => item.content.inline.byteLength)).toEqual(Array(16).fill(65_536));
    const pendingItem = ItemSchema.parse({
      id: allocateEntityId('it'),
      owner,
      threadId,
      turnId,
      type: 'approval-request',
      approvalRequestId: `ap_${requestId}`,
      kind: 'permission',
      status: 'completed',
      completedAt: now,
      title: 'Approve Goal Plan',
      description: 'Approve the exact Plan and typed Goal domain.',
      createdAt: now,
    });
    const pendingContent = retainedContent(owner, JSON.stringify(writeRetainedV1(pendingItem)));
    const goalId = 'goal-envelope';
    const goal = {
      version: CONTROL_WORKER_VERSION,
      id: 0,
      database: 'workspace:fixture',
      operation: 'goal',
      input: {
        command: {
          operation: 'goal.plan.propose',
          arguments: {
            workspaceId,
            threadId,
            goalId,
            requestId,
            expectedRevision: 0,
            goalDomain: testGoalDomainProposal(workspaceId, goalId),
            commitment: {
              intentBasis: { revision: 0, intent: 'Propose a Plan' },
              cards: Array.from({ length: 64 }, (_, index) => ({
                cardId: `card-${index}`,
                revision: 0,
                description: 'x'.repeat(16_000),
                priority: 0,
              })),
              permittedAdjustments: 'Refine the Plan',
              completionEvidence: ['x'],
              boundaries: 'No deployment',
            },
          },
        },
        context: { actor: { kind: 'local', userId: actor.id } },
        receipt: {
          key: commandRequestKey('goal.plan.propose', requestId, {
            workspaceId,
            actorId: actor.id,
          }),
          command: 'goal.plan.propose',
          requestId,
          scope: { workspaceId, actorId: actor.id },
          inputHash: commandInputHash({ requestId }),
          responseKind: 'goal',
          createdAt: now,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
        administrator: null,
        resourcePolicy: { schemaVersion: 1, statements: [] },
        grantAdmission: null,
        externalEvidence: [],
        proposalTurnId: turnId,
        pendingAdmission: {
          entries: frozen.map((item) => ({ ...item.entry, content: item.content.file })),
          pending: [
            {
              action: 'freeze',
              workspaceId,
              threadId,
              turnId,
              executor: 'coordinator',
              cause: 'outcome',
              now,
              expectedSelection: frozen.map((_, index) => `pending-${index}`),
              expectedThreadCensus: frozen.map((_, index) => `pending-${index}`),
            },
          ],
        },
        pendingItem: {
          id: pendingItem.id,
          entry: {
            kind: 'item',
            turnId,
            sequence: 1,
            expectedRevision: 0,
            content: pendingContent.file,
          },
        },
      },
    };
    const evidenceLength = 1024 * 1024 - 256 - Buffer.byteLength(JSON.stringify(goal.input)) + 1;
    expect(evidenceLength).toBeGreaterThan(0);
    expect(evidenceLength + 1024).toBeLessThanOrEqual(16_000);
    goal.input.command.arguments.commitment.completionEvidence[0] = 'x'.repeat(evidenceLength);
    goal.input.receipt.inputHash = commandInputHash(goal.input.command.arguments);
    expect(Buffer.byteLength(JSON.stringify(goal.input))).toBe(1024 * 1024 - 256);
    expect(isControlWorkerRequest(goal)).toBe(true);
    const oversizedGoal = structuredClone(goal);
    oversizedGoal.input.command.arguments.commitment.completionEvidence[0] += 'x'.repeat(1024);
    expect(isControlWorkerRequest(oversizedGoal)).toBe(false);
    const inlineGoalAdmission = {
      ...goal,
      input: {
        ...goal.input,
        pendingAdmission: {
          ...goal.input.pendingAdmission,
          entries: frozen.map((item) => ({ ...item.entry, content: item.content.inline })),
        },
      },
    };
    const inlineGoalItem = {
      ...goal,
      input: {
        ...goal.input,
        pendingItem: {
          ...goal.input.pendingItem,
          entry: { ...goal.input.pendingItem.entry, content: pendingContent.inline },
        },
      },
    };
    const artifactId = allocateEntityId('ar');
    const agentSessionId = allocateEntityId('as');
    const reviewPackets = (body: string) => {
      const contentDigest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
      const artifact = ArtifactSchema.parse({
        id: artifactId,
        workspaceId,
        threadId,
        turnId,
        kind: 'report',
        title: 'Envelope',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'text', body },
        contentDigest,
        lastMutationRequestId: requestId,
        origin: { kind: 'turn-output', threadId, turnId, requestId },
        createdAt: now,
        updatedAt: now,
      });
      const item = ItemSchema.parse({
        id: allocateEntityId('it'),
        owner,
        threadId,
        turnId,
        type: 'artifact-reference',
        status: 'completed',
        artifactId,
        artifactVersion: 1,
        title: artifact.title,
        summary: null,
        lastMutationRequestId: requestId,
        createdAt: now,
        completedAt: now,
      });
      const events = [
        { event: 'item.created', data: { type: 'item-created', item } },
        { event: 'item.completed', data: { type: 'item-completed', itemId: item.id, item } },
        { event: 'artifact.created', data: { type: 'artifact-created', artifact } },
      ].map((event, index) =>
        SseEventEnvelopeSchema.parse({
          ...event,
          protocolVersion: PROTOCOL_VERSION,
          workspaceId,
          threadId,
          turnId,
          requestId,
          timestamp: now,
          sequence: index + 1,
        })
      );
      const entries = [item, ...events].map((value, index) => ({
        entry: {
          kind: index === 0 ? 'item' : 'event',
          turnId,
          sequence: index === 0 ? 1 : index,
          expectedRevision: 0,
        },
        content: retainedContent(owner, JSON.stringify(writeRetainedV1(value))),
      }));
      const file = {
        version: CONTROL_WORKER_VERSION,
        id: 0,
        database: 'workspace:fixture',
        operation: 'review',
        input: {
          mode: 'submit',
          artifact,
          agentSessionId,
          agentId: 'agent-envelope',
          review: {
            artifactId,
            artifactVersion: 1,
            contentDigest,
            sourceThreadId: threadId,
            sourceTurnId: turnId,
            sourceAgentId: 'agent-envelope',
            materialProposal: null,
            createdAt: now,
          },
          receipt: {
            key: commandRequestKey('artifact.submit', requestId, { workspaceId, threadId }),
            command: 'artifact.submit',
            requestId,
            scope: { workspaceId, threadId },
            inputHash: commandInputHash({ requestId }),
            responseKind: 'artifact',
            createdAt: now,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          transition: {
            products: [],
            entries: entries.map((value) => ({ ...value.entry, content: value.content.file })),
          },
        },
      };
      return {
        file,
        inline: {
          ...file,
          input: {
            ...file.input,
            transition: {
              ...file.input.transition,
              entries: entries.map((value) => ({
                ...value.entry,
                content:
                  value.content.inline.byteLength <= 65_536
                    ? value.content.inline
                    : value.content.file,
              })),
            },
          },
        },
      };
    };
    const reviewBodyLength =
      1024 * 1024 - 256 - Buffer.byteLength(JSON.stringify(reviewPackets('x').file.input)) + 1;
    const review = reviewPackets('x'.repeat(reviewBodyLength));
    expect(
      Math.max(...review.file.input.transition.entries.map((entry) => entry.content.byteLength))
    ).toBeLessThanOrEqual(1024 * 1024);
    expect(
      review.inline.input.transition.entries.map(
        (entry) => (entry.content.reference as { representation?: string }).representation ?? 'file'
      )
    ).toEqual(['inline', 'inline', 'inline', 'file']);
    expect(Buffer.byteLength(JSON.stringify(review.file.input))).toBeLessThan(1024 * 1024);
    expect(isControlWorkerRequest(review.file)).toBe(true);
    expect(isControlWorkerRequest(reviewPackets('x'.repeat(reviewBodyLength + 1024)).file)).toBe(
      false
    );
    expect(review.inline.input.transition.entries.map((entry) => entry.content.byteLength)).toEqual(
      review.file.input.transition.entries.map((entry) => entry.content.byteLength)
    );
    const inline = [inlineGoalAdmission, inlineGoalItem, review.inline];
    for (const request of inline)
      expect(Buffer.byteLength(JSON.stringify(request.input))).toBeGreaterThan(1024 * 1024);
    // These existing owners charge bounded retained bodies separately from their unchanged metadata envelope.
    expect(inline.map(isControlWorkerRequest)).toEqual([true, true, true]);
  });

  it('selects at 65,536 exact UTF-8 bytes and reopens exact Item and Item-event bodies', async () => {
    const f = await fixture();
    const small = { ...f.item, text: 'Small é😀\n"\\ event' };
    const boundary = boundaryItem(f, 65_536);
    const large = boundaryItem(f, 65_537);
    for (const item of [small, boundary, large]) await f.store.createItem(item);
    const events = [];
    for (const item of [small, large])
      events.push(
        await f.store.persistTurnEvent(f.turn.id, {
          event: 'item.completed',
          workspaceId: f.workspace.id,
          threadId: f.thread.id,
          turnId: f.turn.id,
          requestId: null,
          data: { type: 'item-completed', itemId: item.id, item },
        })
      );
    const before = cut(f);
    const expected = [
      ...[small, boundary, large].map((item) => ({
        kind: 'item' as const,
        row: before.items.find((row) => row.id === item.id)!,
        value: item,
      })),
      ...events.map((event) => ({
        kind: 'event' as const,
        row: before.events.find((row) => row.sequence === event.sequence)!,
        value: event,
      })),
    ].map(({ kind, row, value }) => ({
      kind,
      row,
      bytes: Buffer.from(JSON.stringify(writeRetainedV1(value))),
    }));
    for (const { row, bytes } of expected) {
      // Storage, Item Log Invariants: representation is selected by exact retained UTF-8 bytes.
      expect(
        (row.content.reference as { representation?: string }).representation === 'inline'
      ).toBe(bytes.length <= 65_536);
      expect(exactBytes(f, row.content)).toEqual(bytes);
    }
    await shutdownControlStoreWorkerClient();
    const cold = createTestStore({ dataRoot: f.root });
    expect(cold.getTurnById(f.turn.id).items).toEqual([small, boundary, large]);
    expect(cold.getTurnEventsForExport(f.turn.id)).toEqual(events);
    expect(cut(f)).toEqual(before);
    await expectFreshProcessBytes(f, expected);
  });

  it('keeps an existing small file reference unchanged beside a new inline revision after reopen', async () => {
    const f = await fixture();
    await f.store.createItem(f.item);
    const retained = { ...writeRetainedV1(f.item), text: 'Existing file é😀\n"\\' };
    const file = await publishImmutableProductJson(
      f.scope.contentMount,
      f.scope.owner,
      join(dirname(dirname(f.scope.path)), 'runtime', 'staging'),
      retained
    );
    const fileInput = candidate(f, file);
    await expect(
      getControlStoreWorkerClient().transition(`workspace:${f.scope.path}`, fileInput)
    ).resolves.toMatchObject({ replayed: false });
    const fileRow = cut(f).items.at(-1)!;
    const original = exactBytes(f, fileRow.content);
    expect(original).toEqual(Buffer.from(JSON.stringify(retained)));
    const next = { ...f.item, text: 'New inline revision' };
    await f.store.createItem(next);
    expect(
      (cut(f).items.at(-1)!.content.reference as { representation?: string }).representation
    ).toBe('inline');
    await shutdownControlStoreWorkerClient();
    const cold = createTestStore({ dataRoot: f.root });
    expect(cold.getTurnById(f.turn.id).items).toEqual([next]);
    expect(cut(f).items.find((row) => row.sequence === fileRow.sequence)).toEqual(fileRow);
    expect(exactBytes(f, fileRow.content)).toEqual(original);
    expect(
      readNativeProductEntries(f.scope, f.turn.id, 'item').find(
        (row) => row.sequence === fileRow.sequence
      )!.value
    ).toEqual(retained);
    await expectFreshProcessBytes(f, [
      { kind: 'item', row: fileRow, bytes: original },
      {
        kind: 'item',
        row: cut(f).items.at(-1)!,
        bytes: Buffer.from(JSON.stringify(writeRetainedV1(next))),
      },
    ]);
  });

  it('retains noncanonical JSON bytes exactly rather than parsing and re-encoding their proof', async () => {
    const f = await fixture();
    await f.store.createItem(f.item);
    const value = { ...writeRetainedV1(f.item), text: 'Exact é😀 bytes' };
    const body = ` \n${JSON.stringify(value, null, 2)}\n `;
    const content = {
      reference: {
        representation: 'inline',
        body,
        ownerScope: f.scope.owner,
        contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      },
      byteLength: Buffer.byteLength(body),
      mediaType: 'application/json',
    };
    const input = candidate(f, content);
    await expect(
      getControlStoreWorkerClient().transition(`workspace:${f.scope.path}`, input)
    ).resolves.toMatchObject({ replayed: false });
    await shutdownControlStoreWorkerClient();
    const cold = createTestStore({ dataRoot: f.root });
    expect(cold.getTurnById(f.turn.id).items).toEqual([{ ...f.item, text: value.text }]);
    expect(exactBytes(f, cut(f).items.at(-1)!.content)).toEqual(Buffer.from(body));
    await getControlStoreWorkerClient().open({
      database: `workspace:${f.scope.path}`,
      path: f.scope.path,
      dataRoot: f.root,
      create: false,
      initialize: 'workspace',
      productOwner: f.scope.owner,
      contentMount: f.scope.contentMount,
    });
    await expect(
      getControlStoreWorkerClient().transition(`workspace:${f.scope.path}`, input)
    ).resolves.toMatchObject({ replayed: true });
  });

  it('admits the existing 32-entry tuple when inline bodies exceed the metadata and frame budgets', async () => {
    const f = await fixture();
    const before = cut(f);
    const items = Array.from({ length: 32 }, () => {
      const item = { ...f.item, id: allocateEntityId('it'), text: '"\\\n'.repeat(10_000) };
      item.text += 'x'.repeat(65_536 - Buffer.byteLength(JSON.stringify(writeRetainedV1(item))));
      return item;
    });
    const bodies = items.map((item) => JSON.stringify(writeRetainedV1(item)));
    for (const body of bodies) expect(Buffer.byteLength(body)).toBe(65_536);
    const request = {
      products: [
        {
          kind: 'turn' as const,
          expectedRevision: before.turn.revision,
          record: before.turn.record,
        },
      ],
      entries: bodies.map((body, index) => ({
        kind: 'item' as const,
        turnId: f.turn.id,
        sequence: index + 1,
        expectedRevision: 0,
        content: retainedContent(f.scope.owner, body).inline,
      })),
    };
    // The specimen crosses the existing frame limit; exact retained bodies keep their separate byte charge.
    expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(2 * 1024 * 1024);
    // The inline decision preserves admission limits, including the existing 32-entry native tuple.
    await expect(
      getControlStoreWorkerClient().products(`workspace:${f.scope.path}`, request)
    ).resolves.toBeUndefined();
    const accepted = cut(f);
    expect(accepted.turn.revision).toBe(before.turn.revision + 1);
    expect(accepted.items.map((entry) => [entry.sequence, entry.id, entry.revision])).toEqual(
      items.map((item, index) => [index + 1, item.id, 1])
    );
    await shutdownControlStoreWorkerClient();
    const cold = createTestStore({ dataRoot: f.root });
    expect(cold.getTurnById(f.turn.id).items).toEqual(items);
    expect(cut(f)).toEqual(accepted);
    for (const [index, row] of accepted.items.entries())
      expect(exactBytes(f, row.content)).toEqual(Buffer.from(bodies[index]!));
  });

  it('refuses an unknown required representation tag retained on a valid file reference after reopen', async () => {
    const f = await fixture();
    await f.store.createItem(f.item);
    const file = await publishImmutableProductJson(
      f.scope.contentMount,
      f.scope.owner,
      join(dirname(dirname(f.scope.path)), 'runtime', 'staging'),
      {
        ...writeRetainedV1(f.item),
        text: 'Valid file bytes with an unsupported representation tag',
      }
    );
    await expect(
      getControlStoreWorkerClient().transition(`workspace:${f.scope.path}`, candidate(f, file))
    ).resolves.toMatchObject({ replayed: false });
    const acknowledged = cut(f).items.at(-1)!;
    expect(acknowledged.content).toEqual(file);
    const originalBytes = exactBytes(f, acknowledged.content);
    await shutdownControlStoreWorkerClient();
    const damaged = JSON.stringify({
      ...acknowledged.content,
      reference: { ...acknowledged.content.reference, representation: 'unknown-required-inline' },
    });
    // The fault changes one acknowledged descriptor after writer shutdown; it fabricates no successful record.
    const stopped = new Database(f.scope.path, { fileMustExist: true });
    try {
      expect(
        stopped
          .prepare(
            "UPDATE control_product_entries SET content_json=? WHERE turn_id=? AND kind='item' AND sequence=?"
          )
          .run(damaged, f.turn.id, acknowledged.sequence).changes
      ).toBe(1);
    } finally {
      stopped.close();
    }
    // Storage, Item Log Invariants: a cold reader must not normalize away unknown required representation semantics.
    expect(() => readNativeProductEntries(f.scope, f.turn.id, 'item')).toThrow();
    const inspected = new Database(f.scope.path, { fileMustExist: true, readonly: true });
    try {
      expect(
        inspected
          .prepare(
            "SELECT content_json FROM control_product_entries WHERE turn_id=? AND kind='item' AND sequence=?"
          )
          .pluck()
          .get(f.turn.id, acknowledged.sequence)
      ).toBe(damaged);
    } finally {
      inspected.close();
    }
    expect(exactBytes(f, acknowledged.content)).toEqual(originalBytes);
  });

  it.each([
    'digest',
    'length',
    'representation',
    'retained format',
    'lineage',
  ] as const)('refuses invalid inline %s without an accepted reference, head or receipt', async (fault) => {
    const f = await fixture();
    await f.store.createItem(f.item);
    const value = {
      ...writeRetainedV1(f.item),
      text: 'Must not be acknowledged',
      ...(fault === 'retained format' ? { schemaVersion: 99 } : {}),
      ...(fault === 'lineage' ? { turnId: allocateEntityId('tu') } : {}),
    };
    const body = JSON.stringify(value);
    const original = retainedContent(f.scope.owner, body).inline;
    const content = {
      ...original,
      reference: {
        ...original.reference,
        representation: fault === 'representation' ? 'unknown-required-inline' : 'inline',
        contentDigest:
          fault === 'digest' ? `sha256:${'0'.repeat(64)}` : original.reference.contentDigest,
      },
      byteLength: original.byteLength + (fault === 'length' ? 1 : 0),
    };
    const before = cut(f);
    const input = candidate(f, content);
    // Storage, Item Log Invariants: exact facts and required representation semantics precede FULL ACK.
    await expect(
      getControlStoreWorkerClient().transition(`workspace:${f.scope.path}`, input)
    ).rejects.toMatchObject({ commit: 'not-committed' });
    expect(cut(f)).toEqual(before);
    await shutdownControlStoreWorkerClient();
    createTestStore({ dataRoot: f.root });
    expect(cut(f)).toEqual(before);
  });
});

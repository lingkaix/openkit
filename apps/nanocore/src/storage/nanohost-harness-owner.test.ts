// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonText } from '@openkit/protocol';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it, vi } from 'vitest';
import {
  readCoreHarnessConsumption,
  recordCoreHarnessConsumption,
} from '../runtime/core-journal-records.js';
import {
  acknowledgeNanoHostHarnessResult,
  copyNanoHostMeasuredHarnessIdentity,
  createNanoHostHarnessRuntime,
  dispatchNanoHostHarnessOperation,
  hasQueuedNanoHostHarnessOperation,
  inspectNanoHostIdleCloseConsumption,
  listNanoHostMeasuredHarnessIdentities,
  NANO_HOST_HARNESS_RESULT_BUDGET_MS,
  NANO_HOST_REPLACEMENT_DEADLINE_PASSED,
  openNanoHostAgentSessionBinding,
  prepareNanoHostHarnessOperation,
  queueNanoHostHarnessOperation,
  readNanoHostMeasuredHarnessIdentity,
  readNanoHostThreadAgentSessionBinding,
  removeNanoHostSandboxRuntimeForHarness,
  settleNanoHostHarnessOperation,
} from '../runtime/nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target-records.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

const timestamp = '2026-11-20T00:00:00.000Z';
const physicalEpoch = 'e'.repeat(64);
const imageDigest = `sha256:${'a'.repeat(64)}`;
const otherDigest = `sha256:${'b'.repeat(64)}`;
const runtimeTargetId = 'fixture-nanohost-target';

function runtimeFacts(name: string) {
  return {
    adapterId: 'codex',
    adapterVersion: 'fixture',
    harnessBindingRef: `harness-binding-${name}`,
    harnessCompatibilityKey: 'b'.repeat(64),
    harnessInstanceId: `harness-${name}`,
    imageDigest,
    originPhysicalEpoch: physicalEpoch,
    runtimeTargetId,
    sandboxBindingRef: `sandbox-binding-${name}`,
    sandboxCompatibilityKey: 'd'.repeat(64),
    sandboxIntegrationBindingRef: `integration-binding-${name}`,
    sandboxRuntimeId: `sandbox-${name}`,
    timestamp,
  };
}

function sessionFacts(name: string) {
  return {
    agentSessionCompatibilityKey: 'c'.repeat(64),
    agentSessionId: `session-${name}`,
    agentSessionRuntimeBindingId: `session-binding-${name}`,
    effectiveSetupGeneration: 1,
    harnessInstanceId: `harness-${name}`,
    threadId: `thread-${name}`,
    timestamp,
    workspaceId: `workspace-${name}`,
  };
}

function withHarnessOwner(
  exercise: (owner: { readonly sqlite: Database.Database }, reopenReadOnly: () => void) => void
) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-harness-owner-'));
  const path = join(root, 'state.sqlite');
  const owner = { sqlite: new Database(path) };
  try {
    const { sqlite } = owner;
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle/extensions/nanohost/', import.meta.url)
      ),
    });
    sqlite
      .transaction(() => {
        const target = allocateNanoHostRuntimeTargetConnectionGeneration(
          { sqlite },
          {
            targetId: runtimeTargetId,
            deploymentId: 'fixture-deployment',
            identityId: 'fixture-identity',
            observedAt: timestamp,
          }
        );
        upsertNanoHostRuntimeTarget(
          { sqlite },
          {
            ...target,
            freshEmpty: true,
            physicalEpoch,
            predecessorFenced: true,
            ready: true,
          }
        );
      })
      .immediate();
    exercise(owner, () => {
      owner.sqlite.close();
      owner.sqlite = new Database(path, { fileMustExist: true, readonly: true });
    });
  } finally {
    if (owner.sqlite.open) owner.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
}

it('keeps measured lineage after exact Sandbox removal without removing a sibling binding', () => {
  withHarnessOwner((owner, reopenReadOnly) => {
    const retiredRuntime = runtimeFacts('retired');
    const retiredSession = sessionFacts('retired');
    const siblingSession = sessionFacts('sibling');
    const write = (action: () => void) => owner.sqlite.transaction(action).immediate();
    expect(() =>
      write(() =>
        createNanoHostHarnessRuntime(owner, {
          ...retiredRuntime,
          originPhysicalEpoch: 'f'.repeat(64),
        })
      )
    ).toThrow('NanoHost Sandbox publication physical Epoch is not current.');

    write(() => {
      createNanoHostHarnessRuntime(owner, retiredRuntime);
      createNanoHostHarnessRuntime(owner, runtimeFacts('sibling'));
      openNanoHostAgentSessionBinding(owner, retiredSession);
      openNanoHostAgentSessionBinding(owner, siblingSession);
    });
    expect(readNanoHostThreadAgentSessionBinding(owner, retiredSession)).toEqual({
      agentSessionId: retiredSession.agentSessionId,
    });

    const conflictingSession = {
      ...sessionFacts('conflicting'),
      harnessInstanceId: siblingSession.harnessInstanceId,
      threadId: retiredSession.threadId,
      workspaceId: retiredSession.workspaceId,
    };
    expect(() => write(() => openNanoHostAgentSessionBinding(owner, conflictingSession))).toThrow(
      'NanoHost Harness already has a current AgentSession for this Thread.'
    );
    expect(
      readNanoHostMeasuredHarnessIdentity(owner, conflictingSession.agentSessionRuntimeBindingId)
    ).toBeNull();

    write(() => removeNanoHostSandboxRuntimeForHarness(owner, retiredRuntime.harnessInstanceId));
    reopenReadOnly();
    expect(readNanoHostThreadAgentSessionBinding(owner, retiredSession)).toBeNull();
    expect(
      readNanoHostMeasuredHarnessIdentity(owner, retiredSession.agentSessionRuntimeBindingId)
    ).toBe(imageDigest);
    expect(readNanoHostThreadAgentSessionBinding(owner, siblingSession)).toEqual({
      agentSessionId: siblingSession.agentSessionId,
    });
    expect(owner.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

it('returns the last genuine A-B-A binding after Sandbox removal and reopen', () => {
  withHarnessOwner((owner, reopenReadOnly) => {
    const session = sessionFacts('rebound');
    // B and the return to A can commit in the same millisecond.
    const reboundAt = '2026-11-20T00:00:01.000Z';
    for (const [digest, boundAt] of [
      [imageDigest, timestamp],
      [otherDigest, reboundAt],
      [imageDigest, reboundAt],
    ] as const) {
      owner.sqlite
        .transaction(() => {
          createNanoHostHarnessRuntime(owner, {
            ...runtimeFacts('rebound'),
            imageDigest: digest,
            timestamp: boundAt,
          });
          openNanoHostAgentSessionBinding(owner, { ...session, timestamp: boundAt });
        })
        .immediate();
      expect(readNanoHostMeasuredHarnessIdentity(owner, session.agentSessionRuntimeBindingId)).toBe(
        digest
      );
      owner.sqlite
        .transaction(() => removeNanoHostSandboxRuntimeForHarness(owner, session.harnessInstanceId))
        .immediate();
    }
    reopenReadOnly();
    expect(readNanoHostMeasuredHarnessIdentity(owner, session.agentSessionRuntimeBindingId)).toBe(
      imageDigest
    );
    expect(
      listNanoHostMeasuredHarnessIdentities(owner, session.agentSessionRuntimeBindingId)
    ).toEqual([imageDigest, otherDigest]);
  });
});

it('refuses a contradicting live digest copy and leaves an exact copy idempotent', () => {
  withHarnessOwner((owner, reopenReadOnly) => {
    const original = sessionFacts('original');
    const sibling = sessionFacts('sibling');
    owner.sqlite
      .transaction(() => {
        createNanoHostHarnessRuntime(owner, runtimeFacts('original'));
        createNanoHostHarnessRuntime(owner, {
          ...runtimeFacts('sibling'),
          imageDigest: otherDigest,
        });
        openNanoHostAgentSessionBinding(owner, original);
        openNanoHostAgentSessionBinding(owner, sibling);
      })
      .immediate();
    const before = owner.sqlite.serialize();
    const copy = (digest: string) =>
      owner.sqlite
        .transaction(() =>
          copyNanoHostMeasuredHarnessIdentity(owner, {
            agentSessionRuntimeBindingId: original.agentSessionRuntimeBindingId,
            imageDigest: digest,
            timestamp: '2026-11-20T00:00:02.000Z',
          })
        )
        .immediate();
    expect(() => copy(otherDigest)).toThrow('conflicts with the live binding');
    expect(owner.sqlite.serialize()).toEqual(before);
    copy(imageDigest);
    expect(owner.sqlite.serialize()).toEqual(before);
    owner.sqlite
      .transaction(() => removeNanoHostSandboxRuntimeForHarness(owner, original.harnessInstanceId))
      .immediate();
    reopenReadOnly();
    expect(readNanoHostMeasuredHarnessIdentity(owner, original.agentSessionRuntimeBindingId)).toBe(
      imageDigest
    );
    expect(
      listNanoHostMeasuredHarnessIdentities(owner, original.agentSessionRuntimeBindingId)
    ).toEqual([imageDigest]);
    expect(readNanoHostMeasuredHarnessIdentity(owner, sibling.agentSessionRuntimeBindingId)).toBe(
      otherDigest
    );
  });
});

it('settles the original session-open result on Native and consumes it only on Core', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-k8-harness-core-'));
  const core = openCoreDb(root);
  try {
    applyMigrations(core);
    withHarnessOwner((owner, reopenReadOnly) => {
      const runtime = runtimeFacts('open');
      const session = {
        ...sessionFacts('open'),
        agentSessionId: testEntityId('as', 'live-harness-open'),
        threadId: testEntityId('th', 'live-harness-open'),
        workspaceId: testEntityId('ws', 'live-harness-open'),
      };
      const command = owner.sqlite
        .transaction(() => {
          createNanoHostHarnessRuntime(owner, { ...runtime, maxActiveTurns: 1 });
          openNanoHostAgentSessionBinding(owner, session);
          const prepared = prepareNanoHostHarnessOperation(
            core,
            {
              harnessInstanceId: runtime.harnessInstanceId,
              operation: 'session.open',
              timestamp,
              body: {
                adapterId: runtime.adapterId,
                agentSessionCompatibilityKey: session.agentSessionCompatibilityKey,
                agentSessionId: session.agentSessionId,
                agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
                effectiveSetupGeneration: session.effectiveSetupGeneration,
                threadId: session.threadId,
                workspaceId: session.workspaceId,
                resume: null,
              },
            },
            owner
          ).command;
          // This fixture starts at the existing Worker dispatch ACK boundary.
          const bytes = JSON.stringify(prepared.body);
          owner.sqlite
            .prepare(`UPDATE harness_instance_records
            SET operation = 'session.open', operation_state = 'dispatched',
                operation_id = ?, operation_sequence = ?, command_body_json = ?, command_fingerprint = ?
            WHERE harness_instance_id = ?`)
            .run(
              prepared.operationId,
              prepared.sequence,
              bytes,
              createHash('sha256').update(bytes).digest('hex'),
              runtime.harnessInstanceId
            );
          return prepared;
        })
        .immediate();
      const input = {
        sandboxIntegrationBindingRef: runtime.sandboxIntegrationBindingRef,
        timestamp,
        result: {
          schemaVersion: 2 as const,
          harnessInstanceId: runtime.harnessInstanceId,
          operationId: command.operationId,
          sequence: command.sequence,
          disposition: 'succeeded' as const,
          body: {
            state: 'open',
            nativeHandleState: 'pending',
            nativeHandleDigest: null,
            maxActiveTurns: 1,
          },
        },
      };
      const settle = () =>
        owner.sqlite
          .transaction(() => settleNanoHostHarnessOperation(core, input, owner))
          .immediate();
      expect(settle()).toBe('settled');
      expect(settle()).toBe('replayed');
      const fingerprint = owner.sqlite
        .prepare('SELECT result_fingerprint FROM harness_instance_records')
        .pluck()
        .get() as string;
      const key = {
        harnessBindingRef: runtime.harnessBindingRef,
        operationId: command.operationId,
        sequence: command.sequence,
        resultFingerprint: fingerprint,
      };
      expect(readCoreHarnessConsumption(core, key)).toBeNull();
      expect(
        owner.sqlite
          .prepare('SELECT lifecycle_state FROM agent_session_runtime_bindings')
          .pluck()
          .get()
      ).toBe('open');

      reopenReadOnly();
      const consumerReceipt = JSON.stringify({
        workspaceId: session.workspaceId,
        turnId: 'turn-open',
        executionId: 'execution-open',
        stepId: 'consume-open',
      });
      const acknowledge = (receipt: string) =>
        core.sqlite
          .transaction(() =>
            acknowledgeNanoHostHarnessResult(
              core,
              { ...input, harnessBindingRef: key.harnessBindingRef, consumerReceipt: receipt },
              owner
            )
          )
          .immediate();
      acknowledge(consumerReceipt);
      acknowledge(consumerReceipt);
      expect(JSON.parse(readCoreHarnessConsumption(core, key)!)).toEqual(
        JSON.parse(consumerReceipt)
      );
      expect(() => acknowledge(consumerReceipt.replace('turn-open', 'other-turn'))).toThrow(
        /conflicts/
      );
      expect(
        core.sqlite
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'harness_instance_records'")
          .get()
      ).toBeUndefined();
    });
  } finally {
    core.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function withQueuedHarness(
  exercise: (
    core: ReturnType<typeof openCoreDb>,
    owner: { readonly sqlite: Database.Database },
    reopenReadOnly: () => void
  ) => void
) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-harness-queue-probe-'));
  const core = openCoreDb(root);
  try {
    applyMigrations(core);
    withHarnessOwner((owner, reopenReadOnly) => {
      const queued = runtimeFacts('queued');
      owner.sqlite
        .transaction(() => {
          createNanoHostHarnessRuntime(owner, queued);
          const request = {
            harnessInstanceId: queued.harnessInstanceId,
            operation: 'harness.drain' as const,
            timestamp,
            body: {},
          };
          const prepared = prepareNanoHostHarnessOperation(core, request, owner);
          queueNanoHostHarnessOperation(core, { ...request, prepared }, owner);
        })
        .immediate();
      exercise(core, owner, reopenReadOnly);
    });
  } finally {
    core.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
}

it('observes an exact empty Harness queue even when a sibling Integration has a command', () => {
  withQueuedHarness((_core, owner, reopenReadOnly) => {
    const idle = runtimeFacts('idle');
    owner.sqlite.transaction(() => createNanoHostHarnessRuntime(owner, idle)).immediate();
    reopenReadOnly();

    expect(hasQueuedNanoHostHarnessOperation(owner, idle.sandboxIntegrationBindingRef)).toBe(false);
  });
});

it('observes a queued Harness command read-only and leaves it for deciding dispatch', () => {
  withQueuedHarness((core, owner, reopenReadOnly) => {
    const queued = runtimeFacts('queued');
    const sandboxIntegrationBindingRef = queued.sandboxIntegrationBindingRef;
    const before = owner.sqlite.serialize();

    expect(hasQueuedNanoHostHarnessOperation(owner, sandboxIntegrationBindingRef)).toBe(true);
    expect(owner.sqlite.serialize()).toEqual(before);
    expect(
      owner.sqlite
        .transaction(() =>
          dispatchNanoHostHarnessOperation(
            core,
            { sandboxIntegrationBindingRef, now: () => timestamp },
            { owner }
          )
        )
        .immediate()
    ).toMatchObject({ harnessInstanceId: queued.harnessInstanceId, operation: 'harness.drain' });
    reopenReadOnly();
    expect(hasQueuedNanoHostHarnessOperation(owner, sandboxIntegrationBindingRef)).toBe(false);
  });
});

it('refuses foreign and retired Integration bindings when observing the Harness queue', () => {
  withQueuedHarness((_core, owner, reopenReadOnly) => {
    const retired = runtimeFacts('retired');
    owner.sqlite
      .transaction(() => {
        createNanoHostHarnessRuntime(owner, retired);
        removeNanoHostSandboxRuntimeForHarness(owner, retired.harnessInstanceId);
      })
      .immediate();
    reopenReadOnly();

    for (const binding of ['integration-binding-foreign', retired.sandboxIntegrationBindingRef]) {
      expect(() => hasQueuedNanoHostHarnessOperation(owner, binding)).toThrow(
        'NanoHost Sandbox Integration binding is missing or stale.'
      );
    }
  });
});

it.each(['succeeded', 'unknown'] as const)(
  'requires the acknowledged Core idle close before changing only the original binding (%s)',
  (disposition) => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-idle-nanohost-close-'));
    const core = openCoreDb(root);
    try {
      applyMigrations(core);
      withHarnessOwner((owner, reopenReadOnly) => {
        const runtime = runtimeFacts('closing-idle');
        const session = {
          ...sessionFacts('closing-idle'),
          agentSessionId: testEntityId('as', 'closing-idle'),
        };
        const sibling = {
          ...sessionFacts('occupied-sibling'),
          harnessInstanceId: runtime.harnessInstanceId,
        };
        const sandboxIntegrationBindingRef = runtime.sandboxIntegrationBindingRef;
        const command = owner.sqlite
          .transaction(() => {
            createNanoHostHarnessRuntime(owner, runtime);
            openNanoHostAgentSessionBinding(owner, session);
            openNanoHostAgentSessionBinding(owner, sibling);
            const request = {
              harnessInstanceId: runtime.harnessInstanceId,
              operation: 'session.close' as const,
              timestamp,
              body: {
                agentSessionId: session.agentSessionId,
                agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
              },
            };
            const prepared = prepareNanoHostHarnessOperation(core, request, owner);
            queueNanoHostHarnessOperation(core, { ...request, prepared }, owner);
            return dispatchNanoHostHarnessOperation(
              core,
              { sandboxIntegrationBindingRef, now: () => timestamp },
              { owner }
            )!;
          })
          .immediate();
        const result = {
          schemaVersion: 2 as const,
          harnessInstanceId: command.harnessInstanceId,
          operationId: command.operationId,
          sequence: command.sequence,
          disposition,
          body:
            disposition === 'succeeded'
              ? { state: 'closed', privateState: 'absent', childState: 'absent' }
              : { reasonCode: 'outcome_unknown' },
        };
        const input = { sandboxIntegrationBindingRef, timestamp, result };
        const settle = () =>
          owner.sqlite
            .transaction(() => settleNanoHostHarnessOperation(core, input, owner))
            .immediate();
        const before = owner.sqlite.serialize();
        expect(() => settle()).toThrow('idle close requires its original Core');
        expect(owner.sqlite.serialize()).toEqual(before);
        const { agentSessionId, agentSessionRuntimeBindingId, threadId, workspaceId } = session;
        const consumer = canonicalJsonText({
          workspaceId,
          threadId,
          agentSessionId,
          agentSessionRuntimeBindingId,
        });
        const key = {
          harnessBindingRef: runtime.harnessBindingRef,
          operationId: result.operationId,
          sequence: result.sequence,
          resultFingerprint: sha256CanonicalJson(result),
        };
        expect(inspectNanoHostIdleCloseConsumption(core, input, owner)).toEqual({ key, consumer });
        expect(
          inspectNanoHostIdleCloseConsumption(
            core,
            { ...input, result: { ...result, sequence: result.sequence + 1 } },
            owner
          )
        ).toBeNull();
        core.sqlite
          .transaction(() => recordCoreHarnessConsumption(core, key, consumer, timestamp))
          .immediate();
        expect(settle()).toBe('settled');
        reopenReadOnly();
        expect(
          owner.sqlite.transaction(() => settleNanoHostHarnessOperation(core, input, owner))()
        ).toBe('replayed');
        expect(readCoreHarnessConsumption(core, key)).toBe(consumer);
        expect(readNanoHostThreadAgentSessionBinding(owner, sibling)).toEqual({
          agentSessionId: sibling.agentSessionId,
        });
        const occupancy = owner.sqlite
          .prepare(
            'SELECT open_session_count AS occupied, operation_state AS operationState, drain_state AS drain FROM harness_instance_records'
          )
          .get();
        expect(occupancy).toEqual(
          disposition === 'succeeded'
            ? { occupied: 1, operationState: 'settled', drain: 'accepting' }
            : { occupied: 2, operationState: 'unknown', drain: 'draining' }
        );
      });
    } finally {
      core.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);

/** CLOSE-LC S3a-r2: one idle close on its own Harness, queued or ready to queue. */
function withIdleClose(
  name: string,
  exercise: (
    core: ReturnType<typeof openCoreDb>,
    owner: { readonly sqlite: Database.Database },
    close: {
      readonly runtime: ReturnType<typeof runtimeFacts>;
      readonly session: ReturnType<typeof sessionFacts>;
      readonly request: Parameters<typeof prepareNanoHostHarnessOperation>[1];
    }
  ) => void
) {
  const root = mkdtempSync(join(tmpdir(), `openkit-nanohost-close-clock-${name}-`));
  const core = openCoreDb(root);
  try {
    applyMigrations(core);
    withHarnessOwner((owner) => {
      const runtime = runtimeFacts(name);
      const session = { ...sessionFacts(name), agentSessionId: testEntityId('as', name) };
      owner.sqlite
        .transaction(() => {
          createNanoHostHarnessRuntime(owner, runtime);
          openNanoHostAgentSessionBinding(owner, session);
        })
        .immediate();
      exercise(core, owner, {
        runtime,
        session,
        request: {
          harnessInstanceId: runtime.harnessInstanceId,
          operation: 'session.close',
          timestamp,
          body: {
            agentSessionId: session.agentSessionId,
            agentSessionRuntimeBindingId: session.agentSessionRuntimeBindingId,
          },
        },
      });
    });
  } finally {
    core.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const harnessCell = (owner: { readonly sqlite: Database.Database }, harnessInstanceId: string) =>
  owner.sqlite
    .prepare(
      `SELECT operation, operation_state AS operationState, lifecycle_state AS lifecycleState,
        drain_state AS drainState FROM harness_instance_records WHERE harness_instance_id = ?`
    )
    .get(harnessInstanceId);

// CLOSE-LC S3a-r2 AMEND 1: RC8 compares the slot inside its deciding update. Native samples its
// wall at 99 after the reads; the slot passes at 100, before the update. The update leaves zero
// rows and refuses with the typed deadline, so Main answers its posted limiting clock.
it.each(['passes', 'live'] as const)(
  'compares a replacement close slot inside its deciding queue update (slot %s at the update)',
  (slot) => {
    withIdleClose(`slot-${slot}`, (core, owner, { runtime, session, request }) => {
      const target = getNanoHostRuntimeTarget(owner, runtimeTargetId)!;
      const binding = owner.sqlite
        .prepare(
          `SELECT updated_at AS revision, lifecycle_state AS lifecycleState
          FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?`
        )
        .get(session.agentSessionRuntimeBindingId) as { revision: string; lifecycleState: string };
      const prepared = prepareNanoHostHarnessOperation(core, request, owner);
      const deadline = Date.parse(timestamp) + 100;
      const replacement = {
        target: {
          targetId: target.targetId,
          identityId: target.identityId,
          deploymentId: target.deploymentId,
          connectionGeneration: target.connectionGeneration,
          physicalEpoch: target.physicalEpoch,
        },
        bindingRevision: binding.revision,
        bindingLifecycleState: binding.lifecycleState,
        startupDeadline: new Date(deadline).toISOString(),
      };
      vi.useFakeTimers({ toFake: ['Date'] });
      const prepare = owner.sqlite.prepare.bind(owner.sqlite);
      let updated = false;
      const statements = vi.spyOn(owner.sqlite, 'prepare').mockImplementation(((sql: string) => {
        if (sql.includes("SET operation_state = 'queued'")) {
          updated = true;
          // The wall reaches the slot after the last read and before the deciding update.
          if (slot === 'passes') vi.setSystemTime(deadline);
        }
        return prepare(sql);
      }) as typeof owner.sqlite.prepare);
      try {
        vi.setSystemTime(deadline - 1);
        const queue = () =>
          owner.sqlite
            .transaction(() =>
              queueNanoHostHarnessOperation(core, { ...request, prepared, replacement }, owner)
            )
            .immediate();
        if (slot === 'passes') expect(queue).toThrow(NANO_HOST_REPLACEMENT_DEADLINE_PASSED);
        else expect(queue()).toBe(prepared.command.sequence);
      } finally {
        statements.mockRestore();
        vi.useRealTimers();
      }
      expect(updated).toBe(true);
      expect(harnessCell(owner, runtime.harnessInstanceId)).toMatchObject(
        slot === 'passes'
          ? { operation: null, operationState: 'idle' }
          : { operation: 'session.close', operationState: 'queued' }
      );
    });
  }
);

// CLOSE-LC S3a-r2 row 10: the result budget decides again on a sample after the lineage read.
// Expiry during that read takes the queued expiry and fences, with zero dispatches and no
// binding write. The early expiry stays.
it('expires a queued close whose result budget passes during its dispatch lineage read', () => {
  withIdleClose('budget', (core, owner, { runtime, session, request }) => {
    owner.sqlite
      .transaction(() => {
        const prepared = prepareNanoHostHarnessOperation(core, request, owner);
        queueNanoHostHarnessOperation(core, { ...request, prepared }, owner);
      })
      .immediate();
    const bindingBefore = owner.sqlite
      .prepare(
        'SELECT * FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?'
      )
      .get(session.agentSessionRuntimeBindingId);
    let wall = Date.parse(timestamp) + 1_000;
    let lineage = 0;
    const prepare = owner.sqlite.prepare.bind(owner.sqlite);
    const statements = vi.spyOn(owner.sqlite, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('agent_session_compatibility_key AS compatibilityKey')) {
        lineage += 1;
        // The 300-second result budget passes during the lineage read.
        wall = Date.parse(timestamp) + NANO_HOST_HARNESS_RESULT_BUDGET_MS;
      }
      return prepare(sql);
    }) as typeof owner.sqlite.prepare);
    let command: ReturnType<typeof dispatchNanoHostHarnessOperation>;
    try {
      command = owner.sqlite
        .transaction(() =>
          dispatchNanoHostHarnessOperation(
            core,
            {
              sandboxIntegrationBindingRef: runtime.sandboxIntegrationBindingRef,
              now: () => new Date(wall).toISOString(),
            },
            { owner }
          )
        )
        .immediate();
    } finally {
      statements.mockRestore();
    }
    expect(lineage).toBe(1);
    expect(command).toBeNull();
    expect(harnessCell(owner, runtime.harnessInstanceId)).toEqual({
      operation: 'session.close',
      operationState: 'unknown',
      lifecycleState: 'failed',
      drainState: 'draining',
    });
    expect(
      owner.sqlite
        .prepare(
          'SELECT * FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?'
        )
        .get(session.agentSessionRuntimeBindingId)
    ).toEqual(bindingBefore);
    expect(hasQueuedNanoHostHarnessOperation(owner, runtime.sandboxIntegrationBindingRef)).toBe(
      false
    );
  });
});

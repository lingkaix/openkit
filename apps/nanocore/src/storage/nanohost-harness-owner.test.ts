// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import { readCoreHarnessConsumption } from '../runtime/core-journal-records.js';
import {
  acknowledgeNanoHostHarnessResult,
  copyNanoHostMeasuredHarnessIdentity,
  createNanoHostHarnessRuntime,
  listNanoHostMeasuredHarnessIdentities,
  openNanoHostAgentSessionBinding,
  prepareNanoHostHarnessOperation,
  readNanoHostMeasuredHarnessIdentity,
  readNanoHostThreadAgentSessionBinding,
  removeNanoHostSandboxRuntimeForHarness,
  settleNanoHostHarnessOperation,
} from '../runtime/nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
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

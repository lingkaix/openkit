import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import {
  recordBootAuditEvent,
  recordBootStartAuditEvent,
  recordShutdownAuditEvent,
} from '../bootstrap/audit.js';
import { runBootPhases } from '../bootstrap/phases.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

const roots: string[] = [];
const handles: CoreDb[] = [];
const phases = ['start', 'outcome', 'shutdown'] as const;
type Phase = (typeof phases)[number];
const createdAt = '2026-07-05T00:00:01.000Z';

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Migrates through the storage owner before admitting any native Audit publication. */
function fixture(queryOnly = true) {
  const root = mkdtempSync(join(tmpdir(), 'boot-audit-native-'));
  roots.push(root);
  const db = openCoreDb(root);
  handles.push(db);
  applyMigrations(db);
  if (queryOnly) db.sqlite.pragma('query_only = ON');
  return { root, db };
}

/** Reads the complete two-table tuple; boot payloads have no product reader. */
function tuple(db: CoreDb) {
  return {
    boot: db.sqlite.prepare('SELECT * FROM boot_audit_events ORDER BY boot_event_id').all(),
    audit: db.sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all(),
  };
}

/** Reopens the same physical store only after the real native close has completed. */
async function coldTuple(f: ReturnType<typeof fixture>) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.close();
  const reopened = openCoreDb(f.root);
  handles.push(reopened);
  reopened.sqlite.pragma('query_only = ON');
  return tuple(reopened);
}

/** Fixes existing lifecycle inputs and expected values before invoking their real publishers. */
async function scenario(db: CoreDb, phase: Phase) {
  const bootId = `boot_${phase === 'outcome' ? 'audit' : phase}_test`;
  const now = new Date(createdAt);
  const common = {
    schema_version: 1,
    boot_event_id: `${bootId}_${phase}`,
    boot_id: bootId,
    event_type: `boot.${phase}`,
    created_at: createdAt,
  };
  if (phase === 'start') {
    const readiness = {
      bootId,
      layoutVersion: 1,
      migrationIds: ['core_0000_setup'],
      storageRecoveryEvents: [],
      indexRebuildEvents: [],
    };
    return {
      publish: async () => {
        await recordBootStartAuditEvent({ coreDb: db, ...readiness, now });
      },
      boot: {
        ...common,
        accepting_product_work: 0,
        outcome: 'started',
        phase_outcomes_json: '[]',
        readiness_json: JSON.stringify(readiness),
      },
      auditId: 'aud_d4426a3f-e83e-5c97-9471-b87b74bd0e72',
      outcome: 'succeeded',
      severity: 'info',
      errorCode: null,
    };
  }
  if (phase === 'outcome') {
    const result = await runBootPhases({
      bootId,
      phases: [
        {
          name: 'vault',
          subsystem: 'vault',
          critical: false,
          run: () => ({
            status: 'degraded',
            reason: { code: 'vault.locked', message: 'Vault is locked.', blocks: ['vault.use'] },
          }),
        },
      ],
    });
    return {
      publish: async () => {
        await recordBootAuditEvent({ coreDb: db, result, now });
      },
      boot: {
        ...common,
        accepting_product_work: 1,
        outcome: 'degraded',
        phase_outcomes_json: JSON.stringify(result.outcomes),
        readiness_json: JSON.stringify(result.readiness),
      },
      auditId: 'aud_16ab7e83-eb41-5091-a878-d798a5cca4d1',
      outcome: 'succeeded',
      severity: 'warning',
      errorCode: 'boot_degraded',
    };
  }
  const stepsCompleted = ['http-server.close', 'scheduler.stop'];
  return {
    publish: async () => {
      await recordShutdownAuditEvent({
        coreDb: db,
        bootId,
        reason: 'SIGTERM',
        stepsCompleted,
        deadlineForcedExit: false,
        now,
      });
    },
    boot: {
      ...common,
      accepting_product_work: 0,
      outcome: 'ok',
      phase_outcomes_json: JSON.stringify(stepsCompleted),
      readiness_json: JSON.stringify({
        bootId,
        deadlineForcedExit: false,
        shutdownReason: 'SIGTERM',
      }),
    },
    auditId: 'aud_4c53f7f6-e79d-580a-b6f0-fb1cf968b333',
    outcome: 'succeeded',
    severity: 'info',
    errorCode: null,
  };
}

describe('boot lifecycle native Audit tuple', () => {
  it.each(phases)(
    '%s persists its original tuple with Main query-only and survives native close',
    async (phase) => {
      const f = fixture();
      const expected = await scenario(f.db, phase);
      expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
      await expected.publish();

      // Bootstrap audit owns original phase identity, payload and clocks across reopen.
      const observed = tuple(f.db).boot;
      expect(observed).toEqual([
        {
          ...expected.boot,
          phase_outcomes_json: expect.any(String),
          readiness_json: expect.any(String),
        },
      ]);
      const row = observed[0] as { phase_outcomes_json: string; readiness_json: string };
      expect(JSON.parse(row.phase_outcomes_json)).toEqual(
        JSON.parse(expected.boot.phase_outcomes_json)
      );
      expect(JSON.parse(row.readiness_json)).toEqual(JSON.parse(expected.boot.readiness_json));
      expect(listServerAuditEvents(f.db)).toEqual([
        expect.objectContaining({
          id: expected.auditId,
          action: expected.boot.event_type,
          resource: `server:boot:${expected.boot.boot_id}`,
          workspaceId: null,
          category: 'system',
          outcome: expected.outcome,
          severity: expected.severity,
          errorCode: expected.errorCode,
          createdAt,
          occurredAt: createdAt,
        }),
      ]);
      const acknowledged = tuple(f.db);
      // Storage close drains and closes the native owner; no migration or publisher runs on reopen.
      expect(await coldTuple(f)).toEqual(acknowledged);
    }
  );

  it.each(phases)(
    '%s rolls back the entire tuple when its general Audit insert fails',
    async (phase) => {
      const f = fixture(false);
      // Valid retained history comes from its real owner and must survive the failed new tuple.
      await recordBootStartAuditEvent({
        coreDb: f.db,
        bootId: 'boot_preserved_seed',
        migrationIds: [],
        now: new Date('2026-07-05T00:00:00.000Z'),
      });
      const before = tuple(f.db);
      await shutdownControlStoreWorkerClient();
      f.db.sqlite.pragma('query_only = OFF');
      try {
        // Deliberate owner fault after valid setup; this SQL creates no successful record.
        f.db.sqlite.exec(`CREATE TRIGGER fail_boot_general_audit BEFORE INSERT ON audit_events
          BEGIN SELECT RAISE(ABORT, 'boot general Audit SQL fault'); END`);
      } finally {
        f.db.sqlite.pragma('query_only = ON');
      }
      const expected = await scenario(f.db, phase);
      const publication = expected.publish();
      await expect(publication).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
      });
      // Storage requires the complete moved family in one transaction, including required Audit.
      expect(tuple(f.db)).toEqual(before);
      expect(await coldTuple(f)).toEqual(before);
    }
  );
});

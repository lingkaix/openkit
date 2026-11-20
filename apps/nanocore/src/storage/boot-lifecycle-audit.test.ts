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

/** Reads the canonical stored rows to compare before and after real writer retirement. */
function auditRows(db: CoreDb) {
  return db.sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all();
}

/** Reopens the same physical store only after the real native close has completed. */
async function coldRows(f: ReturnType<typeof fixture>) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.close();
  const reopened = openCoreDb(f.root);
  handles.push(reopened);
  reopened.sqlite.pragma('query_only = ON');
  return auditRows(reopened);
}

/** Fixes existing lifecycle inputs and expected values before invoking their real publishers. */
async function scenario(db: CoreDb, phase: Phase) {
  const bootId = `boot_${phase === 'outcome' ? 'audit' : phase}_test`;
  const now = new Date(createdAt);
  if (phase === 'start') {
    const readiness = {
      bootId,
      layoutVersion: 1,
      migrationIds: ['core_0000_baseline'],
      storageRecoveryEvents: [],
      indexRebuildEvents: [],
    };
    return {
      publish: async () => {
        await recordBootStartAuditEvent({ coreDb: db, ...readiness, now });
      },
      bootId,
      evidence: {
        kind: 'boot.start',
        bootId,
        layoutVersion: 1,
        migrationIds: ['core_0000_baseline'],
        lock: null,
        indexRebuilds: [],
        storageRecovery: [],
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
      bootId,
      evidence: expect.objectContaining({
        kind: 'boot.outcome',
        bootId,
        overall: 'degraded',
        acceptingProductWork: true,
        subsystems: expect.objectContaining({
          vault: { state: 'degraded', reasons: [{ code: 'vault.locked', blocks: ['vault.use'] }] },
        }),
        phases: [
          {
            name: 'vault',
            subsystem: 'vault',
            critical: false,
            status: 'degraded',
            reasons: [{ code: 'vault.locked', blocks: ['vault.use'] }],
          },
        ],
      }),
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
    bootId,
    evidence: {
      kind: 'boot.shutdown',
      bootId,
      reason: 'SIGTERM',
      stepsCompleted,
      deadlineForcedExit: false,
    },
    auditId: 'aud_4c53f7f6-e79d-580a-b6f0-fb1cf968b333',
    outcome: 'succeeded',
    severity: 'info',
    errorCode: null,
  };
}

describe('boot lifecycle native Core Audit', () => {
  it.each(phases)(
    '%s persists one original event with Main query-only and survives native close',
    async (phase) => {
      const f = fixture();
      const expected = await scenario(f.db, phase);
      expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
      await expected.publish();

      expect(listServerAuditEvents(f.db)).toEqual([
        expect.objectContaining({
          id: expected.auditId,
          action: `boot.${phase}`,
          resource: `server:boot:${expected.bootId}`,
          kernelEvidence: expected.evidence,
          workspaceId: null,
          turnId: null,
          category: 'system',
          outcome: expected.outcome,
          severity: expected.severity,
          errorCode: expected.errorCode,
          createdAt,
          occurredAt: createdAt,
        }),
      ]);
      const acknowledged = auditRows(f.db);
      expect(JSON.stringify(acknowledged)).not.toContain('Vault is locked.');
      // Storage close drains and closes the native owner; no migration or publisher runs on reopen.
      expect(await coldRows(f)).toEqual(acknowledged);
    }
  );

  it.each(phases)(
    '%s leaves the original ledger intact when the Audit insert fails',
    async (phase) => {
      const f = fixture(false);
      // Valid retained history comes from its real owner and must survive the failed new event.
      await recordBootStartAuditEvent({
        coreDb: f.db,
        bootId: 'boot_preserved_seed',
        migrationIds: [],
        now: new Date('2026-07-05T00:00:00.000Z'),
      });
      const before = auditRows(f.db);
      await shutdownControlStoreWorkerClient();
      f.db.sqlite.pragma('query_only = OFF');
      try {
        // Deliberate owner fault after valid setup; this SQL creates no successful record.
        f.db.sqlite.exec(`CREATE TRIGGER fail_boot_audit BEFORE INSERT ON audit_events
          BEGIN SELECT RAISE(ABORT, 'boot Audit SQL fault'); END`);
      } finally {
        f.db.sqlite.pragma('query_only = ON');
      }
      const expected = await scenario(f.db, phase);
      const publication = expected.publish();
      await expect(publication).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
      });
      // The failure must preserve committed history and publish no new event.
      expect(auditRows(f.db)).toEqual(before);
      expect(await coldRows(f)).toEqual(before);
    }
  );
});

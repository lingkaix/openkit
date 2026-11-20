import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordVaultAdminAuditEvent } from './vault-admin-audit-events.js';

describe('Vault administration Audit attribution', () => {
  for (const kind of ['local', 'session', 'token'] as const) {
    it(`keeps the same human actor in the original ${kind} Audit event`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'openkit-vault-attribution-'));
      const db = openCoreDb(root);
      try {
        applyMigrations(db);
        const actor: Actor = {
          kind,
          userId: allocateEntityId('usr'),
          ...(kind === 'token'
            ? { tokenId: allocateEntityId('tok'), tokenScope: 'server-admin' as const }
            : {}),
        };
        const auditEventId = allocateEntityId('aud');
        await recordVaultAdminAuditEvent({
          coreDb: db,
          actor,
          auditEventId,
          action: 'vault.lock',
          outcome: 'succeeded',
          summary: 'Vault lock succeeded.',
          backendKind: 'encrypted-file',
        });
        expect(listServerAuditEvents(db)).toEqual([
          expect.objectContaining({
            id: auditEventId,
            action: 'vault.lock',
            actor: { kind: 'user', id: actor.userId },
            authentication: { credentialKind: kind, credentialId: actor.tokenId ?? null },
            kernelEvidence: { kind: 'vault.admin', backendKind: 'encrypted-file' },
          }),
        ]);
      } finally {
        await shutdownControlStoreWorkerClient();
        db.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

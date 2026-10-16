import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../auth/identity.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordVaultAdminAuditEvent } from './vault-admin-audit-events.js';

describe('Vault administration Audit attribution', () => {
  for (const kind of ['local', 'session', 'token'] as const) {
    it(`keeps the same human actor in both ${kind} audit projections`, () => {
      const root = mkdtempSync(join(tmpdir(), 'openkit-vault-attribution-'));
      const db = openCoreDb(root);
      try {
        applyMigrations(db);
        const actor: Actor = {
          kind,
          userId: randomUUID(),
          ...(kind === 'token'
            ? { tokenId: randomUUID(), tokenScope: 'server-admin' as const }
            : {}),
        };
        const auditEventId = randomUUID();
        recordVaultAdminAuditEvent({
          coreDb: db,
          actor,
          auditEventId,
          action: 'vault.lock',
          outcome: 'succeeded',
          summary: 'Vault lock succeeded.',
          backendKind: 'encrypted-file',
        });
        const vault = db.sqlite
          .prepare(
            'SELECT actor_user_id, actor_kind FROM vault_admin_audit_events WHERE audit_event_id = ?'
          )
          .get(auditEventId);
        const audit = db.sqlite
          .prepare('SELECT actor_json FROM audit_events WHERE audit_event_id = ?')
          .get(auditEventId) as { actor_json: string | null };
        expect(vault).toEqual({ actor_user_id: actor.userId, actor_kind: kind });
        expect(audit.actor_json === null ? null : JSON.parse(audit.actor_json)).toEqual({
          kind: 'user',
          id: actor.userId,
        });
      } finally {
        db.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

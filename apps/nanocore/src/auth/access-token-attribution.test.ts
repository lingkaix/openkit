import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createAccessTokenOperationImplementations } from './access-token-operations.js';

describe('Token lifecycle attribution', () => {
  it('records the administrator that issued a Token to another User', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'token-actor-audit-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      const administrator = ensureLocalUser(coreDb);
      const ownerUserId = testEntityId('usr', 'other-token-owner');
      const now = new Date().toISOString();
      coreDb.sqlite
        .prepare(
          "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, status) VALUES (?, 'account', 'Target', ?, 0, ?, ?, 'active')"
        )
        .run(ownerUserId, 'target@example.invalid', now, now);
      const context: AdmittedOperationContext = {
        kind: 'public',
        actor: { kind: 'local', userId: administrator },
        actorRef: { kind: 'user', id: administrator },
        scope: { kind: 'server' },
      };
      const operations = createAccessTokenOperationImplementations({ coreDb, mode: 'server' });
      const issued = await operations['token.create'](
        {
          scope: 'server-admin',
          ownerUserId,
          workspaceIds: [],
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
        context
      );
      const event = listServerAuditEvents(coreDb).find(
        (item) => item.action === 'auth.token.issue'
      );
      expect(event).toMatchObject({
        actor: { kind: 'user', id: administrator },
        resource: `auth-token:${issued.record.tokenId}`,
        authentication: { credentialKind: 'local', credentialId: null },
        outcome: 'succeeded',
      });
      expect(event?.actor?.id).not.toBe(ownerUserId);
      expect(JSON.stringify(event)).not.toContain(issued.token);
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

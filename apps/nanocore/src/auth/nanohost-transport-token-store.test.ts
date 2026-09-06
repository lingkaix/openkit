import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createNanoHostTransportTokenRecord,
  revokeNanoHostTransportTokenRecord,
  rotateNanoHostTransportTokenRecord,
  verifyNanoHostTransportTokenRecord,
} from './nanohost-transport-token-store.js';

/** Inserts the exact active identity required by Token issuance fixtures. */
function insertActiveIdentity(coreDb: ReturnType<typeof openCoreDb>): void {
  coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_integration_identities (
        identity_id, deployment_id, status, created_at
      ) VALUES ('integration_nanohost_primary', 'deploy_primary', 'active', ?)`
    )
    .run('2026-08-08T00:00:00.000Z');
}

/**
 * S-2b-1 Unit 2 red: NanoHost transport token store lifecycle.
 *
 * Contract: NanoCore stores only a hash plus non-secret Token metadata, and
 * issue/verify/rotate/revoke must not leak raw `okt_` secrets into durable rows
 * or redacted records (`docs/specs/20260802-nanohost_runtime_and_transport.md`).
 *
 * Prefer fail-on-absence: this file imports `./nanohost-transport-token-store.js`,
 * which does not exist yet. Do not implement the production store here.
 */
describe('NanoHost transport token store', () => {
  it('issues hash-only records and verifies without leaking the raw secret', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-token-store-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertActiveIdentity(coreDb);

      const issued = createNanoHostTransportTokenRecord(coreDb, {
        deploymentId: 'deploy_primary',
        expiresAt: '2026-09-08T00:00:00.000Z',
        now: new Date('2026-08-08T00:00:00.000Z'),
        ownerNanoHostIdentityId: 'integration_nanohost_primary',
        responsibleServerAdminActorId: 'user_admin',
      });
      const rows = coreDb.sqlite.prepare('SELECT * FROM nanohost_transport_tokens').all() as Array<{
        scope: string;
        token_hash: string;
        token_type: string;
      }>;
      const verified = verifyNanoHostTransportTokenRecord(coreDb, issued.secret, {
        now: new Date('2026-08-08T00:00:00.000Z'),
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.token_hash).toMatch(/^sha256:/);
      expect(rows[0]?.token_type).toBe('nanohost-transport');
      expect(rows[0]?.scope).toBe('nanohost-transport');
      expect(JSON.stringify(rows)).not.toContain(issued.secret);
      expect(JSON.stringify(issued.record)).not.toContain(issued.secret);
      expect(verified).toMatchObject({
        deploymentId: 'deploy_primary',
        ownerNanoHostIdentityId: 'integration_nanohost_primary',
        scope: 'nanohost-transport',
        tokenId: issued.tokenId,
        tokenType: 'nanohost-transport',
      });
      expect(JSON.stringify(verified)).not.toContain(issued.secret);
      expect(verifyNanoHostTransportTokenRecord(coreDb, 'okt_wrong')).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rotates and revokes without leaking raw secrets into redacted records', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-token-store-rotate-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertActiveIdentity(coreDb);

      const issued = createNanoHostTransportTokenRecord(coreDb, {
        deploymentId: 'deploy_primary',
        expiresAt: '2026-09-08T00:00:00.000Z',
        now: new Date('2026-08-08T00:00:00.000Z'),
        ownerNanoHostIdentityId: 'integration_nanohost_primary',
        responsibleServerAdminActorId: 'user_admin',
      });
      const rotated = rotateNanoHostTransportTokenRecord(coreDb, issued.tokenId, {
        now: new Date('2026-08-08T01:00:00.000Z'),
        overlapSeconds: 60,
      });
      const revoked = revokeNanoHostTransportTokenRecord(coreDb, rotated?.tokenId ?? '', {
        now: new Date('2026-08-08T02:00:00.000Z'),
      });

      expect(rotated?.secret).toMatch(/^okt_/);
      expect(rotated?.secret).not.toBe(issued.secret);
      expect(JSON.stringify(rotated)).not.toContain(issued.secret);
      expect(rotated?.record).toMatchObject({
        predecessorTokenId: issued.tokenId,
        scope: 'nanohost-transport',
        tokenType: 'nanohost-transport',
      });
      expect(rotated?.rotatedRecord).toMatchObject({
        status: 'rotated',
        tokenId: issued.tokenId,
      });
      expect(revoked).toMatchObject({
        status: 'revoked',
        tokenId: rotated?.tokenId,
      });
      expect(JSON.stringify(revoked)).not.toContain(rotated?.secret);
      expect(
        verifyNanoHostTransportTokenRecord(coreDb, rotated?.secret ?? '', {
          now: new Date('2026-08-08T02:00:00.000Z'),
        })
      ).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });
});

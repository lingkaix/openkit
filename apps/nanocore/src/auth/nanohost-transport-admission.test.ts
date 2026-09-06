import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { admitNanoHostTransportConnection } from './nanohost-transport-admission.js';
import { createNanoHostTransportSessionAuthority } from './nanohost-transport-session.js';
import { createNanoHostTransportTokenRecord } from './nanohost-transport-token-store.js';

/**
 * WP-2b R2 red: production NanoHost transport admission consumes token verify
 * and session authority (`admit` / `fencePredecessor` / `mayCarryWork`) on a
 * real admission path (`docs/specs/20260802-nanohost_runtime_and_transport.md`).
 *
 * Prefer fail-on-absence: production admission helpers and routes must exist
 * and gate successor work until the predecessor is fenced.
 */

/**
 * Issues one active NanoHost transport Token for admission fixtures.
 *
 * @param coreDb Core database handles.
 * @returns Issued secret plus identity and deployment ids.
 */
function issueTransportToken(coreDb: CoreDb): {
  deploymentId: string;
  identityId: string;
  secret: string;
} {
  const identityId = 'integration_nanohost_primary';
  const deploymentId = 'deploy_primary';
  coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_integration_identities (
        identity_id, deployment_id, status, created_at
      ) VALUES (?, ?, 'active', ?)`
    )
    .run(identityId, deploymentId, '2026-08-08T00:00:00.000Z');
  const issued = createNanoHostTransportTokenRecord(coreDb, {
    deploymentId,
    expiresAt: '2026-09-08T00:00:00.000Z',
    now: new Date('2026-08-08T00:00:00.000Z'),
    ownerNanoHostIdentityId: identityId,
    responsibleServerAdminActorId: 'user_admin',
  });
  return { deploymentId, identityId, secret: issued.secret };
}

describe('NanoHost transport production admission', () => {
  it('rejects unauthenticated or missing native connection context before allocation', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-admit-bad-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const { secret } = issueTransportToken(coreDb);
      const authority = createNanoHostTransportSessionAuthority();

      const denied = admitNanoHostTransportConnection(coreDb, authority, {
        physicalConnection: null as never,
        secret: 'okt_not_a_real_nanohost_transport_token_aaaaaaaaaaaa',
        targetId: 'runtime-target-primary',
        now: new Date('2026-08-08T00:00:00.000Z'),
      });

      expect(denied).toEqual({ ok: false, reason: 'unauthorized' });
      expect(authority.authoritativeGeneration('integration_nanohost_primary')).toBeNull();
      expect(getNanoHostRuntimeTarget(coreDb, 'runtime-target-primary')).toBeNull();

      const missingContext = admitNanoHostTransportConnection(coreDb, authority, {
        physicalConnection: null as never,
        secret,
        targetId: 'runtime-target-primary',
        now: new Date('2026-08-08T00:01:00.000Z'),
      });
      expect(missingContext).toEqual({ ok: false, reason: 'missing_connection_context' });
      expect(getNanoHostRuntimeTarget(coreDb, 'runtime-target-primary')).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });
});

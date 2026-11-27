import { describe, expect, it, vi } from 'vitest';
import { openNanoHostTestOwner } from '../test-support/nanohost-owner.js';
import {
  createNanoHostTransportTokenRecord,
  revokeNanoHostTransportTokenRecord,
  rotateNanoHostTransportTokenRecord,
  verifyNanoHostTransportTokenRecord,
} from './nanohost-transport-token-store.js';

/** Inserts the exact active identity required by Token issuance fixtures. */
function insertActiveIdentity(nanoHost: ReturnType<typeof openNanoHostTestOwner>): void {
  nanoHost.setup((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO nanohost_integration_identities (
        identity_id, deployment_id, status, created_at
      ) VALUES ('integration_nanohost_primary', 'deploy_primary', 'active', ?)`
      )
      .run('2026-08-08T00:00:00.000Z');
  });
}

/**
 * S-2b-1 Unit 2: NanoHost transport token store lifecycle.
 *
 * Contract: NanoCore stores only a hash plus non-secret Token metadata, and
 * issue/verify/rotate/revoke must not leak raw `okt_` secrets into durable rows
 * or redacted records (`docs/specs/20260802-nanohost_runtime_and_transport.md`).
 *
 * The test submits through an admitted Native owner and reads the retained rows after reopen.
 */
describe('NanoHost transport token store', () => {
  it('issues hash-only records and verifies without leaking the raw secret', async () => {
    const nanoHost = openNanoHostTestOwner();
    insertActiveIdentity(nanoHost);

    const issued = await createNanoHostTransportTokenRecord(nanoHost.storage, {
      deploymentId: 'deploy_primary',
      expiresAt: '2026-09-08T00:00:00.000Z',
      now: new Date('2026-08-08T00:00:00.000Z'),
      ownerNanoHostIdentityId: 'integration_nanohost_primary',
      responsibleServerAdminActorId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
    });
    await nanoHost.reopen();
    const rows = nanoHost.sqlite.prepare('SELECT * FROM nanohost_transport_tokens').all() as Array<{
      scope: string;
      token_hash: string;
      token_type: string;
    }>;
    const verified = await verifyNanoHostTransportTokenRecord(nanoHost.storage, issued.secret, {
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
    expect(await verifyNanoHostTransportTokenRecord(nanoHost.storage, 'okt_wrong')).toBeNull();
  });

  it('holds administrator issuance until the original Core decision is available', async () => {
    const nanoHost = openNanoHostTestOwner();
    insertActiveIdentity(nanoHost);
    const submit = vi.spyOn(nanoHost.storage.owner, 'transport');
    const administrator = 'usr_00000000-0000-768a-8658-44c33d82c1f5';

    await expect(
      createNanoHostTransportTokenRecord(
        nanoHost.storage,
        {
          deploymentId: 'deploy_primary',
          expiresAt: '2026-09-08T00:00:00.000Z',
          now: new Date('2026-08-08T00:00:00.000Z'),
          ownerNanoHostIdentityId: 'integration_nanohost_primary',
          responsibleServerAdminActorId: administrator,
        },
        { kind: 'local', userId: administrator }
      )
    ).rejects.toMatchObject({ code: 'precondition', commit: 'not-committed' });
    expect(submit).not.toHaveBeenCalled();
    expect(nanoHost.sqlite.prepare('SELECT * FROM nanohost_transport_tokens').all()).toEqual([]);
  });

  it('rotates and revokes without leaking raw secrets into redacted records', async () => {
    const nanoHost = openNanoHostTestOwner();
    insertActiveIdentity(nanoHost);

    const issued = await createNanoHostTransportTokenRecord(nanoHost.storage, {
      deploymentId: 'deploy_primary',
      expiresAt: '2026-09-08T00:00:00.000Z',
      now: new Date('2026-08-08T00:00:00.000Z'),
      ownerNanoHostIdentityId: 'integration_nanohost_primary',
      responsibleServerAdminActorId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
    });
    const rotated = await rotateNanoHostTransportTokenRecord(nanoHost.storage, issued.tokenId, {
      now: new Date('2026-08-08T01:00:00.000Z'),
      overlapSeconds: 60,
    });
    const revoked = await revokeNanoHostTransportTokenRecord(
      nanoHost.storage,
      rotated?.tokenId ?? '',
      {
        now: new Date('2026-08-08T02:00:00.000Z'),
      }
    );

    await nanoHost.reopen();
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
      await verifyNanoHostTransportTokenRecord(nanoHost.storage, rotated?.secret ?? '', {
        now: new Date('2026-08-08T02:00:00.000Z'),
      })
    ).toBeNull();
  });
});

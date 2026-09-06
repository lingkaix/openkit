import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  deliverNanoHostTransportTokenToNamedSlot,
  type NanoHostCredentialSinkPaths,
} from './nanohost-transport-sink.js';
import {
  createNanoHostTransportTokenRecord,
  revokeNanoHostTransportTokenRecord,
  verifyNanoHostTransportTokenRecord,
} from './nanohost-transport-token-store.js';

/**
 * WP-2b R1 red: named safe-sink delivery.
 *
 * Contract: Enrollment And One-Time Delivery writes the raw token exactly once
 * to the named slot plus non-secret companion metadata at mode `0600`, and
 * fails closed when the write is unproved
 * (`docs/specs/20260802-nanohost_runtime_and_transport.md`).
 *
 * Prefer fail-on-absence: imports `./nanohost-transport-sink.js` which must
 * exist as the NanoCore delivery surface matching the credential_slots
 * companion projection.
 */
describe('NanoHost transport named safe-sink delivery', () => {
  it('writes secret and companion at the declared A/B paths with mode 0600', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-sink-ok-'));
    const sink: NanoHostCredentialSinkPaths = {
      secretPath: join(root, 'A.token'),
      companionPath: join(root, 'A.meta'),
    };
    const secret = 'okt_sinkdeliverysecretaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const result = deliverNanoHostTransportTokenToNamedSlot({
      deploymentId: 'deploy_primary',
      identityId: 'integration_nanohost_primary',
      issuanceGeneration: 1,
      secret,
      sink,
      slot: 'A',
      tokenId: 'tok_sink_a',
      writeDisposition: 'exclusive-create',
    });

    expect(result).toEqual({
      issuanceGeneration: 1,
      slot: 'A',
      status: 'written',
    });
    expect(readFileSync(sink.secretPath, 'utf8')).toBe(secret);
    expect(readFileSync(sink.companionPath, 'utf8')).toBe(
      [
        'token_id=tok_sink_a',
        'issuance_generation=1',
        'identity_id=integration_nanohost_primary',
        'deployment_id=deploy_primary',
        '',
      ].join('\n')
    );
    expect(statSync(sink.secretPath).mode & 0o777).toBe(0o600);
    expect(statSync(sink.companionPath).mode & 0o777).toBe(0o600);
  });

  it('fails closed when the sink write is unproved and leaves the token unusable', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-sink-fail-'));
    const coreDb = openCoreDb(dataRoot);
    const blocked = join(dataRoot, 'blocked-as-file');

    try {
      applyMigrations(coreDb);
      writeFileSync(blocked, 'not-a-directory');
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_integration_identities (
            identity_id, deployment_id, status, created_at
          ) VALUES ('integration_nanohost_primary', 'deploy_primary', 'active', ?)`
        )
        .run('2026-08-08T00:00:00.000Z');
      const issued = createNanoHostTransportTokenRecord(coreDb, {
        deploymentId: 'deploy_primary',
        expiresAt: '2026-09-08T00:00:00.000Z',
        now: new Date('2026-08-08T00:00:00.000Z'),
        ownerNanoHostIdentityId: 'integration_nanohost_primary',
        responsibleServerAdminActorId: 'user_admin',
      });

      expect(() =>
        deliverNanoHostTransportTokenToNamedSlot({
          deploymentId: 'deploy_primary',
          identityId: 'integration_nanohost_primary',
          issuanceGeneration: 1,
          secret: issued.secret,
          sink: {
            // Parent path is a regular file → write cannot be proved.
            secretPath: join(blocked, 'A.token'),
            companionPath: join(blocked, 'A.meta'),
          },
          slot: 'A',
          tokenId: issued.tokenId,
          writeDisposition: 'exclusive-create',
        })
      ).toThrow();

      revokeNanoHostTransportTokenRecord(coreDb, issued.tokenId, {
        now: new Date('2026-08-08T00:00:01.000Z'),
      });

      expect(
        verifyNanoHostTransportTokenRecord(coreDb, issued.secret, {
          now: new Date('2026-08-08T00:00:02.000Z'),
        })
      ).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('exclusive-create leaves an occupied foreign-token slot untouched', () => {
    const { companion, secret, sink } = occupiedSlot({
      companion: companionBytes('tok_foreign'),
      secret: 'okt_foreign_owner_secret_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    expect(() =>
      deliverExclusive({
        secret: 'okt_loser_secret_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sink,
        tokenId: 'tok_loser',
      })
    ).toThrow();

    expect(readFileSync(sink.secretPath, 'utf8')).toBe(secret);
    expect(readFileSync(sink.companionPath, 'utf8')).toBe(companion);
  });

  it('exclusive-create never cleans a pre-existing slot that already names the attempted Token', () => {
    const { companion, secret, sink } = occupiedSlot({
      companion: companionBytes('tok_same'),
      secret: 'okt_same_token_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    expect(() =>
      deliverExclusive({
        secret: 'okt_retry_same_token_bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sink,
        tokenId: 'tok_same',
      })
    ).toThrow();

    expect(existsSync(sink.secretPath)).toBe(true);
    expect(existsSync(sink.companionPath)).toBe(true);
    expect(readFileSync(sink.secretPath, 'utf8')).toBe(secret);
    expect(readFileSync(sink.companionPath, 'utf8')).toBe(companion);
  });

  it('exclusive-create leaves missing, malformed, and partial companions blocking', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-sink-partial-'));
    const missingCompanion = {
      companionPath: join(root, 'missing.meta'),
      secretPath: join(root, 'missing.token'),
    };
    const malformed = {
      companionPath: join(root, 'malformed.meta'),
      secretPath: join(root, 'malformed.token'),
    };
    writeFileSync(missingCompanion.secretPath, 'okt_partial_secret_aaaaaaaaaaaaaaaaaaaaaaaaaa', {
      mode: 0o600,
    });
    writeFileSync(malformed.secretPath, 'okt_malformed_secret_aaaaaaaaaaaaaaaaaaaaaaaa', {
      mode: 0o600,
    });
    writeFileSync(malformed.companionPath, 'not-a-token-companion\n', { mode: 0o600 });

    expect(() =>
      deliverExclusive({
        secret: 'okt_loser_secret_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sink: missingCompanion,
        tokenId: 'tok_loser',
      })
    ).toThrow();
    expect(existsSync(missingCompanion.secretPath)).toBe(true);
    expect(existsSync(missingCompanion.companionPath)).toBe(false);
    expect(readFileSync(missingCompanion.secretPath, 'utf8')).toBe(
      'okt_partial_secret_aaaaaaaaaaaaaaaaaaaaaaaaaa'
    );

    expect(() =>
      deliverExclusive({
        secret: 'okt_loser_secret_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sink: malformed,
        tokenId: 'tok_loser',
      })
    ).toThrow();
    expect(readFileSync(malformed.secretPath, 'utf8')).toBe(
      'okt_malformed_secret_aaaaaaaaaaaaaaaaaaaaaaaa'
    );
    expect(readFileSync(malformed.companionPath, 'utf8')).toBe('not-a-token-companion\n');
  });

  it('replace overwrites an occupied slot used by issue and rotation', () => {
    const { sink } = occupiedSlot({
      companion: companionBytes('tok_old'),
      secret: 'okt_old_slot_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const replacement = 'okt_replaced_slot_secret_bbbbbbbbbbbbbbbbbbbbbbbb';

    const result = deliverNanoHostTransportTokenToNamedSlot({
      deploymentId: 'deploy_primary',
      identityId: 'integration_nanohost_primary',
      issuanceGeneration: 2,
      secret: replacement,
      sink,
      slot: 'A',
      tokenId: 'tok_new',
      writeDisposition: 'replace',
    });

    expect(result.status).toBe('written');
    expect(readFileSync(sink.secretPath, 'utf8')).toBe(replacement);
    expect(readFileSync(sink.companionPath, 'utf8')).toContain('token_id=tok_new');
  });

  it('refuses a missing write disposition instead of defaulting', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-sink-nodisp-'));
    const sink: NanoHostCredentialSinkPaths = {
      companionPath: join(root, 'A.meta'),
      secretPath: join(root, 'A.token'),
    };

    expect(() =>
      deliverNanoHostTransportTokenToNamedSlot({
        deploymentId: 'deploy_primary',
        identityId: 'integration_nanohost_primary',
        issuanceGeneration: 1,
        secret: 'okt_missing_disposition_aaaaaaaaaaaaaaaaaaaaaaaa',
        sink,
        slot: 'A',
        tokenId: 'tok_missing',
      } as never)
    ).toThrow(/write disposition/u);
    expect(existsSync(sink.secretPath)).toBe(false);
    expect(existsSync(sink.companionPath)).toBe(false);
  });
});

function companionBytes(tokenId: string): string {
  return [
    `token_id=${tokenId}`,
    'issuance_generation=1',
    'identity_id=integration_nanohost_primary',
    'deployment_id=deploy_primary',
    '',
  ].join('\n');
}

function occupiedSlot(files: { companion: string; secret: string }): {
  companion: string;
  secret: string;
  sink: NanoHostCredentialSinkPaths;
} {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-sink-occupied-'));
  const sink = {
    companionPath: join(root, 'A.meta'),
    secretPath: join(root, 'A.token'),
  };
  writeFileSync(sink.secretPath, files.secret, { mode: 0o600 });
  writeFileSync(sink.companionPath, files.companion, { mode: 0o600 });
  return { companion: files.companion, secret: files.secret, sink };
}

function deliverExclusive(input: {
  secret: string;
  sink: NanoHostCredentialSinkPaths;
  tokenId: string;
}): ReturnType<typeof deliverNanoHostTransportTokenToNamedSlot> {
  return deliverNanoHostTransportTokenToNamedSlot({
    deploymentId: 'deploy_primary',
    identityId: 'integration_nanohost_primary',
    issuanceGeneration: 2,
    secret: input.secret,
    sink: input.sink,
    slot: 'A',
    tokenId: input.tokenId,
    writeDisposition: 'exclusive-create',
  });
}

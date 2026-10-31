import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createNanoHostEffectRequest } from './nanohost-effect-identity.js';

// Credential declarations / Runtime File Visibility: integrity digests and
// comparison literals are private transfer checks, never retained fingerprints.
const identity = { backendSessionId: 'backend-fixture', packageSnapshotId: 'package-fixture' };

describe('private credential effect identity', () => {
  it('keeps credential body and digest out of the retained import identity', () => {
    const request = (body: Buffer) =>
      createNanoHostEffectRequest(identity, 'attempt-fixture', 'reference.import', {
        sandboxId: 'sandbox-fixture',
        slot: 'runtime-credential',
        relativePath: 'a'.repeat(64),
        entryKind: 'file',
        executable: false,
        body,
        byteLength: body.length,
        sha256: randomBytes(32).toString('hex'),
      });
    const first = request(randomBytes(32));
    const second = request(randomBytes(48));
    expect(
      first.requestId === second.requestId,
      'private transfer facts entered retained identity'
    ).toBe(true);
    expect(Buffer.isBuffer(first.input.body)).toBe(true);
  });

  it('binds replacement to exact receipt generations while excluding material transfer facts', () => {
    const request = (body: Buffer, expected: string, successor: string) =>
      createNanoHostEffectRequest(identity, 'attempt-fixture', 'reference.import', {
        sandboxId: 'sandbox-fixture',
        slot: 'runtime-credential-replace',
        relativePath: `${'a'.repeat(64)}/${expected}/${successor}`,
        entryKind: 'file',
        executable: false,
        body,
        byteLength: body.length,
        sha256: randomBytes(32).toString('hex'),
      });
    const expected = randomBytes(32).toString('hex');
    const successor = randomBytes(32).toString('hex');
    const first = request(randomBytes(32), expected, successor);
    expect(first.requestId === request(randomBytes(48), expected, successor).requestId).toBe(true);
    expect(first.requestId === request(randomBytes(32), successor, expected).requestId).toBe(false);
    expect(
      first.requestId ===
        request(randomBytes(32), expected, randomBytes(32).toString('hex')).requestId
    ).toBe(false);
  });

  it('keeps collection comparison bytes out of retained identity while preserving collection lineage', () => {
    const request = (values: string[], collectionId = 'collection-fixture') =>
      createNanoHostEffectRequest(identity, 'attempt-fixture', 'workspace.collect', {
        sandboxId: 'sandbox-fixture',
        collectionId,
        checkValues: { runtimeEnv: values },
      });
    const first = request([randomBytes(32).toString('hex')]);
    expect(first.requestId === request([randomBytes(32).toString('hex')]).requestId).toBe(true);
    expect(first.requestId === request([], 'another-collection').requestId).toBe(false);
  });

  it('still binds ordinary noncredential imports to their declared content integrity', () => {
    const request = (sha256: string) =>
      createNanoHostEffectRequest(identity, 'attempt-fixture', 'reference.import', {
        sandboxId: 'sandbox-fixture',
        slot: 'context',
        relativePath: 'fixture',
        sha256,
      });
    expect(request('first').requestId === request('second').requestId).toBe(false);
  });
});

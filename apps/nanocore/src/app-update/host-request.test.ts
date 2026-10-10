import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  encodeAppUpdateHostCommand,
  parseAppUpdateHostCommand,
  parseAppUpdateHostOutput,
} from './host-request.js';

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

describe('app-update host command', () => {
  it('encodes a closed prepare command without caller-chosen host fields', () => {
    const command = parseAppUpdateHostCommand(
      encodeAppUpdateHostCommand({
        expectedCurrentImageId: DIGEST,
        op: 'prepare',
        source: { appDigest: DIGEST, sourceCommit: COMMIT, tag: 'v0.1.0' },
      })
    );

    expect(command).toEqual({
      expectedCurrentImageId: DIGEST,
      op: 'prepare',
      source: { appDigest: DIGEST, sourceCommit: COMMIT, tag: 'v0.1.0' },
    });
  });

  it.each([
    {
      command: 'docker restart',
      op: 'prepare',
      expectedCurrentImageId: DIGEST,
      source: { appDigest: DIGEST, sourceCommit: COMMIT, tag: 'v0.1.0' },
    },
    { op: 'stage', sourceCommit: COMMIT },
    { op: 'status', requestId: 'req_not_a_host_uuid' },
    { op: 'start', requestId: '11111111-1111-4111-8111-111111111111' },
  ])('rejects unknown verbs, host fields, and missing start consent: %j', (payload) => {
    expect(() => parseAppUpdateHostCommand(Buffer.from(JSON.stringify(payload)))).toThrow();
  });

  it('rejects oversized helper stdin', () => {
    expect(() => parseAppUpdateHostCommand(Buffer.alloc(16 * 1024 + 1, 0x7b))).toThrow(
      /16 KiB stdin limit/
    );
  });

  it('parses helper stdout as a public receipt or coded error', () => {
    const failure = parseAppUpdateHostOutput(
      Buffer.from(
        JSON.stringify({
          error: {
            code: 'app_update_busy',
            message: 'An App update is already running.',
          },
        })
      )
    );
    expect(failure).toEqual({
      ok: false,
      code: 'app_update_busy',
      message: 'An App update is already running.',
    });
  });
});

/** Complete observed receipt with independent candidate and predecessor identities. */
function succeededReceipt() {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const boot = {
    acceptingProductWork: true,
    blockingReasons: [],
    bootId: `boot_${requestId}`,
    imageId: DIGEST,
    sourceCommit: COMMIT,
  };
  return {
    candidateBoot: boot,
    candidateImageId: DIGEST,
    completedAt: '2026-09-10T00:02:00.000Z',
    error: null,
    expectedCurrentImageId: `sha256:${'c'.repeat(64)}`,
    jobId: 'job_app-update.service',
    outcome: 'succeeded',
    predicates: {
      acceptingProductWork: true,
      helperReachable: true,
      imageMatch: true,
      nanohostReady: null,
      newBoot: true,
      noBlockingReadiness: true,
      retainedAuthRead: true,
      sourceMatch: true,
      webAssets: null,
    },
    preparedAt: '2026-09-10T00:00:00.000Z',
    previousAppRestored: false,
    previousBoot: {
      ...boot,
      bootId: 'boot_22222222-2222-4222-8222-222222222222',
      imageId: `sha256:${'c'.repeat(64)}`,
    },
    previousImageId: `sha256:${'c'.repeat(64)}`,
    requestId,
    source: { sourceCommit: COMMIT, appDigest: DIGEST, tag: 'v0.1.0' },
    stage: 'succeeded',
    startedAt: '2026-09-10T00:01:00.000Z',
  };
}

it('reads and rewrites an extended helper receipt without forwarding observed annotations', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-helper-receipt-'));
  const path = join(root, 'receipt.json');
  try {
    const receipt = succeededReceipt();
    const extended = {
      ...receipt,
      futureAnnotation: true,
      source: { ...receipt.source, kind: 'release', futureAnnotation: true },
      candidateBoot: { ...receipt.candidateBoot, futureAnnotation: true },
      previousBoot: { ...receipt.previousBoot, futureAnnotation: true },
      predicates: { ...receipt.predicates, futureAnnotation: true },
    };
    writeFileSync(path, JSON.stringify(extended));
    const read = parseAppUpdateHostOutput(readFileSync(path));
    expect(read).toEqual({ ok: true, status: receipt });
    if (!read.ok) throw new Error('Receipt was refused');
    writeFileSync(path, JSON.stringify(read.status));
    expect(parseAppUpdateHostOutput(readFileSync(path))).toEqual(read);
    expect(() =>
      parseAppUpdateHostCommand(
        Buffer.from(
          JSON.stringify({ expectedCurrentImageId: DIGEST, op: 'prepare', source: extended.source })
        )
      )
    ).toThrow();
    expect(
      parseAppUpdateHostOutput(
        Buffer.from(
          JSON.stringify({
            futureAnnotation: true,
            error: { code: 'app_update_busy', message: 'Busy', futureAnnotation: true },
          })
        )
      )
    ).toEqual({ ok: false, code: 'app_update_busy', message: 'Busy' });
    for (const invalid of [
      { ...extended, stage: 'future-stage' },
      { ...extended, outcome: 'running' },
      { ...extended, predicates: { ...extended.predicates, sourceMatch: false } },
      { ...extended, source: { ...extended.source, tag: 'latest' } },
      { ...extended, source: { kind: 'commit', sourceCommit: COMMIT } },
    ]) {
      expect(parseAppUpdateHostOutput(Buffer.from(JSON.stringify(invalid)))).toMatchObject({
        ok: false,
        code: 'app_update_recovery_required',
      });
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

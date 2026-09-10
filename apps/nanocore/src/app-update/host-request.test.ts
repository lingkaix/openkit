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
        source: { kind: 'commit', sourceCommit: COMMIT },
      })
    );

    expect(command).toEqual({
      expectedCurrentImageId: DIGEST,
      op: 'prepare',
      source: { kind: 'commit', sourceCommit: COMMIT },
    });
  });

  it.each([
    {
      command: 'docker restart',
      op: 'prepare',
      expectedCurrentImageId: DIGEST,
      source: { kind: 'commit', sourceCommit: COMMIT },
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

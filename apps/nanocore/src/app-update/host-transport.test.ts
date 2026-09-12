// openkit-test-platform: posix
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { APP_UPDATE_RECEIPT_LIMIT_BYTES } from './host-request.js';
import {
  assertAppUpdateSecretPath,
  buildAppUpdateSshArgs,
  createSshAppUpdateHostTransport,
  invokeAppUpdateHostChild,
} from './host-transport.js';

const CONFIG = {
  host: '127.0.0.1',
  identityFile: '/run/openkit/app-update/id_ed25519',
  knownHostsFile: '/run/openkit/app-update/known_hosts',
  port: 22,
  user: 'openkit-update',
};

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const PREPARED_RECEIPT = {
  candidateBoot: null,
  candidateImageId: null,
  completedAt: null,
  error: null,
  expectedCurrentImageId: DIGEST,
  jobId: null,
  outcome: 'prepared' as const,
  predicates: null,
  preparedAt: '2026-09-10T00:00:00.000Z',
  previousAppRestored: null,
  previousBoot: null,
  previousImageId: null,
  requestId: '11111111-1111-4111-8111-111111111111',
  source: { kind: 'commit' as const, sourceCommit: COMMIT },
  stage: 'prepared' as const,
  startedAt: null,
};

describe('app-update SSH transport', () => {
  it('builds a forced-command SSH vector with host-key verification and no forwarding', () => {
    const args = buildAppUpdateSshArgs(CONFIG);

    expect(args).toEqual(
      expect.arrayContaining([
        '-o',
        'BatchMode=yes',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'RequestTTY=no',
        '-p',
        '22',
        '--',
        'openkit-update@127.0.0.1',
      ])
    );
    expect(args.at(-1)).toBe('openkit-update@127.0.0.1');
    expect(args.join(' ')).not.toMatch(/docker|bash -c|SSH_ORIGINAL_COMMAND/);
  });

  it('rejects identity files inside Data Root', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-app-update-key-'));
    const nested = join(dataRoot, 'secrets', 'id_ed25519');
    mkdirSync(join(dataRoot, 'secrets'));
    writeFileSync(nested, 'not-a-secret-key\n');

    expect(() => assertAppUpdateSecretPath(nested, dataRoot)).toThrow(/outside Data Root/);
  });

  it('keeps the SSH transport serving when the identity file is missing', async () => {
    const transport = createSshAppUpdateHostTransport(
      {
        ...CONFIG,
        identityFile: join(tmpdir(), 'openkit-missing-app-update-id'),
        knownHostsFile: join(tmpdir(), 'openkit-missing-app-update-known-hosts'),
      },
      null
    );

    await expect(
      transport.invoke({ op: 'status', requestId: PREPARED_RECEIPT.requestId })
    ).resolves.toEqual({
      ok: false,
      code: 'app_update_unavailable',
      message: 'App-update SSH identity is not a usable regular file.',
    });
  });

  it('classifies a linked identity as unavailable without throwing from transport creation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-app-update-link-'));
    const target = join(dir, 'id_ed25519');
    const linked = join(dir, 'id_ed25519.link');
    const knownHostsFile = join(dir, 'known_hosts');
    writeFileSync(target, 'not-a-secret-key\n');
    writeFileSync(knownHostsFile, 'host-key\n');
    symlinkSync(target, linked);
    const transport = createSshAppUpdateHostTransport(
      {
        ...CONFIG,
        identityFile: linked,
        knownHostsFile,
      },
      null
    );

    const result = await transport.invoke({
      op: 'status',
      requestId: PREPARED_RECEIPT.requestId,
    });

    expect(result).toEqual({
      ok: false,
      code: 'app_update_unavailable',
      message: 'App-update SSH identity is not a usable regular file.',
    });
    expect(JSON.stringify(result)).not.toContain(linked);
  });

  it('rejects oversized stdout while it is still arriving', async () => {
    const child = createFakeHostChild();
    const pending = invokeAppUpdateHostChild(child, Buffer.from('{}\n'));

    child.stdout.write(Buffer.alloc(APP_UPDATE_RECEIPT_LIMIT_BYTES + 1, 0x78));

    await expect(pending).resolves.toEqual({
      ok: false,
      code: 'app_update_recovery_required',
      message: 'App-update host output exceeds the 64 KiB receipt limit.',
    });
    expect(child.killed).toBe(true);
  });

  it('ignores stdin EPIPE and still parses helper stdout', async () => {
    const child = createFakeHostChild();
    const pending = invokeAppUpdateHostChild(child, Buffer.from('{}\n'));
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    child.stdin.emit('error', epipe);
    child.stdout.write(Buffer.from(JSON.stringify(PREPARED_RECEIPT)));
    child.stdout.end();
    child.emit('close', 0);

    await expect(pending).resolves.toEqual({ ok: true, status: PREPARED_RECEIPT });
  });
});

function createFakeHostChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => boolean;
    stdin: PassThrough;
    stderr: PassThrough;
    stdout: PassThrough;
  };
  child.killed = false;
  child.stdin = stdin;
  child.stderr = stderr;
  child.stdout = stdout;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

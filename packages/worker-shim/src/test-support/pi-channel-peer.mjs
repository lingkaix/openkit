import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname } from 'node:path';

// A controlled fd 3 peer exercises transport failures that the real host must never emit.
const channel = new Socket({ fd: 3, readable: true, writable: true });
const mode = process.env.PI_PEER_MODE;
const marker = process.env.PI_PEER_MARKER;
let buffer = '';
let handle = '';
let previous = null;
let activeId = '';
let secret = '';
setInterval(() => {}, 1000);

function send(value) {
  channel.write(`${JSON.stringify(value)}\n`);
}

channel.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.id === 0 && request.op === undefined) {
      // Prove fixture startup without opening a session or entering a fault mode.
      send({
        id: 0,
        ok: false,
        error: { code: 'invalid_request', message: 'Request is invalid.' },
      });
    } else if (request.op === 'open') {
      if (mode === 'silent-open') {
        newline = buffer.indexOf('\n');
        continue;
      }
      secret = request.capabilityCredential;
      const path = `${request.stateRoot}/sessions/peer/session.jsonl`;
      handle = JSON.stringify({ cwd: request.workingDirectory, path, sessionId: 'peer-session' });
      send({ id: request.id, ok: true, result: { nativeHandle: { state: 'pending' } } });
    } else if (request.op === 'turn') {
      send({ id: request.id, ok: true, result: { state: 'started' } });
      activeId = request.turnId;
      if (mode.startsWith('race-')) {
        setTimeout(() => marker && writeFileSync(marker, 'late native work'), 300);
        if (mode === 'race-malformed')
          setTimeout(
            () =>
              channel.write(
                '{bad json}\n' +
                  JSON.stringify({
                    event: 'turn_settled',
                    turnId: activeId,
                    outcome: { status: 'failed', reason: 'pi-prompt-failed' },
                    nativeHandle: { state: 'pending' },
                    compactionEntryIds: [],
                  }) +
                  '\n'
              ),
            10
          );
        newline = buffer.indexOf('\n');
        continue;
      }
      if (
        mode === 'silent' ||
        mode === 'bad-interrupt' ||
        (mode.startsWith('interrupt-') && !mode.startsWith('interrupt-after-')) ||
        mode.startsWith('active-inspect-')
      ) {
        newline = buffer.indexOf('\n');
        continue;
      }
      if (mode === 'malformed' || mode === 'disconnect') {
        if (mode === 'malformed') channel.write('{bad json}\n');
        else channel.end();
        setTimeout(() => marker && writeFileSync(marker, 'late native work'), 100);
        newline = buffer.indexOf('\n');
        continue;
      }
      const parsed = JSON.parse(handle);
      mkdirSync(dirname(parsed.path), { recursive: true });
      writeFileSync(
        parsed.path,
        `${JSON.stringify({ type: 'session', id: parsed.sessionId, cwd: parsed.cwd })}\n`
      );
      const nativeHandle = {
        state: 'ready',
        handle,
        digest: createHash('sha256').update(handle).digest('hex'),
      };
      const settled = (turnId, outcome) => ({
        event: 'turn_settled',
        turnId,
        outcome,
        nativeHandle,
        compactionEntryIds: [],
      });
      const first = settled(request.turnId, { status: 'completed', assistantText: 'answer' });
      if (mode.startsWith('semantic-')) {
        const variants = {
          status: { status: 'future-status' },
          failure: { status: 'failed', reason: 'future-reason' },
          interruption: { status: 'interrupted', reason: 'future-reason' },
          shape: [],
          handle: first.outcome,
        };
        first.outcome = variants[mode.slice(9)];
        if (mode === 'semantic-handle') first.nativeHandle = { state: 'future-state' };
        send(first);
        setTimeout(() => marker && writeFileSync(marker, 'late native work'), 200);
        newline = buffer.indexOf('\n');
        continue;
      }
      if (mode.startsWith('prior-') && previous) {
        send(
          mode === 'prior-identical'
            ? previous
            : { ...previous, outcome: { status: 'failed', reason: 'pi-prompt-failed' } }
        );
        setTimeout(() => send(first), 150);
        newline = buffer.indexOf('\n');
        continue;
      }
      if (mode === 'observations') {
        for (let i = 0; i < 100; i++)
          send({ event: 'ui_unsupported', turnId: request.turnId, method: secret.repeat(1000) });
        first.compactionEntryIds = Array(100).fill(secret.repeat(1000));
      }
      if (mode.startsWith('utf8-')) {
        const bytes = Buffer.from('😀');
        const split = Number(mode.slice(5));
        process.stdout.write(bytes.subarray(0, split));
        setTimeout(() => process.stdout.write(bytes.subarray(split)), 20);
        first.outcome = { status: 'failed', reason: 'pi-prompt-failed' };
        setTimeout(() => send(first), 50);
        newline = buffer.indexOf('\n');
        continue;
      }
      previous = first;
      const second = settled(request.turnId, { status: 'failed', reason: 'pi-prompt-failed' });
      if (mode === 'duplicate') {
        channel.write(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
      } else if (mode === 'delayed-duplicate') {
        send(first);
        setTimeout(() => send(second), 100);
      } else if (mode === 'wrong-turn') {
        send(settled('wrong-turn', { status: 'failed', reason: 'pi-prompt-failed' }));
        send(first);
      } else {
        send(first);
      }
    } else if (request.op === 'inspect') {
      if (!handle) {
        send(
          mode === 'ready-open'
            ? {
                id: request.id,
                ok: true,
                result: { state: 'idle', nativeHandle: { state: 'pending' }, turnId: null },
              }
            : {
                id: request.id,
                ok: false,
                error: {
                  code: mode === 'ready-error' ? 'setup_failed' : 'invalid_state',
                  message: mode === 'ready-closing' ? 'Host is closing.' : 'Host is not open.',
                },
              }
        );
        newline = buffer.indexOf('\n');
        continue;
      }
      if (mode === 'active-inspect-silent') {
        newline = buffer.indexOf('\n');
        continue;
      }
      if (mode === 'race-inspect') {
        send({ id: request.id, ok: false, error: { code: 'identity_failed', message: 'bad' } });
        setTimeout(
          () =>
            send({
              event: 'turn_settled',
              turnId: activeId,
              outcome: { status: 'failed', reason: 'pi-prompt-failed' },
              nativeHandle: { state: 'pending' },
              compactionEntryIds: [],
            }),
          30
        );
        newline = buffer.indexOf('\n');
        continue;
      }
      if (mode === 'active-inspect-error') {
        send({ id: request.id, ok: false, error: { code: 'identity_failed', message: 'bad' } });
        newline = buffer.indexOf('\n');
        continue;
      }
      const nativeHandle =
        mode === 'unknown-state' || mode === 'active-inspect-unknown'
          ? { state: 'future-state' }
          : {
              state: 'ready',
              handle: mode === 'mismatched-handle' ? `${handle}x` : handle,
              digest:
                mode === 'bad-digest'
                  ? '0'.repeat(64)
                  : createHash('sha256').update(handle).digest('hex'),
            };
      send({ id: request.id, ok: true, result: { nativeHandle, state: 'idle', turnId: null } });
    } else if (request.op === 'close') {
      send({
        id: request.id,
        ok: true,
        result: { state: 'closed', nativeHandle: { state: 'pending' } },
      });
      if (mode !== 'stuck-close') process.exit(0);
    } else if (request.op === 'interrupt') {
      if (mode === 'interrupt-silent') {
        newline = buffer.indexOf('\n');
        continue;
      }
      if (mode === 'interrupt-negative') {
        send({ id: request.id, ok: false, error: { code: 'invalid_state', message: 'bad' } });
        newline = buffer.indexOf('\n');
        continue;
      }
      const values = {
        array: ['not_active'],
        object: {},
        null: null,
        number: 1,
        unknown: 'future-result',
      };
      // The completed-Turn vocabulary oracle requires terminal-before-reply ordering.
      if (mode === 'bad-interrupt')
        send({
          event: 'turn_settled',
          turnId: request.turnId,
          outcome: { status: 'failed', reason: 'pi-prompt-failed' },
          nativeHandle: { state: 'pending' },
          compactionEntryIds: [],
        });
      send({
        id: request.id,
        ok: true,
        result: {
          outcome: mode.startsWith('interrupt-')
            ? mode === 'interrupt-no-terminal'
              ? 'interrupted'
              : values[mode.replace('interrupt-after-', '').replace('interrupt-', '')]
            : mode === 'bad-interrupt'
              ? 'future-result'
              : 'not_active',
        },
      });
    }
    newline = buffer.indexOf('\n');
  }
});

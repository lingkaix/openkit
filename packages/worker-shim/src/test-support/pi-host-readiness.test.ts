import { Duplex } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { waitForPiHostReadiness } from './pi-host-readiness.js';

/** A stable peer that records requests and emits only the frames a check supplies. */
function channel() {
  const requests: string[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      requests.push(String(chunk));
      callback();
    },
  });
  return { requests, stream };
}

afterEach(() => vi.useRealTimers());

it('proves a split closed refusal without opening a native session', async () => {
  const { requests, stream } = channel();
  const ready = waitForPiHostReadiness(stream);
  stream.emit('data', Buffer.from('{"id":0,"ok":false,"error":'));
  stream.emit('data', Buffer.from('{"code":"invalid_request","message":"invalid"}}\n'));
  await ready;
  expect(requests).toEqual(['{"id":0}\n']);
  expect(stream.listenerCount('data')).toBe(0);
});

it('rejects a response that accepts the deliberately invalid request', async () => {
  const { stream } = channel();
  const rejected = expect(waitForPiHostReadiness(stream)).rejects.toThrow(
    'did not prove its request listener'
  );
  stream.emit('data', Buffer.from('{"id":0,"ok":true,"result":{}}\n'));
  await rejected;
});

it('times out when unrelated replies cannot prove request-listener readiness', async () => {
  vi.useFakeTimers();
  const { stream } = channel();
  const rejected = expect(waitForPiHostReadiness(stream)).rejects.toThrow(
    'module loading timed out'
  );
  stream.emit('data', Buffer.from('{"id":1,"ok":true,"result":{}}\n'));
  await vi.advanceTimersByTimeAsync(120_000);
  await rejected;
  expect(stream.listenerCount('data')).toBe(0);
});

it('fails when the child closes before responding', async () => {
  const { stream } = channel();
  const rejected = expect(waitForPiHostReadiness(stream)).rejects.toThrow(
    'closed before readiness'
  );
  stream.emit('close');
  await rejected;
});

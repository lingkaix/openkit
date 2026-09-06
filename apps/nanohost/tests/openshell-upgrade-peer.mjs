import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http2 from 'node:http2';
import net from 'node:net';

const REQUEST_BYTES = 512 * 1024;
const RESPONSE_BYTES = 4 * 1024 * 1024;
const PAUSE_MS = 3000;
const CHUNKS = [1, 7, 63, 1024, 65535, 3, 8192];

function bytes(length, multiplier, addend) {
  const value = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    value[index] = (index * multiplier + addend) % 251;
  }
  return value;
}

let settled = false;
let activeSession;
let activeSocket;
const deadline = setTimeout(() => finish(false, activeSession, activeSocket), 20_000);

function finish(ok, session, socket) {
  if (settled) return;
  settled = true;
  clearTimeout(deadline);
  session?.close();
  socket?.destroy();
  const done = () => {
    process.stdout.write(ok ? 'EXIT 0\n' : 'ERROR\n');
    process.exitCode = ok ? 0 : 1;
  };
  if (server.listening) server.close(done);
  else done();
}

const server = net.createServer(async (socket) => {
  const session = http2.connect('http://sandbox-integration:80', {
    createConnection: () => socket,
  });
  activeSession = session;
  activeSocket = socket;
  const request = session.request({
    ':method': 'POST',
    ':scheme': 'http',
    ':authority': 'sandbox-integration:80',
    ':path': '/inference/openshell-upgrade-probe',
  });
  const hash = createHash('sha256');
  let received = 0;
  let slow = false;

  request.on('response', (headers) => {
    if (headers[':status'] !== 200) return finish(false, session, socket);
    request.pause();
    process.stdout.write('PAUSED\n');
    setTimeout(() => {
      slow = true;
      request.resume();
    }, PAUSE_MS);
  });
  request.on('data', (chunk) => {
    received += chunk.length;
    hash.update(chunk);
    if (slow) {
      request.pause();
      setTimeout(() => request.resume(), 1);
    }
  });
  request.on('end', () => {
    process.stdout.write(`RESULT ${received} ${hash.digest('hex')}\n`);
    finish(received === RESPONSE_BYTES, session, socket);
  });
  request.on('error', () => finish(false, session, socket));
  session.on('error', () => finish(false, session, socket));

  try {
    const body = bytes(REQUEST_BYTES, 31, 7);
    for (let offset = 0, chunk = 0; offset < body.length; chunk += 1) {
      const end = Math.min(offset + CHUNKS[chunk % CHUNKS.length], body.length);
      if (!request.write(body.subarray(offset, end))) await once(request, 'drain');
      offset = end;
    }
    request.end();
  } catch {
    finish(false, session, socket);
  }
});

server.on('error', () => finish(false));
server.listen(17891, '127.0.0.1', () => process.stdout.write('READY\n'));

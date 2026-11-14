import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { chmod } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateTree, removePrivateTree } from '@openkit/storage';
import { WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES } from '@openkit/worker-protocol';
import { handleSshAgentFrame, type SshAgentCallbacks } from './credential-ssh-agent.js';

/** One session-owned native socket, never a key store or an independent credential authority. */
export interface CredentialAgentSocket {
  readonly path: string;
  close(): Promise<void>;
}

/** One fixed-size framing buffer per connection; requests on that connection remain serial. */
async function serve(socket: Socket, callbacks: SshAgentCallbacks): Promise<void> {
  const frame = Buffer.allocUnsafe(WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES + 4);
  let length = 0;
  let target = 4;
  for await (const chunk of socket) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = Math.min(target - length, bytes.byteLength - offset);
      frame.set(bytes.subarray(offset, offset + count), length);
      offset += count;
      length += count;
      if (length !== target) continue;
      if (target === 4) {
        const payload = frame.readUInt32BE(0);
        if (payload < 1 || payload > WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES) {
          await new Promise<void>((resolve, reject) => {
            socket.write(Buffer.from([0, 0, 0, 1, 5]), (error) =>
              error ? reject(error) : resolve()
            );
          });
          return;
        }
        target = payload + 4;
        continue;
      }
      const reply = await handleSshAgentFrame(Buffer.from(frame.subarray(0, target)), callbacks);
      if (socket.destroyed) return;
      await new Promise<void>((resolve, reject) => {
        socket.write(reply, (error) => (error ? reject(error) : resolve()));
      });
      length = 0;
      target = 4;
    }
  }
}

/** Open a short, private UNIX address; no material/key is written beside it. */
export async function openCredentialAgent(
  callbacks: SshAgentCallbacks
): Promise<CredentialAgentSocket> {
  const root = await createPrivateTree(tmpdir(), 'openkit-agent-');
  const path = join(root, 'a');
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    void serve(socket, callbacks)
      .catch(() => undefined)
      .finally(() => socket.destroy());
  });
  // About one MiB of frame buffers, with ordinary stream backpressure behind each.
  server.maxConnections = 16;
  try {
    await chmod(root, 0o700);
    server.listen(path);
    await once(server, 'listening');
    await chmod(path, 0o600);
  } catch {
    for (const socket of sockets) socket.destroy();
    server.close();
    await removePrivateTree(root);
    throw new Error('Credential agent unavailable.');
  }
  let closing: Promise<void> | undefined;
  return {
    path,
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await removePrivateTree(root);
      })();
      return closing;
    },
  };
}

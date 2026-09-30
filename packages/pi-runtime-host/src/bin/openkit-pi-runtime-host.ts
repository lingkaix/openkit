#!/usr/bin/env node
import { Socket } from 'node:net';
import { CHANNEL_FRAME_MAX_BYTES, createLineReader, encodeFrame } from '../channel.ts';
import { PiRuntimeHost } from '../host.ts';

/*
 * The Harness starts this process with its private channel as file descriptor 3 and no
 * arguments. Offline mode keeps the SDK from checking versions, refreshing catalogs, or
 * installing packages over the network; telemetry stays off.
 */
process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
process.env.PI_TELEMETRY = '0';

if (process.argv.length > 2) {
  console.error('Pi runtime host accepts no arguments.');
  process.exit(64);
}

const channel = new Socket({ fd: 3, readable: true, writable: true });
let exiting = false;
const exit = (code: number) => {
  if (exiting) return;
  exiting = true;
  channel.end(() => process.exit(code));
  setTimeout(() => process.exit(code), 1000).unref();
};
const host = new PiRuntimeHost({
  onClosed: () => exit(0),
  send: (frame) => {
    let line: string;
    try {
      line = encodeFrame(frame, host.secrets());
    } catch {
      line = encodeFrame(
        'id' in frame
          ? {
              error: { code: 'invalid_state', message: 'Response exceeded its bound.' },
              id: frame.id,
              ok: false,
            }
          : {
              event: 'extension_error',
              message: `Event exceeded ${CHANNEL_FRAME_MAX_BYTES} bytes.`,
            },
        host.secrets()
      );
    }
    channel.write(line);
  },
});
const abandon = () => {
  void host.abandon().finally(() => exit(1));
};
channel.on(
  'data',
  createLineReader(
    (line) => {
      void host.receive(line);
    },
    () =>
      channel.write(
        encodeFrame(
          {
            error: { code: 'invalid_request', message: 'Request exceeded its bound.' },
            id: null,
            ok: false,
          },
          host.secrets()
        )
      )
  )
);
channel.on('end', abandon);
channel.on('error', abandon);
process.on('SIGTERM', abandon);

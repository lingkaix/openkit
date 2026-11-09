/** Keeps the load fixture's outside MCP peer independent of Core's event loop (#445). */
import { createMcpHttpStub } from './mcp-http-stub.js';

const peer = await createMcpHttpStub();
let closing: Promise<void> | undefined;
const close = () => {
  closing ??= peer.close().finally(() => {
    if (process.connected) process.disconnect?.();
  });
  return closing;
};
process.on('message', (message) => {
  if (message === 'close') void close();
});
process.on('disconnect', () => void close());
process.send?.({ url: peer.url });

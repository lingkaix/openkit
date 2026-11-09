// openkit-test-platform: posix
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { createLoadMcpPeer } from './load-mcp-peer.js';

it('keeps the outside MCP peer responsive while Core blocks beyond keep-alive expiry', async () => {
  const peer = await createLoadMcpPeer();
  const client = new Client({ name: 'load-peer-isolation', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(peer.url));
  try {
    expect(peer.pid).not.toBe(process.pid);
    await client.connect(transport);
    await client.callTool({ name: 'echo', arguments: { message: 'safe' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The old in-process peer resets DELETE after this exact idle-then-block sequence.
    const stop = performance.now() + 7_000;
    while (performance.now() < stop) {
      /* Exercise the synchronous verifier's event-loop boundary. */
    }
    await expect(transport.terminateSession()).resolves.toBeUndefined();
  } finally {
    await client.close();
    await peer.close();
  }
  expect(() => process.kill(peer.pid, 0)).toThrow();
}, 30_000);

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OpenKitMcpGate } from './capability-mcp.ts';

/** Exercises the native message hook and Pi's binary resource conversion together. */
describe('OpenKit MCP binary resource redaction', () => {
  it.each([
    ['credential', true, 'ff00805b72656461637465645dfe01'],
    ['no credential', false, 'ff0080fe01'],
  ])('preserves exact binary bytes with %s', async (_case, includeCredential, expected) => {
    const credential = 'a'.repeat(43);
    let receive: (message: unknown) => void = () => {};
    const transport = {
      close: async () => {},
      onError: () => {},
      onMessage: (listener: (message: unknown) => void) => {
        receive = listener;
      },
      send: async () => {},
    };
    const gate = new OpenKitMcpGate({
      managed: [
        {
          name: 'openkit-work',
          config: { url: 'http://127.0.0.1/mcp/openkit-work' },
          scope: 'extension',
          source: 'OpenKit',
        },
      ],
      agentDir: '/tmp/agent',
      createDefaultTransport: (() => transport) as never,
      cwd: '/tmp/work',
      loadMcpConfig: (() => ({ servers: [] })) as never,
      secrets: [credential],
    });
    const wrapped = gate.createTransport(
      { name: 'openkit-work' } as never,
      '/tmp/work',
      undefined as never
    );
    let delivered: unknown;
    wrapped.onMessage((message) => {
      delivered = message;
    });
    const bytes = Buffer.concat([
      Buffer.from('ff0080', 'hex'),
      ...(includeCredential ? [Buffer.from(credential)] : []),
      Buffer.from('fe01', 'hex'),
    ]);
    receive({
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'test://binary.bin',
            mimeType: 'application/octet-stream',
            blob: bytes.toString('base64'),
          },
        },
      ],
    });
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const tools = await import(pathToFileURL(join(dirname(entry), 'extensions/mcp/tools.js')).href);
    let saved: Buffer | undefined;
    await tools.convertMcpResult('openkit-work', 'echo', delivered, {
      saveOutput: async (data: Buffer) => {
        saved = data;
        return '/tmp/binary.bin';
      },
    });
    expect(saved?.toString('hex')).toBe(expected);
  });
});

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'openkit-stdio-stub', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

if (process.env.OPENKIT_MCP_STDERR_FLOOD) {
  process.stderr.write('private-stderr-canary'.repeat(16 * 1024));
}
if (process.env.OPENKIT_MCP_SERVER_PID_FILE) {
  writeFileSync(process.env.OPENKIT_MCP_SERVER_PID_FILE, String(process.pid));
}
if (process.env.OPENKIT_MCP_IGNORE_STDIN_EXIT) setInterval(() => undefined, 1_000);
if (process.env.OPENKIT_MCP_INIT_HANG) {
  await new Promise(() => undefined);
}
if (process.env.OPENKIT_MCP_DESCENDANT_PID_FILE) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const fs=require('node:fs');const{createHash}=require('node:crypto');const path=process.env.OPENKIT_MCP_DESCENDANT_PID_FILE;process.on('SIGTERM',()=>{});fs.writeFileSync(path+'.partial',JSON.stringify({pid:process.pid,credentialDigest:createHash('sha256').update(process.env.OPENKIT_MCP_DESCENDANT_SECRET??'').digest('hex')}));fs.renameSync(path+'.partial',path);setInterval(()=>{},1000)",
    ],
    { env: process.env, stdio: 'ignore' }
  );
  if (!child.pid) throw new Error('MCP descendant fixture did not start.');
  const deadline = Date.now() + 2_000;
  while (!existsSync(process.env.OPENKIT_MCP_DESCENDANT_PID_FILE)) {
    if (Date.now() >= deadline) throw new Error('MCP descendant receipt was not published.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
if (process.env.OPENKIT_MCP_INIT_EXIT) process.exit(77);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes one message.',
      inputSchema: {
        additionalProperties: false,
        properties: { message: { type: 'string' } },
        required: ['message'],
        type: 'object',
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const message = request.params.arguments?.message ?? null;
  if (process.argv[2]) appendFileSync(process.argv[2], `${String(message)}\n`);
  if (message === 'crash') process.exit(77);
  if (message === 'timeout') await new Promise(() => undefined);
  const delayMs = Number(process.env.OPENKIT_MCP_CALL_DELAY_MS ?? (message === 'delay' ? 200 : 0));
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (message === 'tool-error') {
    return { content: [{ type: 'text', text: 'tool failed' }], isError: true };
  }
  const text = message === 'oversize' ? 'x'.repeat(512 * 1024) : String(message ?? '');
  return {
    content: [{ type: 'text', text }],
    structuredContent: { message, pid: process.pid },
  };
});

await server.connect(new StdioServerTransport());

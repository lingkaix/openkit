import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// Recorded external peer only. Each tools/call appends its exact effect bytes.
serveStdio(
  () => {
    const server = new Server(
      { name: 'recorded-issues', version: '1' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler('tools/list', () => ({
      tools: ['issue_create', 'create_pull_request'].map((name) => ({
        name,
        description: 'Record an exact proposed write without external contact.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { title: { type: 'string' }, body: { type: 'string' } },
          required: ['title', 'body'],
        },
      })),
    }));
    server.setRequestHandler('tools/call', (request) => {
      appendFileSync(process.argv[2], `${JSON.stringify(request.params)}\n`);
      return server.projectCallToolResult(
        { content: [{ type: 'text', text: 'Recorded issue effect.' }] },
        undefined
      );
    });
    return server;
  },
  { legacy: 'serve' }
);

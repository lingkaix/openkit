import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';

/** One captured chat-completions request. */
export interface CapturedInference {
  readonly body: {
    readonly messages: readonly { readonly content: unknown; readonly role: string }[];
    readonly model: string;
    readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
  } & Record<string, unknown>;
  readonly headers: IncomingHttpHeaders;
  readonly path: string;
}

/** Scripted reply to one request. */
export type InferenceReply =
  | { readonly finish?: string; readonly text: string }
  | { readonly toolCall: { readonly arguments: unknown; readonly name: string } }
  | { readonly status: number; readonly body?: string }
  | { readonly hang: true };

/** Running synthetic OpenAI-compatible inference endpoint. */
export interface SyntheticInference {
  /** Hung responses whose socket closed, including a client abort. */
  readonly aborted: number;
  close(): Promise<void>;
  readonly requests: CapturedInference[];
  /** Base URL the adapter writes as the inference base. */
  readonly url: string;
}

/**
 * Starts a local chat-completions server that streams one scripted reply per request.
 *
 * @param reply Chooses the reply for the n-th request, counting from 1.
 * @returns The running server and its captured requests.
 */
export async function startSyntheticInference(
  reply: (request: CapturedInference, n: number) => InferenceReply
): Promise<SyntheticInference> {
  const requests: CapturedInference[] = [];
  const open = new Set<ServerResponse>();
  const aborted = { count: 0 };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const captured: CapturedInference = {
      body: text ? (JSON.parse(text) as CapturedInference['body']) : { messages: [], model: '' },
      headers: req.headers,
      path: req.url ?? '',
    };
    requests.push(captured);
    const script = reply(captured, requests.length);
    if ('status' in script) {
      res.writeHead(script.status, { 'content-type': 'application/json' });
      res.end(script.body ?? JSON.stringify({ error: { message: 'synthetic failure' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = {
      created: 1,
      id: `c${requests.length}`,
      model: captured.body.model,
      object: 'chat.completion.chunk',
      openkitUnknown: true,
    };
    const write = (choice: unknown) => {
      res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
    };
    if ('hang' in script) {
      write({ delta: { content: 'partial', role: 'assistant' }, index: 0 });
      open.add(res);
      res.on('close', () => {
        aborted.count += 1;
        open.delete(res);
      });
      return;
    }
    if ('toolCall' in script) {
      write({
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify(script.toolCall.arguments),
                name: script.toolCall.name,
              },
              id: `call_${requests.length}`,
              index: 0,
              type: 'function',
            },
          ],
        },
        index: 0,
      });
      write({ delta: {}, finish_reason: 'tool_calls', index: 0 });
    } else {
      const size = 32 * 1024;
      for (let offset = 0; offset < script.text.length; offset += size) {
        write({
          delta: {
            content: script.text.slice(offset, offset + size),
            ...(offset === 0 ? { role: 'assistant' } : {}),
          },
          index: 0,
        });
      }
      write({ delta: {}, finish_reason: script.finish ?? 'stop', index: 0 });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    get aborted() {
      return aborted.count;
    },
    close: async () => {
      for (const response of open) response.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    requests,
    url: `http://127.0.0.1:${port}/inference/v1`,
  };
}

/**
 * Returns the text of every message of one captured request, in order.
 *
 * @param request Captured request.
 * @returns Text content, one entry per message.
 */
export function requestTexts(request: CapturedInference): string[] {
  return request.body.messages.map((message) =>
    typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((part: { text?: unknown }) => (typeof part.text === 'string' ? part.text : ''))
            .join('')
        : ''
  );
}

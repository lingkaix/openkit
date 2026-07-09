import { describe, expect, it } from 'vitest';

import { QUICK_CHAT_AGENT_DEFINITION } from './quick-chat.js';
import { createInternalCoreToolRegistry } from './tools.js';
import { createWebRetrievalToolHandlers } from './web-retrieval.js';

const PUBLIC_TEST_ADDRESS = '93.184.216.34';

/**
 * Resolves every hostname to a public documentation address for hermetic tests.
 *
 * @returns Public test address list.
 */
async function resolvePublicHostname(): Promise<readonly string[]> {
  return [PUBLIC_TEST_ADDRESS];
}

/**
 * Creates a promise that never resolves for resolver timeout tests.
 *
 * @returns Pending promise.
 */
function neverResolve<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Intentionally pending.
  });
}

/**
 * Bounds a test expectation so a missing production timeout fails quickly.
 *
 * @param task Task that should reject before the test guard.
 * @returns Task result when it completes before the guard.
 */
async function expectBeforeTestTimeout<T>(task: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('test timed out waiting for web retrieval timeout')),
          100
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

describe('internal agent web retrieval tools', () => {
  it('keeps quick-chat web retrieval disabled unless explicitly enabled', async () => {
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({ enabled: false }),
    });

    await expect(
      registry.execute({
        agent: QUICK_CHAT_AGENT_DEFINITION,
        input: { query: 'current release notes' },
        toolId: 'webSearch',
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'internal_web_retrieval_disabled',
    });
  });

  it('rejects non-http URLs before fetching page text', async () => {
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({ enabled: true }),
    });

    await expect(
      registry.execute({
        agent: QUICK_CHAT_AGENT_DEFINITION,
        input: { url: 'file:///Users/example/private.txt' },
        toolId: 'fetchPageText',
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'internal_web_retrieval_invalid_url',
    });
  });

  it.each([
    'http://127.0.0.1/status',
    'http://localhost/status',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.7/private',
    'http://172.16.0.7/private',
    'http://192.168.1.7/private',
    'http://[::1]/status',
    'http://[fd00::1]/private',
    'http://[::ffff:7f00:1]/private',
    'http://[::ffff:127.0.0.1]/private',
    'http://[fe90::1]/private',
  ])('rejects private or local page retrieval URL %s', async (url) => {
    const seenRequests: Request[] = [];
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({
        enabled: true,
        fetch: async (request) => {
          seenRequests.push(request);
          return new Response('private data', {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          });
        },
      }),
    });

    await expect(
      registry.execute({
        agent: QUICK_CHAT_AGENT_DEFINITION,
        input: { url },
        toolId: 'fetchPageText',
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'internal_web_retrieval_invalid_url',
    });
    expect(seenRequests).toHaveLength(0);
  });

  it('rejects redirects from public URLs to private URLs before reading response bodies', async () => {
    const seenRequests: Request[] = [];
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({
        enabled: true,
        resolveHostname: resolvePublicHostname,
        fetch: async (request) => {
          seenRequests.push(request);

          if (request.url === 'https://example.com/redirect') {
            return new Response('', {
              headers: { location: 'http://127.0.0.1/private' },
              status: 302,
            });
          }

          return new Response('private data', {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          });
        },
      }),
    });

    await expect(
      registry.execute({
        agent: QUICK_CHAT_AGENT_DEFINITION,
        input: { url: 'https://example.com/redirect' },
        toolId: 'fetchPageText',
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'internal_web_retrieval_invalid_url',
    });
    expect(seenRequests.map((request) => request.url)).toEqual(['https://example.com/redirect']);
  });

  it.each([
    ['127.0.0.1'],
    ['10.0.0.7'],
    ['::1'],
    ['fe90::1'],
  ])('rejects DNS hostnames that resolve to private address %s', async (address) => {
    const seenRequests: Request[] = [];
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({
        enabled: true,
        resolveHostname: async () => [address],
        fetch: async (request) => {
          seenRequests.push(request);
          return new Response('private data', {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          });
        },
      }),
    });

    await expect(
      registry.execute({
        agent: QUICK_CHAT_AGENT_DEFINITION,
        input: { url: 'https://private.example/page' },
        toolId: 'fetchPageText',
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'internal_web_retrieval_invalid_url',
    });
    expect(seenRequests).toHaveLength(0);
  });

  it('allows DNS hostnames that resolve only to public addresses', async () => {
    const seenHostnames: string[] = [];
    const seenRequests: Request[] = [];
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({
        enabled: true,
        resolveHostname: async (hostname) => {
          seenHostnames.push(hostname);
          return [PUBLIC_TEST_ADDRESS];
        },
        fetch: async (request) => {
          seenRequests.push(request);
          return new Response('public data', {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          });
        },
      }),
    });

    const result = await registry.execute({
      agent: QUICK_CHAT_AGENT_DEFINITION,
      input: { url: 'https://example.com/page' },
      toolId: 'fetchPageText',
      workspaceId: 'ws_demo',
    });

    expect(seenHostnames).toEqual(['example.com']);
    expect(seenRequests.map((request) => request.url)).toEqual(['https://example.com/page']);
    expect(JSON.stringify(result.output)).toContain('public data');
  });

  it('times out DNS resolution before fetching the initial URL', async () => {
    const seenRequests: Request[] = [];
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({
        enabled: true,
        timeoutMs: 5,
        resolveHostname: async () => neverResolve<readonly string[]>(),
        fetch: async (request) => {
          seenRequests.push(request);
          return new Response('public data', {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          });
        },
      }),
    });

    await expect(
      expectBeforeTestTimeout(
        registry.execute({
          agent: QUICK_CHAT_AGENT_DEFINITION,
          input: { url: 'https://example.com/page' },
          toolId: 'fetchPageText',
          workspaceId: 'ws_demo',
        })
      )
    ).rejects.toMatchObject({
      code: 'internal_web_retrieval_request_failed',
      message: 'Web retrieval timed out.',
    });
    expect(seenRequests).toHaveLength(0);
  });

  it('times out redirect target DNS resolution without fetching the target body', async () => {
    const seenRequests: Request[] = [];
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({
        enabled: true,
        timeoutMs: 10,
        resolveHostname: async (hostname) =>
          hostname === 'slow.example' ? neverResolve<readonly string[]>() : [PUBLIC_TEST_ADDRESS],
        fetch: async (request) => {
          seenRequests.push(request);

          if (request.url === 'https://example.com/redirect') {
            return new Response('', {
              headers: { location: 'https://slow.example/body' },
              status: 302,
            });
          }

          return new Response('redirect body', {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          });
        },
      }),
    });

    await expect(
      expectBeforeTestTimeout(
        registry.execute({
          agent: QUICK_CHAT_AGENT_DEFINITION,
          input: { url: 'https://example.com/redirect' },
          toolId: 'fetchPageText',
          workspaceId: 'ws_demo',
        })
      )
    ).rejects.toMatchObject({
      code: 'internal_web_retrieval_request_failed',
      message: 'Web retrieval timed out.',
    });
    expect(seenRequests.map((request) => request.url)).toEqual(['https://example.com/redirect']);
  });

  it('rejects redirects to DNS hostnames that resolve to private addresses', async () => {
    const seenRequests: Request[] = [];
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({
        enabled: true,
        resolveHostname: async (hostname) =>
          hostname === 'private.example' ? ['127.0.0.1'] : [PUBLIC_TEST_ADDRESS],
        fetch: async (request) => {
          seenRequests.push(request);

          if (request.url === 'https://example.com/redirect') {
            return new Response('', {
              headers: { location: 'https://private.example/secret' },
              status: 302,
            });
          }

          return new Response('private data', {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          });
        },
      }),
    });

    await expect(
      registry.execute({
        agent: QUICK_CHAT_AGENT_DEFINITION,
        input: { url: 'https://example.com/redirect' },
        toolId: 'fetchPageText',
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'internal_web_retrieval_invalid_url',
    });
    expect(seenRequests.map((request) => request.url)).toEqual(['https://example.com/redirect']);
  });

  it('uses credential-free GET requests and enforces response-size limits', async () => {
    const seenRequests: Request[] = [];
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({
        enabled: true,
        resolveHostname: resolvePublicHostname,
        fetch: async (request) => {
          seenRequests.push(request);

          return new Response('x'.repeat(64), {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          });
        },
        maxResponseBytes: 16,
      }),
    });

    await expect(
      registry.execute({
        agent: QUICK_CHAT_AGENT_DEFINITION,
        input: { url: 'https://example.com/page' },
        toolId: 'fetchPageText',
        workspaceId: 'ws_demo',
      })
    ).rejects.toMatchObject({
      code: 'internal_web_retrieval_limit_exceeded',
    });
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.method).toBe('GET');
    expect(seenRequests[0]?.credentials).toBe('omit');
    expect(seenRequests[0]?.headers.get('authorization')).toBeNull();
    expect(seenRequests[0]?.headers.get('cookie')).toBeNull();
  });

  it('records source URLs for bounded web search results', async () => {
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({
        enabled: true,
        resolveHostname: resolvePublicHostname,
        fetch: async () =>
          new Response(
            '<html><body><a href="https://example.com/a">Alpha result</a><a href="https://example.com/b">Beta result</a></body></html>',
            {
              headers: { 'content-type': 'text/html' },
              status: 200,
            }
          ),
      }),
    });

    const result = await registry.execute({
      agent: QUICK_CHAT_AGENT_DEFINITION,
      input: { limit: 2, query: 'alpha beta' },
      toolId: 'webSearch',
      workspaceId: 'ws_demo',
    });

    expect(result.output).toMatchObject({
      query: 'alpha beta',
      sources: [
        { title: 'Alpha result', url: 'https://example.com/a' },
        { title: 'Beta result', url: 'https://example.com/b' },
      ],
    });
  });

  it('returns source URL and bounded text for fetched pages', async () => {
    const registry = createInternalCoreToolRegistry({
      handlers: createWebRetrievalToolHandlers({
        enabled: true,
        resolveHostname: resolvePublicHostname,
        fetch: async () =>
          new Response(
            '<html><head><title>Page Title</title></head><body><main>Hello world</main></body></html>',
            {
              headers: { 'content-type': 'text/html' },
              status: 200,
            }
          ),
      }),
    });

    const result = await registry.execute({
      agent: QUICK_CHAT_AGENT_DEFINITION,
      input: { url: 'https://example.com/page' },
      toolId: 'fetchPageText',
      workspaceId: 'ws_demo',
    });

    expect(result.output).toMatchObject({
      sourceUrl: 'https://example.com/page',
      sources: [{ title: 'Page Title', url: 'https://example.com/page' }],
      title: 'Page Title',
    });
    expect(JSON.stringify(result.output)).toContain('Hello world');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { renderServiceWorkerSource, shellPrecacheUrls } from './render-sw';
import { isBypassedRequest, isShellCacheUrl, mayActivateWaitingWorker } from './worker-policy';

/**
 * P1 worker policy behavior (design.md "Installable app" + review amendment A5).
 *
 * These checks pin the worker's public policy seams before the worker exists.
 * They describe which requests the worker may answer, how navigation resolves,
 * when a waiting worker may activate, and which cache keys are build-shell keys
 * that survive logout.
 */

const ORIGIN = window.location.origin;

/**
 * Resolves a same-origin path to an absolute URL string.
 *
 * @param path Absolute path on the current origin.
 * @returns The absolute URL.
 */
function sameOrigin(path: string): string {
  return new URL(path, ORIGIN).href;
}

describe('worker request bypass policy', () => {
  it('never answers API or operation requests', () => {
    expect(
      isBypassedRequest({
        url: sameOrigin('/api/threads'),
        mode: 'cors',
        destination: '',
        headers: new Headers(),
      })
    ).toBe(true);
    expect(
      isBypassedRequest({
        url: sameOrigin('/v1/responses'),
        mode: 'cors',
        destination: '',
        headers: new Headers(),
      })
    ).toBe(true);
  });

  it('never answers WebSocket or EventSource requests', () => {
    expect(
      isBypassedRequest({
        url: sameOrigin('/events'),
        mode: 'websocket',
        destination: 'websocket',
        headers: new Headers(),
      })
    ).toBe(true);
    expect(
      isBypassedRequest({
        url: sameOrigin('/threads/stream'),
        mode: 'cors',
        destination: '',
        headers: new Headers({ Accept: 'text/event-stream' }),
      })
    ).toBe(true);
  });

  it('lets navigation and hashed assets use the shell path', () => {
    expect(
      isBypassedRequest({
        url: sameOrigin('/'),
        mode: 'navigate',
        destination: 'document',
        headers: new Headers({ Accept: 'text/html' }),
      })
    ).toBe(false);
    expect(
      isBypassedRequest({
        url: sameOrigin('/assets/index-8fK2d9.js'),
        mode: 'cors',
        destination: 'script',
        headers: new Headers(),
      })
    ).toBe(false);
  });
});

describe('waiting worker activation policy', () => {
  it('activates only after acceptance with no unsent draft', () => {
    expect(mayActivateWaitingWorker({ updateAccepted: true, hasUnsentDraft: false })).toBe(true);
  });

  it('never activates without acceptance', () => {
    expect(mayActivateWaitingWorker({ updateAccepted: false, hasUnsentDraft: false })).toBe(false);
  });

  it('never activates while an unsent draft exists', () => {
    expect(mayActivateWaitingWorker({ updateAccepted: true, hasUnsentDraft: true })).toBe(false);
    expect(mayActivateWaitingWorker({ updateAccepted: false, hasUnsentDraft: true })).toBe(false);
  });
});

describe('shell cache keys', () => {
  it('keeps same-origin build-shell URLs', () => {
    for (const path of [
      '/',
      '/index.html',
      '/sw.js',
      '/manifest.webmanifest',
      '/favicon.ico',
      '/favicon.svg',
      '/apple-touch-icon.png',
      '/brand/openkit-mark-512.png',
      '/assets/index-8fK2d9.js',
      '/assets/index-4a1c.css',
    ]) {
      expect(isShellCacheUrl(sameOrigin(path)), path).toBe(true);
    }
  });

  it('rejects API, operation, cross-origin, and authenticated URLs', () => {
    expect(isShellCacheUrl(sameOrigin('/api/threads'))).toBe(false);
    expect(isShellCacheUrl(sameOrigin('/v1/responses'))).toBe(false);
    expect(isShellCacheUrl(`${sameOrigin('/assets/index-8fK2d9.js')}?token=abc`)).toBe(false);
    expect(isShellCacheUrl(`${sameOrigin('/index.html')}?authorization=Bearer%20abc`)).toBe(false);
    expect(isShellCacheUrl('https://user:pass@openkit.example/assets/index-8fK2d9.js')).toBe(false);
    expect(isShellCacheUrl('https://elsewhere.example/assets/index-8fK2d9.js')).toBe(false);
  });

  it('keeps every shell key and drops every other key on logout', () => {
    const mixed = [
      sameOrigin('/'),
      sameOrigin('/api/threads'),
      sameOrigin('/index.html'),
      `${sameOrigin('/assets/index-8fK2d9.js')}?token=abc`,
      sameOrigin('/v1/responses'),
      sameOrigin('/assets/index-4a1c.css'),
      sameOrigin('/manifest.webmanifest'),
      'https://elsewhere.example/assets/index-8fK2d9.js',
    ];

    expect(mixed.filter(isShellCacheUrl)).toEqual([
      sameOrigin('/'),
      sameOrigin('/index.html'),
      sameOrigin('/assets/index-4a1c.css'),
      sameOrigin('/manifest.webmanifest'),
    ]);
  });
});

interface ShellResponse {
  type: 'basic';
  ok: boolean;
  redirected: boolean;
  headers: { get(name: string): string | null };
  clone(): ShellResponse;
}

interface WorkerListenerEvent {
  request?: {
    url: string;
    mode: string;
    destination: string;
    headers: { get(name: string): string | null };
  };
  waitUntil?: (done: Promise<unknown>) => void;
  respondWith?: (done: Promise<unknown>) => void;
}

interface LoadedWorker {
  listeners: Map<string, Array<(event: WorkerListenerEvent) => void>>;
  fetchMock: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  clients: { matchAll: ReturnType<typeof vi.fn>; claim: ReturnType<typeof vi.fn> };
  skipWaiting: ReturnType<typeof vi.fn>;
}

/**
 * Header bag whose lookup matches the Fetch `Headers#get` name folding.
 *
 * @param values Lower-case header names.
 * @returns A `get` implementation.
 */
function headerBag(values: Record<string, string>): { get(name: string): string | null } {
  return {
    get(name: string) {
      return values[name.toLowerCase()] ?? null;
    },
  };
}

/**
 * Builds a basic same-origin response the worker is allowed to inspect.
 *
 * @param headers Response headers.
 * @returns A response object with `type: 'basic'`.
 */
function shellResponse(headers: Record<string, string> = {}): ShellResponse {
  const response: ShellResponse = {
    type: 'basic',
    ok: true,
    redirected: false,
    headers: headerBag(headers),
    clone() {
      return response;
    },
  };
  return response;
}

/**
 * Evaluates one generated worker against synthetic service-worker globals.
 *
 * @param precache URLs passed to the renderer. Non-shell URLs must be filtered out.
 * @returns Listeners and the fakes the worker calls.
 */
async function loadWorker(precache: readonly string[]): Promise<LoadedWorker> {
  const source = await renderServiceWorkerSource(precache);
  const listeners = new Map<string, Array<(event: WorkerListenerEvent) => void>>();
  const put = vi.fn(async () => undefined);
  const match = vi.fn(async () => undefined);
  const fetchMock = vi.fn();
  const clients = {
    matchAll: vi.fn(async () => []),
    claim: vi.fn(async () => undefined),
  };
  const skipWaiting = vi.fn(async () => undefined);
  const self = {
    addEventListener(type: string, listener: (event: WorkerListenerEvent) => void) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
    skipWaiting,
    clients,
  };
  const caches = {
    open: vi.fn(async () => ({
      put,
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
    })),
    match,
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
  const run = new Function('self', 'caches', 'fetch', source);
  run(self, caches, fetchMock);
  return { listeners, fetchMock, match, put, clients, skipWaiting };
}

/**
 * Runs one worker listener and returns the promise it handed to the event.
 *
 * @param worker Loaded worker.
 * @param type Listener name.
 * @param event Extra event fields.
 * @returns The `respondWith` or `waitUntil` promise, when the listener set one.
 */
async function dispatchWorker(
  worker: LoadedWorker,
  type: string,
  event: WorkerListenerEvent = {}
): Promise<unknown> {
  const listener = worker.listeners.get(type)?.[0];
  expect(listener, type).toBeTypeOf('function');
  let settled: Promise<unknown> | undefined;
  listener?.({
    ...event,
    respondWith(done) {
      settled = done;
    },
    waitUntil(done) {
      settled = done;
    },
  });
  return settled;
}

describe('rendered service worker', () => {
  const assetPath = '/assets/app-8fK2d9.js';

  /**
   * Same-origin request the asset fetch handler can answer.
   *
   * @param headers Request headers.
   * @returns A navigate-or-asset request record.
   */
  function assetRequest(headers: Record<string, string> = {}) {
    return {
      url: sameOrigin(assetPath),
      mode: 'cors',
      destination: 'script',
      headers: headerBag(headers),
    };
  }

  it('uses the network for navigation and falls back to the cached shell document', async () => {
    const worker = await loadWorker(shellPrecacheUrls([]));
    const live = shellResponse({ 'content-type': 'text/html' });
    const order: string[] = [];
    worker.fetchMock.mockImplementation(async () => {
      order.push('fetch');
      return live;
    });
    worker.match.mockImplementation(async (key: unknown) => {
      order.push(`match:${String(key)}`);
      return undefined;
    });
    const request = {
      url: sameOrigin('/knowledge'),
      mode: 'navigate',
      destination: 'document',
      headers: headerBag({ accept: 'text/html' }),
    };

    await expect(dispatchWorker(worker, 'fetch', { request })).resolves.toBe(live);
    expect(order).toEqual(['fetch']);

    const cached = shellResponse({ 'content-type': 'text/html' });
    order.length = 0;
    worker.fetchMock.mockImplementation(async () => {
      order.push('fetch');
      throw new Error('offline');
    });
    worker.match.mockImplementation(async (key: unknown) => {
      order.push(`match:${String(key)}`);
      return key === '/index.html' ? cached : undefined;
    });

    await expect(dispatchWorker(worker, 'fetch', { request })).resolves.toBe(cached);
    expect(order).toEqual(['fetch', 'match:/index.html']);
  });

  it.each([
    ['an authorization request header', { authorization: 'Bearer secret' }, {}],
    ['a no-store response', {}, { 'cache-control': 'no-store' }],
    ['a private response', {}, { 'cache-control': 'private, max-age=60' }],
    ['a set-cookie response', {}, { 'set-cookie': 'session=secret' }],
  ] as const)('does not cache a shell asset with %s', async (_label, requestHeaders, responseHeaders) => {
    const worker = await loadWorker(shellPrecacheUrls(['assets/app-8fK2d9.js']));
    const body = shellResponse({ 'content-type': 'text/javascript', ...responseHeaders });
    worker.fetchMock.mockResolvedValue(body);
    worker.match.mockResolvedValue(undefined);

    await expect(
      dispatchWorker(worker, 'fetch', { request: assetRequest(requestHeaders) })
    ).resolves.toBe(body);
    expect(worker.put).not.toHaveBeenCalled();
  });

  it('caches a basic hashed script after a cache miss', async () => {
    const worker = await loadWorker(shellPrecacheUrls(['assets/app-8fK2d9.js']));
    const body = shellResponse({ 'content-type': 'text/javascript' });
    worker.fetchMock.mockResolvedValue(body);
    worker.match.mockResolvedValue(undefined);

    await expect(dispatchWorker(worker, 'fetch', { request: assetRequest() })).resolves.toBe(body);
    expect(worker.put).toHaveBeenCalledTimes(1);
    expect(worker.put.mock.calls[0]?.[1]).toBe(body);
  });

  it('precaches the document and hashed assets, and skips waiting only with no open window', async () => {
    expect(shellPrecacheUrls(['assets/app-8fK2d9.js', 'assets/plain.js', 'api/threads'])).toEqual(
      expect.arrayContaining([
        '/',
        '/index.html',
        '/manifest.webmanifest',
        '/favicon.ico',
        '/favicon.svg',
        '/apple-touch-icon.png',
        '/brand/openkit-mark-192.png',
        '/brand/openkit-mark-512.png',
        '/assets/app-8fK2d9.js',
      ])
    );
    expect(shellPrecacheUrls(['assets/plain.js', 'api/threads'])).not.toContain('/assets/plain.js');
    expect(shellPrecacheUrls(['api/threads'])).not.toContain('/api/threads');

    const source = await renderServiceWorkerSource([
      '/index.html',
      '/api/threads',
      '/assets/app-8fK2d9.js',
      'https://elsewhere.example/assets/app-8fK2d9.js',
    ]);
    expect(source).toContain('"/index.html"');
    expect(source).toContain('"/assets/app-8fK2d9.js"');
    expect(source).not.toContain('/api/threads');
    expect(source).not.toContain('elsewhere.example');

    const occupied = await loadWorker(['/index.html', '/favicon.ico', '/api/threads']);
    occupied.fetchMock.mockImplementation(async (url: string) =>
      shellResponse({
        'content-type': url === '/favicon.ico' ? 'image/x-icon' : 'text/html',
        ...(url === '/favicon.ico' ? { 'cache-control': 'no-store' } : {}),
      })
    );
    occupied.clients.matchAll.mockResolvedValue([{ id: 'window-1' }]);
    await dispatchWorker(occupied, 'install');
    expect(occupied.clients.matchAll).toHaveBeenCalledWith({
      type: 'window',
      includeUncontrolled: true,
    });
    expect(occupied.skipWaiting).not.toHaveBeenCalled();
    expect(occupied.fetchMock).toHaveBeenCalledWith('/index.html', { cache: 'no-store' });
    expect(occupied.fetchMock).not.toHaveBeenCalledWith('/api/threads', expect.anything());
    const storedUrls = occupied.put.mock.calls.map((call) => call[0]);
    expect(storedUrls).toContain('/index.html');
    expect(storedUrls).not.toContain('/favicon.ico');

    const empty = await loadWorker(['/index.html']);
    empty.fetchMock.mockResolvedValue(shellResponse({ 'content-type': 'text/html' }));
    empty.clients.matchAll.mockResolvedValue([]);
    await dispatchWorker(empty, 'install');
    expect(empty.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

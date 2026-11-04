import {
  isBypassedRequest,
  isShellCacheUrl,
  mayActivateWaitingWorker,
  selfOrigin,
} from './worker-policy';

/**
 * Build-asset URLs the shell worker may precache.
 *
 * @param emittedFiles - Vite bundle file names, without a leading slash.
 * @returns Same-origin shell URLs, including the document and icons.
 */
export function shellPrecacheUrls(emittedFiles: readonly string[]): string[] {
  const urls = new Set<string>([
    '/',
    '/index.html',
    '/manifest.webmanifest',
    '/favicon.ico',
    '/favicon.svg',
    '/apple-touch-icon.png',
    '/brand/openkit-mark-192.png',
    '/brand/openkit-mark-512.png',
  ]);
  for (const file of emittedFiles) {
    const url = `/${file.replace(/^\/+/, '')}`;
    if (isShellCacheUrl(url)) urls.add(url);
  }
  return [...urls];
}

/**
 * Classic service-worker source. Decision functions are inlined from the policy module.
 *
 * Necessity: one policy module feeds both the tests and `sw.js`. Ablation: a second
 * hand-written worker would drift from the tested decisions. The Vite emit script
 * strips any TypeScript annotation left in `Function#toString` before writing `sw.js`.
 *
 * @param precache - Shell URLs to store at install.
 * @returns JavaScript source for `sw.js`.
 */
export async function renderServiceWorkerSource(precache: readonly string[]): Promise<string> {
  const allowed = precache.filter((url) => isShellCacheUrl(url));
  const source = `/* OpenKit static shell. Generated. Do not cache /api, /v1, or live streams. */
const PRECACHE = ${JSON.stringify(allowed)};
${isBypassedRequest.toString()}
${isShellCacheUrl.toString()}
${mayActivateWaitingWorker.toString()}
${selfOrigin.toString()}

function pathnameOf(url) {
  try {
    return new URL(url, selfOrigin()).pathname;
  } catch {
    return '';
  }
}

function mayStoreShellResponse(request, response) {
  if (!response || response.type !== 'basic' || !response.ok || response.redirected) return false;
  const authorization = request.headers && request.headers.get && request.headers.get('authorization');
  if (authorization) return false;
  const cacheControl = String(
    (response.headers && response.headers.get && response.headers.get('cache-control')) || '',
  ).toLowerCase();
  if (cacheControl.includes('no-store') || cacheControl.includes('private')) return false;
  if (response.headers && response.headers.get && response.headers.get('set-cookie')) return false;
  const type = String(
    (response.headers && response.headers.get && response.headers.get('content-type')) || '',
  ).toLowerCase();
  const path = pathnameOf(request.url);
  const staticShell =
    path === '/' ||
    path === '/index.html' ||
    path === '/sw.js' ||
    path === '/manifest.webmanifest' ||
    path === '/favicon.ico' ||
    path === '/favicon.svg' ||
    path === '/apple-touch-icon.png' ||
    path === '/brand/openkit-mark-192.png' ||
    path === '/brand/openkit-mark-512.png';
  if (type === '' && staticShell) return true;
  return (
    type.includes('text/html') ||
    type.includes('javascript') ||
    type.includes('text/css') ||
    type.includes('image/') ||
    type.includes('font/') ||
    type.includes('application/manifest+json') ||
    type.includes('application/wasm')
  );
}

function queryClientDraft(client) {
  return new Promise((resolve) => {
    try {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(true), 1000);
      channel.port1.onmessage = (reply) => {
        clearTimeout(timer);
        const body = reply && reply.data;
        resolve(Boolean(body && body.hasUnsentDraft));
      };
      client.postMessage({ type: 'DRAFT_QUERY' }, [channel.port2]);
    } catch {
      resolve(true);
    }
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open('openkit-shell');
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        const request = { url, headers: { get() { return null; } } };
        if (isShellCacheUrl(url) && mayStoreShellResponse(request, response)) {
          await cache.put(url, response);
        }
      } catch {
        // A failed shell fetch must not store an error page.
      }
    }));
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.length === 0) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== 'openkit-shell').map((key) => caches.delete(key)));
    const cache = await caches.open('openkit-shell');
    const requests = await cache.keys();
    await Promise.all(requests.filter((request) => {
      try {
        const path = new URL(request.url).pathname;
        return PRECACHE.indexOf(path) === -1 || !isShellCacheUrl(request.url);
      } catch {
        return true;
      }
    }).map((request) => cache.delete(request)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'ACCEPT_UPDATE') return;
  const done = (async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const drafts = await Promise.all(windows.map((client) => queryClientDraft(client)));
    const hasUnsentDraft = Boolean(data.hasUnsentDraft) || drafts.some(Boolean);
    if (!mayActivateWaitingWorker({ updateAccepted: true, hasUnsentDraft })) {
      if (event.source && event.source.postMessage) {
        event.source.postMessage({ type: 'UPDATE_REFUSED' });
      }
      return;
    }
    await self.skipWaiting();
  })();
  if (event.waitUntil) event.waitUntil(done);
});

self.addEventListener('fetch', (event) => {
  const accept = event.request.headers.get('accept') || '';
  if (isBypassedRequest({
    url: event.request.url,
    mode: event.request.mode,
    destination: event.request.destination,
    headers: { accept },
  })) {
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(event.request);
      } catch {
        const cached = await caches.match('/index.html');
        if (cached) return cached;
        throw new Error('Offline');
      }
    })());
    return;
  }
  const path = pathnameOf(event.request.url);
  if (!isShellCacheUrl(event.request.url) || PRECACHE.indexOf(path) === -1) return;
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (mayStoreShellResponse(event.request, response)) {
      const cache = await caches.open('openkit-shell');
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});
`;
  return source;
}

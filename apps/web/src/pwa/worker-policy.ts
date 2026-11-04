/**
 * Pure decisions for the static-shell service worker.
 *
 * The worker must not answer API, model, or live-stream requests, and it must
 * not activate an update over an unsent draft. Cache keys are build assets only.
 */

export interface BypassRequest {
  /** Absolute or path-only request URL. */
  url: string;
  /** Fetch `mode`, when the caller has one. */
  mode?: string;
  /** Request destination, including `websocket` when the browser sets it. */
  destination?: string;
  /** A `Headers` bag or a plain Accept field. Matching is case-insensitive. */
  headers?: Headers | { accept?: string };
}

/**
 * Origin used when the caller passes a relative URL.
 *
 * Kept inside the worker source as its own function. Callers in this module use it too.
 *
 * @returns The page origin in a browser, otherwise `http://localhost`.
 */
export function selfOrigin(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (origin && origin !== 'null') return origin;
  return 'http://localhost';
}

/**
 * True when the worker must not call `respondWith` for this request.
 *
 * @param request - URL, mode, destination, and the Accept header.
 * @returns Whether the browser should hit the network directly.
 */
export function isBypassedRequest(request: BypassRequest): boolean {
  let parsed: URL;
  try {
    parsed = new URL(request.url, selfOrigin());
  } catch {
    return true;
  }
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') return true;
  const path = parsed.pathname;
  if (path === '/api' || path.startsWith('/api/')) return true;
  if (path === '/v1' || path.startsWith('/v1/')) return true;
  if (request.destination === 'websocket') return true;
  const headerBag = request.headers as
    | { accept?: string; get?: (name: string) => string | null }
    | undefined;
  const accept =
    headerBag && typeof headerBag.get === 'function'
      ? (headerBag.get('accept') ?? '')
      : (headerBag?.accept ?? '');
  if (accept.toLowerCase().includes('text/event-stream')) return true;
  return false;
}

/**
 * Navigation uses the network, then the cached shell document only if that fetch throws.
 *
 * @returns The constant network-first policy.
 */
export function navigationUsesNetworkFirst(): true {
  return true;
}

/**
 * A waiting worker may call `skipWaiting` only after an explicit reload acceptance.
 *
 * @param input - Whether the person accepted the prompt, and whether a draft is unsent.
 * @returns Whether activation is allowed.
 */
export function mayActivateWaitingWorker(input: {
  updateAccepted: boolean;
  hasUnsentDraft: boolean;
}): boolean {
  return input.updateAccepted === true && input.hasUnsentDraft === false;
}

/**
 * True for a same-origin static shell URL, and false for API or credential-bearing URLs.
 *
 * @param url - Absolute or path-only cache key.
 * @returns Whether Cache Storage may retain this URL.
 */
export function isShellCacheUrl(url: string): boolean {
  let parsed: URL;
  const origin = selfOrigin();
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  if (parsed.username || parsed.password) return false;
  // Any query or fragment can carry a session. Build assets are bare paths.
  if (parsed.search !== '' || parsed.hash !== '') return false;
  const path = parsed.pathname;
  if (
    path === '/' ||
    path === '/index.html' ||
    path === '/sw.js' ||
    path === '/manifest.webmanifest' ||
    path === '/favicon.ico' ||
    path === '/favicon.svg' ||
    path === '/apple-touch-icon.png' ||
    path === '/brand/openkit-mark-192.png' ||
    path === '/brand/openkit-mark-512.png'
  ) {
    return true;
  }
  if (!path.startsWith('/assets/')) return false;
  const file = path.slice('/assets/'.length);
  const hashed =
    /^[A-Za-z0-9._]*-([A-Za-z0-9]{4,})\.(js|css|mjs|map|woff2?|ttf|svg|png|webp|gif|ico)$/i.exec(
      file
    );
  if (!hashed?.[1] || !/\d/.test(hashed[1])) return false;
  return true;
}

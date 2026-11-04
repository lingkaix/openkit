import { describe, expect, it } from 'vitest';
import {
  isBypassedRequest,
  isShellCacheUrl,
  mayActivateWaitingWorker,
  navigationUsesNetworkFirst,
} from './worker-policy';

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

describe('worker navigation policy', () => {
  it('uses network-first for navigation and falls back to the cached shell only on failure', () => {
    expect(navigationUsesNetworkFirst()).toBe(true);
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

import { isShellCacheUrl } from './worker-policy';

/**
 * Drops Cache Storage entries that are not static shell URLs.
 *
 * Logout calls this. The shell cache itself stays, because it holds no account data.
 *
 * @returns Resolves when disallowed entries are gone.
 */
export async function retainShellCacheOnLogout(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const names = await caches.keys();
  await Promise.all(
    names.map(async (name) => {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      await Promise.all(
        requests
          .filter((request) => !isShellCacheUrl(request.url))
          .map((request) => cache.delete(request))
      );
    })
  );
}

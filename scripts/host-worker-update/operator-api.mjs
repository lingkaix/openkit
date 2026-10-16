/** Bounded public operations with the existing endpoint-scoped administrator credential. */
import { createCoreClient } from '@openkit/core-client';
import {
  createDefaultOpenKitCredentialStore,
  resolveCredential,
} from '../../skills/openkit-secrets.mjs';

const unavailable = 'Operator API unavailable; inspect before any new effect.';
const operations = new Set([
  'app-update.prepare',
  'app-update.preflight',
  'app-update.start',
  'app-update.status',
  'nanohost.runtime-target',
  'diagnostics.app',
  'worker-environment.prepare',
  'worker-environment.activate',
  'thread.read',
  'turn.read',
  'thread.items',
  'artifact.read',
]);

/**
 * Keep authority resolution with the administrator CLI's credential owner.
 * Image preparation waits up to thirty minutes for synchronous cold acquisition;
 * other operations have thirty seconds, including bounded body collection.
 * A rejected or lost mutation remains unknown; this adapter never retries it.
 * @param {string} target Explicit HTTPS origin selected from the protected staging binding.
 * @param {object} adapters Optional in-process boundaries for contained verification.
 * @returns {{call: Function}} Existing schema-validated operation caller.
 */
export function createOperatorApi(target, adapters = {}) {
  const url = new URL(target);
  if (
    url.protocol !== 'https:' ||
    url.origin !== target ||
    url.username ||
    url.password ||
    url.hostname === 'a2'
  )
    throw Error(unavailable);
  const fetcher = adapters.fetch ?? globalThis.fetch;
  const resolve =
    adapters.resolve ??
    (() =>
      resolveCredential({
        endpoint: target,
        env: process.env,
        store: createDefaultOpenKitCredentialStore(),
      }));
  return {
    async call(operation, input) {
      try {
        if (!operations.has(operation)) throw Error();
        const credential = await resolve();
        if (typeof credential?.token !== 'string' || !credential.token) throw Error();
        const client = createCoreClient({
          baseUrl: target,
          headers: {
            authorization: `Bearer ${credential.token}`,
            'x-openkit-client-channel': 'openkit-cli',
            'x-openkit-client-source': 'operator-update',
          },
          fetch: async (destination, options) => {
            if (new URL(destination).origin !== target) throw Error();
            const controller = new AbortController();
            let reader;
            let timer;
            const request = (async () => {
              const response = await fetcher(destination, {
                ...options,
                redirect: 'error',
                signal: controller.signal,
              });
              if (controller.signal.aborted) {
                void response.body?.cancel().catch(() => {});
                throw Error();
              }
              if (!response.ok || !response.body) throw Error();
              reader = response.body.getReader();
              const chunks = [];
              let length = 0;
              for (;;) {
                const item = await reader.read();
                if (item.done) break;
                length += item.value.byteLength;
                if (length > 4_194_304) throw Error();
                chunks.push(item.value);
              }
              return new Response(Buffer.concat(chunks, length), {
                status: response.status,
                headers: response.headers,
              });
            })();
            try {
              return await Promise.race([
                request,
                new Promise((_, reject) => {
                  timer = setTimeout(
                    () => {
                      controller.abort();
                      reject(Error(unavailable));
                    },
                    operation === 'worker-environment.prepare' ? 1_800_000 : 30_000
                  );
                }),
              ]);
            } catch {
              controller.abort();
              // Cancellation is best effort. Do not wait on a remote reader after the bound.
              void reader?.cancel().catch(() => {});
              throw Error(unavailable);
            } finally {
              clearTimeout(timer);
            }
          },
        });
        if (typeof client.operations[operation] !== 'function') throw Error();
        return await client.operations[operation](input);
      } catch {
        throw Error(unavailable);
      }
    },
  };
}

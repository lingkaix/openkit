import type { createApp } from './app.js';

type ListenerFetch = ReturnType<typeof createApp>['fetch'];

/** Returns whether one request belongs exclusively to the private NanoHost listener. */
const isNanoHostPrivateRequest = (request: Request) => {
  const path = new URL(request.url).pathname;
  return (
    path.startsWith('/api/nanohost/transport/') ||
    path.startsWith('/worker-control/') ||
    path.startsWith('/inference/') ||
    path.startsWith('/capabilities/')
  );
};
/** Binds the two listener boundaries before requests reach semantic routing. */
export function createListenerFetches(fetch: ListenerFetch): {
  appFetch: ListenerFetch;
  nanoHostFetch: ListenerFetch;
} {
  const appFetch: ListenerFetch = async (request, env, executionContext) =>
    isNanoHostPrivateRequest(request) ||
    new URL(request.url).pathname.startsWith('/api/worker-capabilities/')
      ? new Response(null, { status: 404 })
      : fetch(request, env, executionContext);
  const nanoHostFetch: ListenerFetch = async (request, env, executionContext) =>
    isNanoHostPrivateRequest(request)
      ? fetch(request, env, executionContext)
      : new Response(null, { status: 404 });

  return { appFetch, nanoHostFetch };
}

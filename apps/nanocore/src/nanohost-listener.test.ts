import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createListenerFetches } from './nanohost-listener.js';

describe('NanoHost listener route admission', () => {
  it.each(['/api/worker-capabilities/mcp/_list-servers', '/api/worker-capabilities/mcp/server'])(
    'refuses direct internal capability requests on both listeners: %s',
    async (path) => {
      const app = new Hono();
      app.all('/api/worker-capabilities/*', (c) => c.text('handler reached'));
      const { appFetch, nanoHostFetch } = createListenerFetches(app.fetch);
      for (const fetch of [appFetch, nanoHostFetch]) {
        expect((await fetch(new Request(`http://localhost${path}`))).status).toBe(404);
      }
    }
  );

  it.each([
    '/api/nanohost/transport/admit',
    '/worker-control/poll',
    '/inference/chat',
    '/capabilities/mcp/server',
  ])('admits only the NanoHost listener for declared private routes: %s', async (path) => {
    const app = new Hono();
    app.all('*', (c) => c.text('dispatched'));
    const { appFetch, nanoHostFetch } = createListenerFetches(app.fetch);
    expect((await appFetch(new Request(`http://localhost${path}`))).status).toBe(404);
    expect((await nanoHostFetch(new Request(`http://localhost${path}`))).status).toBe(200);
  });

  it.each(['/api/meta', '/api/auth/sign-in', '/api/workspaces', '/events', '/capabilities-other'])(
    'refuses public routes on the NanoHost listener: %s',
    async (path) => {
      const app = new Hono();
      app.all('*', (c) => c.text('public'));
      const { appFetch, nanoHostFetch } = createListenerFetches(app.fetch);
      expect((await nanoHostFetch(new Request(`http://localhost${path}`))).status).toBe(404);
      expect((await appFetch(new Request(`http://localhost${path}`))).status).toBe(200);
    }
  );
});

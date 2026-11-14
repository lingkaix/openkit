// openkit-test-platform: posix
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NON_API_EXPOSURE_DEFINITIONS, OPERATION_REGISTRY } from '@openkit/app-api-schemas';
import { expect, it, onTestFinished } from 'vitest';
import { createApp } from '../app.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { createAppOpenApiDocument, getRegisteredAppApiOperationIds } from '../openapi.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, createTestStore, disposeTestStore } from '../test-support/store.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

type Route = {
  readonly method: string;
  readonly path: string;
  readonly handler?: object;
};
const IMAGE_PATH = '/api/nanohost/transport/effects/image.build/input';
const IMAGE_INPUT = 'POST ' + IMAGE_PATH;
/** Bounded mapping of the one real terminal USE handler hidden behind ALL *. */
function nativeWildcard(route: Route) {
  return (
    route.path === '/*' &&
    typeof route.handler === 'function' &&
    Function.prototype.toString.call(route.handler).includes(IMAGE_PATH)
  );
}
type Diagnostic = { readonly entry: string; readonly reason: string };
const gateway = new Set(['GET /v1/models', 'POST /v1/chat/completions', 'POST /v1/responses']);
const protectedOperations = new Set([
  'policy.write',
  'bootstrap.consume',
  'administration.configuration-apply',
  'token.revoke',
  'token.my-admin-list',
  'token.my-admin-default',
]);
const independent = new Set([
  'GET /health',
  'GET /api/health',
  'GET /api/meta',
  'GET /api/diagnostics',
  'GET /api/openapi.json',
  'ALL /api/auth/*',
]);
const middleware = new Set([
  'ALL /*',
  'ALL /v1/chat/completions',
  'ALL /v1/responses',
  'ALL /api/workspaces/:workspaceId/threads/:threadId/events',
  'ALL /api/app/workspaces/:workspaceId/exports/:exportId/archive',
  'ALL /api/*',
  'ALL /v1/*',
  'ALL /api/worker-control/*',
  'ALL /api/worker-control/credential-helper',
  'ALL /api/worker-inference/*',
  'ALL /api/worker-capabilities/*',
]);
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
function exposure(value: unknown) {
  return object(object(value)?.exposure);
}
const sourceGroups = new Set(
  Object.values({
    ...OPERATION_REGISTRY,
    ...NON_API_EXPOSURE_DEFINITIONS,
  }).flatMap((value) => {
    const e = exposure(value);
    return e?.kind === 'switchable' && typeof e.group === 'string' ? [e.group] : [];
  })
);

/** One private repository checker. It checks exact source entries before mapping a native route family to its shared seam. */
function audit(
  routes: readonly Route[],
  registeredIds: readonly string[],
  registry: object = OPERATION_REGISTRY,
  nonApi: object = NON_API_EXPOSURE_DEFINITIONS
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const contracts = Object.fromEntries(Object.entries(registry));
  const direct = Object.fromEntries(Object.entries(nonApi));
  function check(entry: string, descriptor: unknown): boolean {
    const e = exposure(descriptor);
    if (!e || typeof e.owner !== 'string' || !e.owner.trim()) {
      diagnostics.push({
        entry,
        reason: 'Missing accountable exposure owner.',
      });
      return false;
    }
    if (e.kind === 'switchable') {
      if (typeof e.group !== 'string' || !sourceGroups.has(e.group)) {
        diagnostics.push({
          entry,
          reason: 'Missing or unresolved exact source group.',
        });
        return false;
      }
      if (protectedOperations.has(entry) || independent.has(entry)) {
        diagnostics.push({
          entry,
          reason: 'Protected current authorization must stay ungrouped.',
        });
        return false;
      }
    } else if (e.kind !== 'independent' || e.group !== undefined) {
      diagnostics.push({
        entry,
        reason: 'No valid independently authorized or switchable classification.',
      });
      return false;
    }
    return true;
  }
  for (const [id, value] of Object.entries(contracts)) check(id, value);
  for (const id of registeredIds)
    if (!Object.hasOwn(contracts, id))
      diagnostics.push({
        entry: id,
        reason: 'Mounted projection refers to an unresolved exact registered operation.',
      });
  const common = new Map<string, string>();
  const document = createAppOpenApiDocument();
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, value] of Object.entries(methods)) {
      const id = object(value)?.operationId;
      if (typeof id === 'string')
        common.set(`${method.toUpperCase()} ${path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')}`, id);
    }
  }
  // The actual native handler is selected from this real composition, not by
  // method/path deduplication. No registration counts or Hono subclass are used.
  const nativeInputHandler = routes.find(nativeWildcard)?.handler;
  for (const route of routes) {
    let key = `${route.method === '*' ? 'ALL' : route.method.toUpperCase()} ${route.path}`;
    const nativeInput = key === 'ALL /*' && nativeWildcard(route);
    if (nativeInput) {
      if (route.handler !== nativeInputHandler) {
        diagnostics.push({
          entry: IMAGE_INPUT,
          reason: 'Unresolved terminal wildcard input handler.',
        });
        continue;
      }
      key = IMAGE_INPUT;
    }
    const id = common.get(key);
    if (id) {
      if (!Object.hasOwn(contracts, id))
        diagnostics.push({
          entry: key,
          reason: `No exact registered operation ${id}.`,
        });
      continue;
    }
    // No prefix exemption: every non-API key first needs its exact owned source descriptor.
    if (!Object.hasOwn(direct, key)) {
      diagnostics.push({
        entry: key,
        reason: 'Mounted route has no source-owned enforcement mapping.',
      });
      continue;
    }
    if (!check(key, direct[key])) continue;
    if (nativeInput && exposure(direct[key])?.kind !== 'switchable') {
      diagnostics.push({
        entry: key,
        reason:
          'Terminal NanoHost input requires switchable native ownership, not global middleware.',
      });
      continue;
    }
    const path = key.slice(key.indexOf(' ') + 1);
    const seam = gateway.has(key)
      ? 'llm-gateway'
      : key === 'GET /api/workspaces/:workspaceId/threads/:threadId/events' || path === '/mcp'
        ? 'operation-admission'
        : key === 'POST /api/channels/discord/interactions'
          ? 'signed-discord'
          : path.startsWith('/api/worker-control/')
            ? 'worker-control'
            : path.startsWith('/api/worker-inference/')
              ? 'llm-gateway'
              : path.startsWith('/api/worker-capabilities/')
                ? 'worker-mcp'
                : path.startsWith('/api/nanohost/')
                  ? 'nanohost'
                  : independent.has(key) || middleware.has(key)
                    ? 'independent-current-owner'
                    : null;
    if (!seam)
      diagnostics.push({
        entry: key,
        reason: 'Owned route does not resolve to an existing enforcement seam.',
      });
  }
  return diagnostics;
}
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-e13-composition-'));
  const coreDb = createTestCoreDb(dataRoot);
  onTestFinished(async () => {
    await disposeTestStore(dataRoot, coreDb);
  });
  ensureLocalUser(coreDb);
  const store = createTestStore({ dataRoot });
  const auth = createBetterAuth(coreDb, {
    env: { BETTER_AUTH_URL: 'http://localhost:3000' },
  });
  const app = createApp({
    mode: 'server',
    coreDb,
    dataRoot,
    store,
    auth,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
  });
  return { app, ids: getRegisteredAppApiOperationIds(app) };
}

it('covers real mounted routes and registered contracts through their source-owned shared seams', async () => {
  const f = await fixture();
  // Intended OLD BODY is absent exposure metadata/unmapped existing surfaces, not an absent module.
  expect(audit(f.app.routes, f.ids)).toEqual([]);
});
it('names an actual Hono-added rogue mount even when it stays outside the catalog', async () => {
  const f = await fixture();
  f.app.get('/v1/e13-unmapped-rogue', (c) => c.json({ fixture: true }));
  expect(audit(f.app.routes, f.ids)).toEqual(
    expect.arrayContaining([expect.objectContaining({ entry: 'GET /v1/e13-unmapped-rogue' })])
  );
});

it('rejects missing owner/group and unresolved exact projection IDs on immutable source copies', async () => {
  const f = await fixture();
  const key = 'GET /v1/models';
  const original = NON_API_EXPOSURE_DEFINITIONS[key];
  for (const changed of [
    { exposure: { ...original.exposure, owner: '' } },
    { exposure: { kind: 'switchable', owner: original.exposure.owner } },
    { exposure: { ...original.exposure, group: 'llm-gateway-not-registered' } },
  ]) {
    const copy = { ...NON_API_EXPOSURE_DEFINITIONS, [key]: changed };
    expect(audit(f.app.routes, f.ids, OPERATION_REGISTRY, copy)).toEqual(
      expect.arrayContaining([expect.objectContaining({ entry: key })])
    );
  }
  const exact = 'kernel.apps.get-e13-not-registered';
  expect(Object.hasOwn(OPERATION_REGISTRY, exact)).toBe(false);
  expect(audit(f.app.routes, [...f.ids, exact])).toEqual(
    expect.arrayContaining([expect.objectContaining({ entry: exact })])
  );
  expect(NON_API_EXPOSURE_DEFINITIONS[key]).toBe(original);
});
it('does not permit a shared group to capture native Policy recovery', async () => {
  const f = await fixture();
  const descriptor = OPERATION_REGISTRY['policy.write'];
  const copy = {
    ...OPERATION_REGISTRY,
    'policy.write': {
      ...descriptor,
      exposure: { kind: 'switchable', owner: 'policy', group: 'llm-gateway' },
    },
  };
  expect(audit(f.app.routes, f.ids, copy)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entry: 'policy.write',
        reason: 'Protected current authorization must stay ungrouped.',
      }),
    ])
  );
});

it('maps the actual native wildcard handler to owned NanoHost input rather than exempt middleware', async () => {
  const f = await fixture();
  const actual = f.app.routes.find(nativeWildcard);
  expect(actual?.handler).toBeDefined();
  const missing = Object.fromEntries(
    Object.entries(NON_API_EXPOSURE_DEFINITIONS).filter(([key]) => key !== IMAGE_INPUT)
  );
  expect(audit(f.app.routes, f.ids, OPERATION_REGISTRY, missing)).toEqual(
    expect.arrayContaining([expect.objectContaining({ entry: IMAGE_INPUT })])
  );
  const independentInput = {
    ...NON_API_EXPOSURE_DEFINITIONS,
    [IMAGE_INPUT]: { exposure: { kind: 'independent', owner: 'nanohost' } },
  };
  expect(audit(f.app.routes, f.ids, OPERATION_REGISTRY, independentInput)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entry: IMAGE_INPUT,
        reason:
          'Terminal NanoHost input requires switchable native ownership, not global middleware.',
      }),
    ])
  );
  // A second actual USE callback cannot borrow the original native handler's identity.
  f.app.use('*', async (c, next) => {
    if (c.req.path !== '/api/nanohost/transport/effects/image.build/input') return next();
    return c.body(null, 418);
  });
  expect(audit(f.app.routes, f.ids)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entry: IMAGE_INPUT,
        reason: 'Unresolved terminal wildcard input handler.',
      }),
    ])
  );
});

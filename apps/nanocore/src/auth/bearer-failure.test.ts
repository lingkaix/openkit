import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { listServerAuditEvents } from '../audit-events.js';
import type { CoreDb } from '../storage/db.js';
import { createTestCoreDb, createTestStore, disposeTestStore } from '../test-support/store.js';

const WINDOW = 15 * 60 * 1_000;
const START = Date.parse('2031-01-01T00:00:00.000Z');
const REJECTED_BEARER = 'e1-deliberately-invalid-not-an-openkit-token';
const owned: { dataRoot: string; coreDb: CoreDb }[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const fixture of owned.splice(0)) await disposeTestStore(fixture.dataRoot, fixture.coreDb);
});

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-e1-bearer-'));
  const coreDb = createTestCoreDb(dataRoot);
  owned.push({ dataRoot, coreDb });
  const store = createTestStore({ dataRoot });
  // Only Date is virtual: native owner RPCs and their timers remain real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  return {
    app: createApp({ mode: 'server', coreDb, dataRoot, store }),
    coreDb,
  };
}

type App = ReturnType<typeof createApp>;

async function reject(
  app: App,
  peer: string | undefined,
  index: number,
  headers: Record<string, string> = {},
  host = 'e1-fixture.invalid'
) {
  const path = ['/api/openapi.json', '/v1/models', '/mcp'][index % 3]!;
  const response = await app.request(
    new Request(`https://${host}${path}`, {
      method: path === '/mcp' ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${REJECTED_BEARER}`, ...headers },
    }),
    undefined,
    { incoming: { socket: { encrypted: true, ...(peer ? { remoteAddress: peer } : {}) } } }
  );
  expect(response.status).toBe(401);
  expect(response.headers.has('retry-after')).toBe(false);
  if (path === '/mcp') expect(response.headers.get('www-authenticate')).toBe('Bearer');
  expect(await response.json()).toEqual({
    protocolVersion: PROTOCOL_VERSION,
    code: 'core.auth.unauthenticated',
    message: 'Authentication required.',
  });
}

async function failures(app: App, peer: string, count: number) {
  for (let index = 0; index < count; index++) await reject(app, peer, index);
}

function crossings(coreDb: CoreDb) {
  const events = listServerAuditEvents(coreDb).filter(
    (event) => event.action === 'auth.failure-threshold'
  );
  for (const event of events) {
    expect(event.workspaceId).toBeNull();
    expect(event.actor).toBeNull();
    expect(event.subject).toBeNull();
    expect(event.authentication).toBeUndefined();
    expect(JSON.parse(event.summary)).toEqual({
      kind: 'bearer',
      keyKind: 'source',
      window: WINDOW,
      count: 100,
    });
  }
  expect(JSON.stringify(events)).not.toContain(REJECTED_BEARER);
  return events;
}

describe('E1/E5 bearer failure observations at the real App boundary', () => {
  it('counts 100 per physical source across App surfaces and emits only one crossing per window', async () => {
    const { app, coreDb } = fixture();
    await failures(app, '203.0.113.10', 99);
    await failures(app, '203.0.113.11', 1);
    expect(crossings(coreDb)).toHaveLength(0);
    await failures(app, '203.0.113.10', 1);
    expect(crossings(coreDb)).toHaveLength(1);
    await failures(app, '203.0.113.10', 100);
    expect(crossings(coreDb)).toHaveLength(1);
    await failures(app, '203.0.113.11', 99);
    expect(crossings(coreDb)).toHaveLength(2);
  });

  it('retains history inside 15 minutes, expires old history and rearms an already crossed source', async () => {
    const { app, coreDb } = fixture();
    await failures(app, '203.0.113.20', 99);
    vi.setSystemTime(START + WINDOW - 1);
    await failures(app, '203.0.113.20', 1);
    expect(crossings(coreDb)).toHaveLength(1);
    await failures(app, '203.0.113.21', 99);
    expect(crossings(coreDb)).toHaveLength(1);
    vi.setSystemTime(START + 2 * WINDOW);
    await failures(app, '203.0.113.21', 1);
    expect(crossings(coreDb)).toHaveLength(1);
    await failures(app, '203.0.113.21', 98);
    expect(crossings(coreDb)).toHaveLength(1);
    await failures(app, '203.0.113.21', 1);
    expect(crossings(coreDb)).toHaveLength(2);
    await failures(app, '203.0.113.20', 99);
    expect(crossings(coreDb)).toHaveLength(2);
    await failures(app, '203.0.113.20', 1);
    expect(crossings(coreDb)).toHaveLength(3);
  });

  it('bounds retained source counters at 1024 without throttling and keeps new source accounting live', async () => {
    const { app, coreDb } = fixture();
    await failures(app, '203.0.113.30', 99);
    for (let index = 0; index < 1024; index++)
      await reject(app, `2001:db8::${(index + 1).toString(16)}`, index);
    expect(crossings(coreDb)).toHaveLength(0);
    // The oldest untouched source has left the bounded set; this is a fresh first failure.
    await failures(app, '203.0.113.30', 1);
    expect(crossings(coreDb)).toHaveLength(0);
    await failures(app, '2001:db8::400', 98);
    expect(crossings(coreDb)).toHaveLength(0);
    await failures(app, '2001:db8::400', 1);
    expect(crossings(coreDb)).toHaveLength(1);
    await failures(app, '203.0.113.30', 98);
    expect(crossings(coreDb)).toHaveLength(1);
    await failures(app, '203.0.113.30', 1);
    expect(crossings(coreDb)).toHaveLength(2);
  });

  it('ignores forged forwarding and URL hosts, including when the physical source is absent', async () => {
    const { app, coreDb } = fixture();
    for (let index = 0; index < 100; index++)
      await reject(
        app,
        '203.0.113.40',
        index,
        {
          'x-forwarded-for': `198.51.100.${index + 1}`,
          'x-real-ip': `192.0.2.${index + 1}`,
          forwarded: `for=192.0.2.${index + 1};proto=https`,
        },
        `spoofed-${index}.invalid`
      );
    expect(crossings(coreDb)).toHaveLength(1);
    expect(JSON.stringify(crossings(coreDb))).not.toMatch(/198\.51\.100\.|192\.0\.2\.|spoofed-/);
    await failures(app, '203.0.113.41', 99);
    await reject(
      app,
      undefined,
      0,
      {
        'x-forwarded-for': '203.0.113.41',
        'x-real-ip': '203.0.113.41',
        forwarded: 'for=203.0.113.41;proto=https',
      },
      '203.0.113.41'
    );
    expect(crossings(coreDb)).toHaveLength(1);
    await failures(app, '203.0.113.41', 1);
    expect(crossings(coreDb)).toHaveLength(2);
  });
});

import { performance } from 'node:perf_hooks';
import { clearImmediate, setImmediate } from 'node:timers';
import { expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { navigationFixture } from '../test-support/nav-oracle.fixture.js';
import { operationRequest } from '../test-support/operation-request.js';

/** The shared owner generator is observed whether callers drain it synchronously or cooperatively. */
it('releases Main after a real enumeration contribution and before navigation completes', async () => {
  const f = await navigationFixture();
  for (let i = 0; i < 32; i++) await f.store.createThread(f.workspaceId, `Cooperative source ${i}`);
  const token = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: f.actor.id,
    scope: 'workspace',
    workspaceIds: [f.workspaceId],
    expiresAt: '2099-01-01T00:00:00.000Z',
  }).secret;
  const original = f.store.listThreadsSteps.bind(f.store);
  let immediate: NodeJS.Immediate | undefined;
  let released = false;
  let sourceRows = 0;
  let enumerationMs = 0;
  const threads = vi.spyOn(f.store, 'listThreadsSteps').mockImplementation(function* (...args) {
    const steps = original(...args);
    try {
      for (;;) {
        const step = steps.next();
        if (step.done) {
          if (args[0] === f.workspaceId)
            sourceRows = step.value.filter((thread) => thread.status === 'active').length;
          return step.value;
        }
        if (args[0] === f.workspaceId && immediate === undefined) {
          immediate = setImmediate(() => {
            released = true;
          });
          // Labelled cost counterfault on an actual owner contribution, with unchanged yields and return value.
          const started = performance.now();
          while (performance.now() - started < 25) {
            /* bounded real elapsed source work */
          }
          enumerationMs = performance.now() - started;
        }
        yield step.value;
      }
    } finally {
      steps.return([]);
    }
  });
  try {
    const response = await f.app.request(
      ...operationRequest(
        'conversation.navigation',
        {
          workspaceId: f.workspaceId,
          limit: 1,
        },
        { headers: { authorization: `Bearer ${token}` } }
      )
    );
    const releasedAtCompletion = released;
    expect(response.status).toBe(200);
    expect(sourceRows).toBe(33);
    expect(enumerationMs).toBeGreaterThanOrEqual(25);
    expect(
      releasedAtCompletion,
      'Main must run a queued immediate during navigation source work'
    ).toBe(true);
  } finally {
    threads.mockRestore();
    if (immediate !== undefined) clearImmediate(immediate);
  }
}, 60000);

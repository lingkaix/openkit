import { SecurityConfigSchema } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import type { CoreDb } from '../storage/db.js';
import { SecurityTriggerRefusal } from '../storage/security-trigger-codecs.js';
import { SECURITY_TRIGGER_DISABLED_SNAPSHOT } from '../storage/security-trigger-native.js';
import { SECURITY_TRIGGER_OWNER } from '../storage/security-trigger-port.js';
import { drainSecurityNotices, publishSecurityAlarm } from './publication.js';
import { prepareSecurityThread, selectSecurityThread } from './threads.js';
import { SecurityTriggerStore } from './trigger.js';

const untouched = new Proxy({} as CoreDb, {
  get() {
    throw new Error('security trigger touched a database handle');
  },
});

describe('security trigger stays disabled before SQL', () => {
  it('reports disabled and refuses activation, detection, publication and containment', async () => {
    const trigger = new SecurityTriggerStore(untouched);
    expect(trigger.status()).toEqual({
      state: 'unavailable',
      owner: SECURITY_TRIGGER_OWNER.owner,
      reason: 'disabled',
    });
    expect(SECURITY_TRIGGER_OWNER.provision).toBe('none');
    expect(await trigger.current()).toEqual(SECURITY_TRIGGER_DISABLED_SNAPSHOT);
    await expect(trigger.enable({ kind: 'local', userId: 'user_test' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(trigger.stop({ kind: 'local', userId: 'user_test' })).rejects.toBeInstanceOf(
      SecurityTriggerRefusal
    );
    expect(await trigger.detectAudit()).toEqual({
      cursor: null,
      scanned: 0,
      detected: 0,
      unsupported: 0,
    });
    expect(await trigger.readAlarms()).toEqual([]);
    expect(await trigger.readEventOutbox()).toEqual([]);
    expect(await trigger.consumeSensor({} as never, {} as never)).toEqual({
      kind: 'not-admitted',
    });
    await trigger.advanceContainment({} as never, {} as never, {} as never);
    expect(await trigger.prepareContainment({} as never)).toBeNull();
    expect(await trigger.checkContainment({} as never, {} as never)).toBeNull();
    await expect(
      publishSecurityAlarm({ coreDb: untouched, store: {} as never, requestId: 'request' })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await drainSecurityNotices({ coreDb: untouched, store: {} as never });
    expect(
      await selectSecurityThread({
        coreDb: untouched,
        store: {} as never,
        workspaceId: 'workspace',
        threadId: 'thread',
      })
    ).toBeNull();
    await expect(
      prepareSecurityThread({ coreDb: untouched, store: {} as never, requestId: 'request' })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps authored feeds from enabling the trigger', () => {
    const parsed = SecurityConfigSchema.parse({
      feeds: [
        {
          id: 'osv',
          name: 'OSV',
          kind: 'osv-api',
          location: 'https://example.test/osv',
        },
      ],
      pauseAgentWork: false,
    });
    expect(parsed.feeds).toHaveLength(1);
    expect(new SecurityTriggerStore(untouched).status().reason).toBe('disabled');
  });
});

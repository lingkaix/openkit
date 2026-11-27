import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createOperationInvocation } from '../operation-composition.js';
import type { NanoHostCoreReads } from '../storage/control-kernel-port.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createNanoHostCoreReads } from '../storage/nanohost-core-reads.js';
import { transitionAdmittedNanoHostRuntimeTarget } from '../storage/nanohost-transport-owner.js';
import { openAdmittedTestNanoHost } from '../test-support/admitted-nanohost.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { createAdministrationNanoHostRuntimeTargetTool } from './nanohost-runtime-target-tool.js';

const identityId = 'integration_nanohost_primary';
const deploymentId = testEntityId('dep', 'deploy_primary');
const physicalEpoch = 'a'.repeat(64);

function toolFor(
  coreDb: ReturnType<typeof openCoreDb> | undefined,
  readNanoHostTarget?: NanoHostCoreReads['readTarget']
) {
  return createAdministrationNanoHostRuntimeTargetTool({
    coreDb,
    createOperationInvocation: (dependencies) =>
      createOperationInvocation({
        ...dependencies,
        ...(readNanoHostTarget ? { readNanoHostTarget } : {}),
      }),
    actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
    lineage: {
      workspaceId: 'ws_00000000-0000-7385-aa6f-e0db858f78e5',
      threadId: 'th_00000000-0000-7bde-9ab2-7d21d4186dff',
      turnId: 'tu_00000000-0000-7e13-bcb6-acb21b36a45c',
    },
    mode: 'server',
    nanoHostConfig: { deploymentId, identityId },
  });
}

describe('administration nanohost.runtime-target Tool', () => {
  it('reports a held NanoHost owner with current Core administrator authority', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-admin-nanohost-tool-held-')));
    onTestFinished(() => disposeTestStore(coreDb.dataRoot, coreDb));
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const held = await toolFor(coreDb, () => ({
      state: 'unavailable',
      owner: 'nanohost',
      reason: 'disabled',
    })).execute(
      {},
      { callId: 'call_storage', toolOccurrence: 1, signal: new AbortController().signal }
    );
    expect(held.isError).toBe(true);
    expect(JSON.parse((held.content[0] as { text: string }).text)).toMatchObject({
      code: 'nanohost_transport_storage_unavailable',
    });
  });

  it('returns ready, unready, and missing observations with stored physicalEpoch and no host selection', async () => {
    const missing = await toolFor(undefined).execute(
      {},
      { callId: 'call_storage', toolOccurrence: 1, signal: new AbortController().signal }
    );
    expect(missing).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringContaining('nanohost_transport_storage_unavailable'),
        },
      ],
    });

    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-admin-nanohost-tool-')));
    onTestFinished(() => disposeTestStore(coreDb.dataRoot, coreDb));
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const storage = await openAdmittedTestNanoHost(coreDb);
    const tool = toolFor(coreDb, createNanoHostCoreReads(storage.value.owner).readTarget);
    const context = {
      callId: 'call_target',
      toolOccurrence: 1,
      signal: new AbortController().signal,
    };

    const absent = await tool.execute({}, context);
    expect(JSON.parse((absent.content[0] as { text: string }).text)).toMatchObject({
      code: 'nanohost_runtime_target_not_found',
    });
    expect(absent.isError).toBe(true);

    const allocated = await transitionAdmittedNanoHostRuntimeTarget(storage.value, {
      kind: 'allocate',
      deploymentId,
      identityId,
      observedAt: '2026-08-15T01:02:02.000Z',
      targetId: identityId,
    });
    expect(allocated).toMatchObject({ state: 'ready', value: { connectionGeneration: 1 } });
    const unready = await tool.execute({}, context);
    expect(JSON.parse((unready.content[0] as { text: string }).text)).toEqual({
      connectionGeneration: 1,
      deploymentId,
      freshEmpty: false,
      identityId,
      observedAt: '2026-08-15T01:02:02.000Z',
      physicalEpoch: null,
      predecessorFenced: false,
      ready: false,
    });
    expect(unready.isError).toBeUndefined();
    expect(JSON.stringify(unready)).toContain('physicalEpoch');
    expect(JSON.stringify(unready)).not.toContain(physicalEpoch);

    await expect(
      transitionAdmittedNanoHostRuntimeTarget(storage.value, {
        kind: 'ready',
        connectionGeneration: 1,
        deploymentId,
        freshEmpty: true,
        identityId,
        observedAt: '2026-08-15T01:02:03.000Z',
        physicalEpoch,
        predecessorFenced: true,
        ready: true,
        targetId: identityId,
      })
    ).resolves.toMatchObject({ state: 'ready', value: { physicalEpoch } });
    const ready = await tool.execute({}, context);
    expect(JSON.parse((ready.content[0] as { text: string }).text)).toEqual({
      connectionGeneration: 1,
      deploymentId,
      freshEmpty: true,
      identityId,
      observedAt: '2026-08-15T01:02:03.000Z',
      physicalEpoch,
      predecessorFenced: true,
      ready: true,
    });
    expect(JSON.stringify(ready)).toContain('physicalEpoch');
    expect(JSON.stringify(ready)).toContain(physicalEpoch);

    const scoped = await tool.execute({ identityId: 'integration_nanohost_other' }, context);
    expect(JSON.parse((scoped.content[0] as { text: string }).text)).toMatchObject({
      code: 'nanohost_runtime_target_scope_rejected',
    });
    expect(scoped.isError).toBe(true);
  });
});

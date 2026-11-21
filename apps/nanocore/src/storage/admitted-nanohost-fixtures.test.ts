import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target.js';
import { resolvePublicNativeEnvironment } from '../runtime/native-environment.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { readAdmittedTestNanoHost } from '../test-support/admitted-nanohost.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironmentForRoot,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

it('seeds Native image defaults and target evidence on the admitted owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-test-native-owner-'));
  const core = createTestCoreDb(root);
  onTestFinished(() => disposeTestStore(root, core));
  const { manifest } = createTestAgentSetup();
  await admitTestNativeEnvironmentForRoot(core, manifest, { FIXTURE: 'from-image' });
  const target = await recordTestNativeRuntimeTarget(core, 'target-fixture');
  expect(resolvePublicNativeEnvironment(core, manifest).values).toEqual({
    FIXTURE: 'from-image',
  });
  expect(
    readAdmittedTestNanoHost(core, (sqlite) =>
      getNanoHostRuntimeTarget({ sqlite }, target.targetId)
    )
  ).toEqual(target);
  expect(
    core.sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name IN ('worker_image_settlements', 'nanohost_runtime_targets')"
      )
      .all()
  ).toEqual([]);
});

it('retains the exact scheduler preparation and submission without Native Core columns', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-test-attempt-'));
  const core = createTestCoreDb(root);
  onTestFinished(() => disposeTestStore(root, core));
  const workspaceId = allocateEntityId('ws');
  const turnId = allocateEntityId('tu');
  const userId = ensureLocalUser(core);
  recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId: userId });
  const entry = createSchedulerAdmissionEntry(core, {
    backendId: 'nanohost',
    inputRef: schedulerFixtureInput(workspaceId, turnId, 'Fixture input'),
    queueEntryId: 'test-queue',
    requestId: 'test-request',
    requestedAgentId: 'agent_codex_host',
    threadId: allocateEntityId('th'),
    triggerActor: { kind: 'user', id: userId },
    turnId,
    workspaceId,
  });
  const binding = {
    attemptId: allocateEntityId('attempt'),
    agentSessionId: allocateEntityId('as'),
    inputRef: 'fixture-package',
    bindingRef: 'fixture-binding',
  };
  expect(
    recordTestExecutionAttempt(core, {
      entry,
      ...binding,
      now: () => entry.enqueuedAt,
      operationId: 'fixture-operation',
    })
  ).toMatchObject({ ...binding, operationId: 'fixture-operation', disposition: 'unknown' });
});

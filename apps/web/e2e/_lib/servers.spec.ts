// openkit-test-platform: posix

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  promises as fsPromises,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SubmitConversationResponseSchema } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './servers.js';

const SYNTHETIC_LOCAL_EPOCH = 'a'.repeat(64);

/** Reproduces the Material browser handoff after the simulator ends its question-raising Turn. */
test('preserves Material delivery and delivers a durable simulator answer on the next Task Turn', async ({
  request,
}) => {
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const workspaceId = 'ws_demo';
  const content = '# Release revision one\n\nExact worker input.\n';
  const contentDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;

  try {
    const thread = await client.operations['thread.create']({
      workspaceId,
      name: 'Material pending-question reproduction',
      visibility: 'workspace',
      requestId: randomUUID(),
    });
    const { materialId } = await client.app.createWorkspaceMaterial(workspaceId, {
      title: 'Release Material',
      kind: 'markdown',
      sensitivity: 'internal',
      requestId: randomUUID(),
    });
    const { revisionId } = await client.app.saveWorkspaceMaterialRevision(workspaceId, materialId, {
      expectedRevisionId: null,
      content,
      contentDigest,
      requestId: randomUUID(),
    });
    await client.app.bindThreadMaterial(workspaceId, thread.id, materialId, {
      expectedBindingState: 'not_bound',
      requestId: randomUUID(),
    });
    const targets = await client.operations['conversation.targets']({
      workspaceId,
      threadId: thread.id,
    });
    const target = targets.targets.find((candidate) => candidate.kind === 'warm-worker');
    expect(target?.availability).toBe('available');
    const requestId = randomUUID();
    const response = await request.post(`${stack.coreUrl}/api/app/operations/conversation.submit`, {
      headers: { 'x-openkit-request-id': requestId },
      data: {
        workspaceId,
        threadId: thread.id,
        targetRef: target!.targetRef,
        input: 'Create a summary from the exact first release revision.',
        requestId,
      },
    });
    expect(response.status(), await response.text()).toBe(202);
    const submission = SubmitConversationResponseSchema.parse(await response.json());
    expect(submission.receivingThreadId).toBe(thread.id);
    const selector = { workspaceId, threadId: thread.id, turnId: submission.turn.id };
    let completed = false;
    for await (const event of client.core.subscribeTurnEvents(selector)) {
      if (event.event === 'turn.completed') {
        expect(event.data).toMatchObject({
          type: 'turn-completed',
          stopReason: 'completed',
          turn: { id: submission.turn.id, status: 'completed' },
        });
        completed = true;
      }
    }
    expect(completed, 'The exact admitted Turn must complete through its ordinary owner.').toBe(
      true
    );
    const turn = await client.operations['turn.read'](selector);
    expect(turn.status).toBe('completed');
    expect(turn.contextPackageDigest).toMatch(/^ctxpkg_sha256_[a-f0-9]{64}$/);
    const items = await client.operations['thread.items']({ workspaceId, threadId: thread.id });
    const question = items.items.find((item) => item.type === 'user-input-request');
    expect(question).toMatchObject({
      turnId: turn.id,
      status: 'completed',
      prompt: 'Which summary tone should the simulator use?',
    });
    expect(items.items.some((item) => item.type === 'user-input-response')).toBe(false);
    if (question?.type !== 'user-input-request') throw new Error('Simulator question missing.');
    const dashboard = await client.operations['thread.dashboard']({
      workspaceId,
      threadId: thread.id,
    });
    expect(dashboard.pendingRequests).toEqual([
      expect.objectContaining({
        requestId: question.userInputRequestId,
        state: 'pending',
        resolution: null,
        canRespond: true,
      }),
    ]);
    const trace = JSON.parse(
      readFileSync(
        join(
          stack.dataRoot,
          'workspaces',
          workspaceId,
          'threads',
          thread.id,
          'turns',
          turn.id,
          'context-package.json'
        ),
        'utf8'
      )
    );
    expect(trace).toMatchObject({
      turnId: turn.id,
      contextPackageDigest: turn.contextPackageDigest,
      materialSelections: [{ materialId, revisionId, contentDigest }],
    });
    const projection = await client.app.getThreadMaterial(workspaceId, thread.id);
    // S16 current-turn identity ends with the Turn; the verified worker-seen identity survives.
    expect(projection.material).toMatchObject({
      lastWorkerSeenRevisionId: revisionId,
      currentTurnRevisionId: null,
      activeDelivery: null,
      latestQueuedRevisionId: null,
    });
    const nextContent = '# Release revision two\n\nSaved without another message.\n';
    const { revisionId: nextRevisionId } = await client.app.saveWorkspaceMaterialRevision(
      workspaceId,
      materialId,
      {
        expectedRevisionId: revisionId,
        content: nextContent,
        contentDigest: `sha256:${createHash('sha256').update(nextContent).digest('hex')}`,
        requestId: randomUUID(),
      }
    );
    const queued = await client.app.getThreadMaterial(workspaceId, thread.id);
    expect(queued.material).toMatchObject({
      currentRevision: { revisionId: nextRevisionId },
      latestQueuedRevisionId: nextRevisionId,
      lastWorkerSeenRevisionId: revisionId,
      currentTurnRevisionId: null,
    });
    await stack.restartCore();
    expect(await client.app.getThreadMaterial(workspaceId, thread.id)).toEqual(queued);
    expect(
      (await client.operations['thread.dashboard']({ workspaceId, threadId: thread.id }))
        .pendingRequests
    ).toEqual(dashboard.pendingRequests);
    await client.operations['question.answer']({
      workspaceId,
      threadId: thread.id,
      userInputRequestId: question.userInputRequestId,
      requestId: randomUUID(),
      answers: { tone: ['Detailed'] },
    });
    const afterAnswer = await client.operations['thread.dashboard']({
      workspaceId,
      threadId: thread.id,
    });
    const nextTurn = afterAnswer.turns.at(-1)!;
    expect(nextTurn.id).not.toBe(turn.id);
    let answerTurnCompleted = false;
    for await (const event of client.core.subscribeTurnEvents({
      workspaceId,
      threadId: thread.id,
      turnId: nextTurn.id,
    })) {
      if (event.event === 'turn.completed') {
        expect(event.data).toMatchObject({
          stopReason: 'completed',
          turn: { status: 'completed' },
        });
        answerTurnCompleted = true;
      }
    }
    expect(answerTurnCompleted).toBe(true);
    const answerTurn = await client.operations['turn.read']({
      workspaceId,
      threadId: thread.id,
      turnId: nextTurn.id,
    });
    expect(answerTurn.contextPackageDigest).toMatch(/^ctxpkg_sha256_[a-f0-9]{64}$/);
    const deliveredMaterial = await client.app.getThreadMaterial(workspaceId, thread.id);
    expect(deliveredMaterial.material).toMatchObject({
      lastWorkerSeenRevisionId: nextRevisionId,
      latestQueuedRevisionId: null,
      currentTurnRevisionId: null,
    });
    expect((await client.operations['turn.read'](selector)).status).toBe('completed');
    const answeredItems = await client.operations['thread.items']({
      workspaceId,
      threadId: thread.id,
    });
    expect(answeredItems.items.filter((item) => item.type === 'user-input-response')).toEqual([
      expect.objectContaining({
        turnId: nextTurn.id,
        userInputRequestId: question.userInputRequestId,
        answers: { tone: ['Detailed'] },
      }),
    ]);
    const [
      { openWorkspaceDb },
      { readPendingRequest },
      { listExportableAgentEnvironmentPackageSnapshots },
    ] = await Promise.all([
      import('../../../nanocore/dist/storage/db.js'),
      import('../../../nanocore/dist/runtime/pending-requests.js'),
      import('../../../nanocore/dist/runtime/aep-snapshot-ledger.js'),
    ]);
    const workspaceDb = openWorkspaceDb(stack.dataRoot, workspaceId);
    try {
      expect(readPendingRequest(workspaceDb.sqlite, question.userInputRequestId)).toMatchObject({
        kind: 'user-input',
        requesterKind: 'worker',
        state: 'resolved',
        resolution: 'answered',
        raisingTurnId: turn.id,
        publicationTurnId: nextTurn.id,
        deliveryTurnId: nextTurn.id,
        delivery: 'delivered',
        answerMap: { tone: ['Detailed'] },
      });
      const snapshot = listExportableAgentEnvironmentPackageSnapshots(
        workspaceDb,
        workspaceId
      ).find((record) => record.snapshot.scope.turnId === nextTurn.id);
      const workerInput = (snapshot!.snapshot.extensions.openkit as { turnInput: string })
        .turnInput;
      expect(JSON.parse(workerInput).pendingOutcomes).toEqual([
        expect.objectContaining({
          requestId: question.userInputRequestId,
          resolution: 'answered',
          answers: { tone: ['Detailed'] },
          publicationTurnId: nextTurn.id,
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
    await stack.restartCore();
    expect(await client.app.getThreadMaterial(workspaceId, thread.id)).toEqual(deliveredMaterial);
    expect(
      (
        await client.operations['turn.read']({
          workspaceId,
          threadId: thread.id,
          turnId: nextTurn.id,
        })
      ).contextPackageDigest
    ).toBe(answerTurn.contextPackageDigest);
  } finally {
    await stack.stop();
  }
});

/** Resolves the authored fixture Agent through production digest-bound image admission. */
async function readFixtureNativeEnvironment(dataRoot: string) {
  const [{ openCoreDb }, { AuthoredAgentConfigSchema }, { resolvePublicNativeEnvironment }] =
    await Promise.all([
      import('../../../nanocore/dist/storage/db.js'),
      import('../../../nanocore/dist/agents/manifest.js'),
      import('../../../nanocore/dist/runtime/native-environment.js'),
    ]);
  const manifest = AuthoredAgentConfigSchema.parse(
    JSON.parse(readFileSync(join(dataRoot, 'config', 'agents', 'codex.agent.jsonc'), 'utf8'))
  );
  const coreDb = openCoreDb(dataRoot);
  try {
    return resolvePublicNativeEnvironment(coreDb, manifest);
  } finally {
    coreDb.sqlite.close();
  }
}

/**
 * Reads isolated fixture `target_local` and closes the Core handle before stack cleanup.
 *
 * @param dataRoot Stack-owned NanoCore data root.
 * @returns Durable target projection, or null when the row is absent.
 */
async function readFixtureLocalRuntimeTarget(dataRoot: string) {
  const [{ openCoreDb }, { getNanoHostRuntimeTarget }] = await Promise.all([
    import('../../../nanocore/dist/storage/db.js'),
    import('../../../nanocore/dist/runtime/nanohost-runtime-target.js'),
  ]);
  const coreDb = openCoreDb(dataRoot);
  try {
    return getNanoHostRuntimeTarget(coreDb, 'target_local');
  } finally {
    coreDb.sqlite.close();
  }
}

test('restarts Core on the same port and data root before final cleanup', async () => {
  test.setTimeout(45_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const coreUrl = stack.coreUrl;
  const dataRoot = stack.dataRoot;
  const lockPath = join(dataRoot, 'server', 'runtime', 'nanocore.lock');

  try {
    const firstPid = JSON.parse(readFileSync(lockPath, 'utf8')).pid as number;
    const beforeEnvironment = await readFixtureNativeEnvironment(dataRoot);
    expect(beforeEnvironment).toEqual({
      imageDigest: `sha256:${'a'.repeat(64)}`,
      defaultsDigest: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
      values: {},
    });
    const beforeTarget = await readFixtureLocalRuntimeTarget(dataRoot);
    expect(beforeTarget).toMatchObject({
      freshEmpty: true,
      physicalEpoch: SYNTHETIC_LOCAL_EPOCH,
      predecessorFenced: true,
      ready: true,
      targetId: 'target_local',
    });
    await stack.restartCore();
    const secondPid = JSON.parse(readFileSync(lockPath, 'utf8')).pid as number;
    const afterTarget = await readFixtureLocalRuntimeTarget(dataRoot);
    expect(await readFixtureNativeEnvironment(dataRoot)).toEqual(beforeEnvironment);

    expect(stack.coreUrl).toBe(coreUrl);
    expect(stack.dataRoot).toBe(dataRoot);
    expect(secondPid).not.toBe(firstPid);
    await expect(fetch(`${coreUrl}/api/health`)).resolves.toMatchObject({ ok: true });
    expect(afterTarget).toMatchObject({
      freshEmpty: true,
      physicalEpoch: SYNTHETIC_LOCAL_EPOCH,
      predecessorFenced: true,
      ready: true,
      targetId: 'target_local',
    });
    expect(afterTarget?.connectionGeneration).toBeGreaterThan(beforeTarget!.connectionGeneration);
  } finally {
    await stack.stop();
  }

  expect(existsSync(dataRoot)).toBe(false);
});

test('does not create a ready synthetic RuntimeTarget when the local stack disables the simulator', async () => {
  test.setTimeout(45_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: false });

  try {
    const target = await readFixtureLocalRuntimeTarget(stack.dataRoot);
    expect(target).toBeNull();
  } finally {
    await stack.stop();
  }

  expect(existsSync(stack.dataRoot)).toBe(false);
});

/**
 * Runs failed Web startup while controlling the detached group's post-TERM liveness probes.
 *
 * @param scenario Which bounded liveness and permission result to inject after failed startup.
 * @returns The cleanup failure and observable probe, signal, and data-root results.
 */
async function runWebGroupPermissionProbeScenario(
  scenario: 'alive-through-kill' | 'alive-then-eperm' | 'first-eperm' | 'kill-first-eperm'
) {
  const harnessRoot = mkdtempSync(join(tmpdir(), `openkit-web-${scenario}-`));
  const fakeBin = join(harnessRoot, 'bin');
  const dataRoot = join(harnessRoot, 'data-root');
  const webPidMarker = join(harnessRoot, 'web.pid');
  const originalDateNow = Date.now;
  const originalKill = process.kill;
  const originalMarker = process.env.OPENKIT_TEST_WEB_PID_MARKER;
  const originalPath = process.env.PATH;
  let nanoCorePid: number | undefined;
  let probeCount = 0;
  let signalPhase: NodeJS.Signals | undefined;
  let sigkillDeliveries = 0;
  let sigtermDeliveries = 0;
  let virtualNow = originalDateNow() + 31_000;
  let webPid: number | undefined;
  mkdirSync(fakeBin);
  mkdirSync(dataRoot);
  writeFileSync(
    join(fakeBin, 'pnpm'),
    `#!${process.execPath}
const { writeFileSync } = require('node:fs');
${scenario === 'first-eperm' ? '' : "process.on('SIGTERM', () => {});"}
writeFileSync(process.env.OPENKIT_TEST_WEB_PID_MARKER, String(process.pid), { flag: 'wx' });
setInterval(() => {}, 1000);
`,
    { mode: 0o700 }
  );
  process.env.OPENKIT_TEST_WEB_PID_MARKER = webPidMarker;
  process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

  const failurePromise = startIsolatedWebStack({
    dataRoot,
    mode: 'local',
    useSimulator: true,
  }).then(
    () => new Error('Web stack unexpectedly started.'),
    (error: unknown) => error
  );

  try {
    const markerDeadline = originalDateNow() + 30_000;
    while (originalDateNow() < markerDeadline && webPid === undefined) {
      if (existsSync(webPidMarker)) {
        const candidate = Number(readFileSync(webPidMarker, 'utf8'));
        if (Number.isInteger(candidate)) webPid = candidate;
      }
      // The Web marker follows Core readiness, so the lock bytes have finished publishing.
      if (webPid !== undefined && nanoCorePid === undefined) {
        const lockPath = join(dataRoot, 'server', 'runtime', 'nanocore.lock');
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (Number.isInteger(lock.pid)) nanoCorePid = lock.pid;
      }
      if (webPid === undefined) await delay(20);
    }

    if (webPid === undefined) {
      const startupFailure = await failurePromise;
      throw new Error(
        `Fake detached Web group did not start: ${
          startupFailure instanceof Error ? startupFailure.message : String(startupFailure)
        }`
      );
    }
    expect(nanoCorePid, 'NanoCore did not acquire the temporary data-root lock.').toBeDefined();
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -webPid! && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        signalPhase = signal;
        if (signal === 'SIGTERM') sigtermDeliveries += 1;
        else sigkillDeliveries += 1;
        if (scenario === 'alive-through-kill' || scenario === 'kill-first-eperm') {
          return true;
        }
      }
      if (pid === -webPid! && signal === 0) {
        probeCount += 1;
        if (scenario === 'alive-through-kill') {
          virtualNow += 2_001;
          return true;
        }
        if (scenario === 'kill-first-eperm') {
          if (signalPhase === 'SIGTERM') {
            virtualNow += 2_001;
            return true;
          }
          const error = new Error('Detached Web group is no longer addressable.');
          Object.assign(error, { code: 'EPERM' });
          throw error;
        }
        if (scenario === 'first-eperm' || probeCount > 1) {
          const error = new Error('Detached Web group is no longer addressable.');
          Object.assign(error, { code: 'EPERM' });
          throw error;
        }
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;
    virtualNow = originalDateNow() + 31_000;
    Date.now = () =>
      scenario === 'alive-through-kill' || scenario === 'kill-first-eperm'
        ? virtualNow
        : originalDateNow() + 31_000;

    const failure = await failurePromise;
    return {
      dataRootExists: existsSync(dataRoot),
      failure,
      probeCount,
      sigkillDeliveries,
      sigtermDeliveries,
    };
  } finally {
    Date.now = originalDateNow;
    process.kill = originalKill;
    await failurePromise.catch(() => {});
    if (webPid !== undefined) {
      try {
        originalKill(-webPid, 'SIGKILL');
      } catch {}
    }
    if (nanoCorePid !== undefined) {
      try {
        originalKill(nanoCorePid, 'SIGKILL');
      } catch {}
    }
    if (originalMarker === undefined) delete process.env.OPENKIT_TEST_WEB_PID_MARKER;
    else process.env.OPENKIT_TEST_WEB_PID_MARKER = originalMarker;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(harnessRoot, { force: true, recursive: true });
  }
}

test('accepts first-probe EPERM after delivering Web-group SIGTERM', async () => {
  test.setTimeout(45_000);

  const outcome = await runWebGroupPermissionProbeScenario('first-eperm');

  expect(outcome.failure).toBeInstanceOf(Error);
  expect((outcome.failure as Error).message).toContain('Timed out waiting for');
  expect(outcome).toMatchObject({
    dataRootExists: false,
    probeCount: 1,
    sigkillDeliveries: 0,
    sigtermDeliveries: 1,
  });
});

test('accepts Web-group EPERM after a post-TERM liveness probe succeeds', async () => {
  test.setTimeout(45_000);

  const outcome = await runWebGroupPermissionProbeScenario('alive-then-eperm');

  expect(outcome.failure).toBeInstanceOf(Error);
  expect((outcome.failure as Error).message).toContain('Timed out waiting for');
  expect(outcome).toMatchObject({
    dataRootExists: false,
    probeCount: 2,
    sigtermDeliveries: 1,
  });
});

test('rejects teardown when the Web group remains addressable after TERM and KILL', async () => {
  test.setTimeout(45_000);

  const outcome = await runWebGroupPermissionProbeScenario('alive-through-kill');

  expect(outcome.failure).toBeInstanceOf(Error);
  expect(outcome).toMatchObject({
    dataRootExists: true,
    probeCount: 2,
    sigkillDeliveries: 1,
    sigtermDeliveries: 1,
  });
});

test('accepts first-probe EPERM during the Web-group SIGKILL phase', async () => {
  test.setTimeout(45_000);

  const outcome = await runWebGroupPermissionProbeScenario('kill-first-eperm');

  expect(outcome.failure).toBeInstanceOf(Error);
  expect((outcome.failure as Error).message).toContain('Timed out waiting for');
  expect(outcome).toMatchObject({
    dataRootExists: false,
    probeCount: 2,
    sigkillDeliveries: 1,
    sigtermDeliveries: 1,
  });
});

test('cleans NanoCore and its temporary data root when Web startup fails', async () => {
  const harnessRoot = mkdtempSync(join(tmpdir(), 'openkit-web-stack-cleanup-'));
  const fakeBin = join(harnessRoot, 'bin');
  const dataRoot = join(harnessRoot, 'data-root');
  const webStartedMarker = join(harnessRoot, 'web.started');
  const originalPath = process.env.PATH;
  let nanoCorePid: number | undefined;
  mkdirSync(fakeBin);
  mkdirSync(dataRoot);
  writeFileSync(
    join(fakeBin, 'pnpm'),
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(webStartedMarker)}, 'ready');
setTimeout(() => process.exit(23), 2000);
`,
    { mode: 0o700 }
  );
  process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

  const failurePromise = startIsolatedWebStack({
    dataRoot,
    mode: 'local',
    useSimulator: true,
  }).then(
    () => new Error('Web stack unexpectedly started.'),
    (error: unknown) => error
  );

  try {
    const lockDeadline = Date.now() + 30_000;
    while (Date.now() < lockDeadline && nanoCorePid === undefined) {
      const lockPath = join(dataRoot, 'server', 'runtime', 'nanocore.lock');
      // The fake Web child starts only after Core readiness and complete lock publication.
      if (existsSync(webStartedMarker)) {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (Number.isInteger(lock.pid)) nanoCorePid = lock.pid;
      }
      if (nanoCorePid === undefined) await delay(20);
    }

    if (nanoCorePid === undefined) {
      throw new Error('NanoCore did not acquire the temporary data-root lock.');
    }
    const failure = await failurePromise;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Process exited before');

    let nanoCoreAlive = true;
    try {
      process.kill(nanoCorePid, 0);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
        nanoCoreAlive = false;
      } else {
        throw error;
      }
    }
    expect({
      dataRootExists: existsSync(dataRoot),
      nanoCoreAlive,
    }).toEqual({
      dataRootExists: false,
      nanoCoreAlive: false,
    });
  } finally {
    await failurePromise.catch(() => {});
    if (nanoCorePid !== undefined) {
      try {
        process.kill(nanoCorePid, 'SIGTERM');
      } catch {}
      const stopDeadline = Date.now() + 2_000;
      let stopped = false;
      while (!stopped && Date.now() < stopDeadline) {
        try {
          process.kill(nanoCorePid, 0);
          await delay(20);
        } catch {
          stopped = true;
        }
      }
      if (!stopped) {
        try {
          process.kill(nanoCorePid, 'SIGKILL');
        } catch {}
      }
    }
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(harnessRoot, { force: true, recursive: true });
  }
});

test('cleans the temporary data root when NanoCore exits before readiness', async () => {
  const harnessRoot = mkdtempSync(join(tmpdir(), 'openkit-web-core-readiness-cleanup-'));
  const dataRoot = join(harnessRoot, 'data-root');
  const lockDirectory = join(dataRoot, 'server', 'runtime');
  const timestamp = new Date().toISOString();
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(
    join(lockDirectory, 'nanocore.lock'),
    `${JSON.stringify({
      bootId: 'existing-test-holder',
      createdAt: timestamp,
      hostname: hostname(),
      pid: process.pid,
      schemaVersion: 1,
      updatedAt: timestamp,
    })}\n`
  );

  try {
    const failure = await startIsolatedWebStack({
      dataRoot,
      mode: 'local',
      useSimulator: true,
    }).then(
      () => new Error('Web stack unexpectedly started.'),
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Process exited before');
    expect(existsSync(dataRoot)).toBe(false);
  } finally {
    rmSync(harnessRoot, { force: true, recursive: true });
  }
});

test('cleans every stack-owned root when fixture initialization rejects before spawn', async () => {
  const harnessRoot = mkdtempSync(join(tmpdir(), 'openkit-web-pre-spawn-cleanup-'));
  const dataRoot = join(harnessRoot, 'data-root');
  const originalMkdtemp = fsPromises.mkdtemp;
  const originalWriteFile = fsPromises.writeFile;
  const sentinel = Object.assign(new Error('pre-spawn initialization sentinel'), {
    code: 'EACCES',
  });
  let stackRoot: string | undefined;
  // Inject at the surviving fixture write, and observe the actual stack-owned temporary root.
  fsPromises.mkdtemp = (async (...args: Parameters<typeof fsPromises.mkdtemp>) => {
    const root = await originalMkdtemp(...args);
    if (String(args[0]).endsWith('openkit-web-e2e-')) stackRoot = String(root);
    return root;
  }) as typeof fsPromises.mkdtemp;
  fsPromises.writeFile = async (...args) => {
    if (
      String(args[0]) === join(dataRoot, 'config', 'providers', 'agent-openrouter.provider.jsonc')
    ) {
      throw sentinel;
    }
    return originalWriteFile(...args);
  };
  syncBuiltinESMExports();

  try {
    const failure = await startIsolatedWebStack({
      dataRoot,
      mode: 'local',
      useSimulator: true,
    }).then(
      () => new Error('Web stack unexpectedly started.'),
      (error: unknown) => error
    );

    expect(stackRoot, 'Stack-owned temporary root was not created.').toBeDefined();
    expect(failure).toBe(sentinel);
    expect(failure).toMatchObject({ code: 'EACCES' });
    expect((failure as Error).message).toContain('pre-spawn initialization sentinel');
    expect({
      dataRootExists: existsSync(dataRoot),
      stackRootExists: existsSync(stackRoot!),
    }).toEqual({
      dataRootExists: false,
      stackRootExists: false,
    });
  } finally {
    fsPromises.mkdtemp = originalMkdtemp;
    fsPromises.writeFile = originalWriteFile;
    syncBuiltinESMExports();
    rmSync(dataRoot, { force: true, recursive: true });
    if (stackRoot !== undefined) rmSync(stackRoot, { force: true, recursive: true });
    rmSync(harnessRoot, { force: true, recursive: true });
  }
});

test('kills a SIGTERM-ignoring Web child and NanoCore before removing the data root', async () => {
  test.setTimeout(45_000);
  const harnessRoot = mkdtempSync(join(tmpdir(), 'openkit-web-sigterm-cleanup-'));
  const fakeBin = join(harnessRoot, 'bin');
  const dataRoot = join(harnessRoot, 'data-root');
  const webPidMarker = join(harnessRoot, 'web.pid');
  const originalPath = process.env.PATH;
  const originalMarker = process.env.OPENKIT_TEST_WEB_PID_MARKER;
  let nanoCorePid: number | undefined;
  let webPid: number | undefined;
  mkdirSync(fakeBin);
  mkdirSync(dataRoot);
  writeFileSync(
    join(fakeBin, 'pnpm'),
    `#!${process.execPath}
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
writeFileSync(process.env.OPENKIT_TEST_WEB_PID_MARKER, String(process.pid), { flag: 'wx' });
setInterval(() => {}, 1000);
`,
    { mode: 0o700 }
  );
  process.env.OPENKIT_TEST_WEB_PID_MARKER = webPidMarker;
  process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

  const failurePromise = startIsolatedWebStack({
    dataRoot,
    mode: 'local',
    useSimulator: true,
  }).then(
    () => new Error('Web stack unexpectedly started.'),
    (error: unknown) => error
  );

  try {
    const markerDeadline = Date.now() + 30_000;
    while (Date.now() < markerDeadline && webPid === undefined) {
      if (existsSync(webPidMarker)) {
        const candidate = Number(readFileSync(webPidMarker, 'utf8'));
        if (Number.isInteger(candidate)) webPid = candidate;
      }
      // Web startup follows Core readiness and complete lock publication.
      if (webPid !== undefined && nanoCorePid === undefined) {
        const lockPath = join(dataRoot, 'server', 'runtime', 'nanocore.lock');
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (Number.isInteger(lock.pid)) nanoCorePid = lock.pid;
      }
      if (webPid === undefined) await delay(20);
    }

    expect(webPid, 'SIGTERM-ignoring fake Web child did not start.').toBeDefined();
    expect(nanoCorePid, 'NanoCore did not acquire the temporary data-root lock.').toBeDefined();
    const failure = await failurePromise;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Timed out waiting for');

    let nanoCoreAlive = true;
    let webAlive = true;
    try {
      process.kill(nanoCorePid!, 0);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
        nanoCoreAlive = false;
      } else {
        throw error;
      }
    }
    try {
      process.kill(webPid!, 0);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
        webAlive = false;
      } else {
        throw error;
      }
    }
    expect({
      dataRootExists: existsSync(dataRoot),
      nanoCoreAlive,
      webAlive,
    }).toEqual({
      dataRootExists: false,
      nanoCoreAlive: false,
      webAlive: false,
    });
  } finally {
    await failurePromise.catch(() => {});
    for (const pid of [webPid, nanoCorePid]) {
      if (pid === undefined) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    if (originalMarker === undefined) delete process.env.OPENKIT_TEST_WEB_PID_MARKER;
    else process.env.OPENKIT_TEST_WEB_PID_MARKER = originalMarker;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(harnessRoot, { force: true, recursive: true });
  }
});

test('kills a SIGTERM-ignoring Web descendant after its leader exits during failed startup cleanup', async () => {
  test.setTimeout(15_000);
  const harnessRoot = mkdtempSync(join(tmpdir(), 'openkit-web-descendant-cleanup-'));
  const fakeBin = join(harnessRoot, 'bin');
  const dataRoot = join(harnessRoot, 'data-root');
  const descendantPath = join(harnessRoot, 'descendant.mjs');
  const descendantMarker = join(harnessRoot, 'descendant.json');
  const originalPath = process.env.PATH;
  const originalDescendantPath = process.env.OPENKIT_TEST_WEB_DESCENDANT_PATH;
  const originalDescendantMarker = process.env.OPENKIT_TEST_WEB_DESCENDANT_MARKER;
  const originalDateNow = Date.now;
  let descendantPid: number | undefined;
  let leaderPid: number | undefined;
  let nanoCorePid: number | undefined;
  mkdirSync(fakeBin);
  mkdirSync(dataRoot);
  writeFileSync(
    descendantPath,
    `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(
  process.env.OPENKIT_TEST_WEB_DESCENDANT_MARKER,
  JSON.stringify({ descendantPid: process.pid, leaderPid: process.ppid }),
  { flag: 'wx' },
);
setInterval(() => {}, 1000);
`
  );
  writeFileSync(
    join(fakeBin, 'pnpm'),
    `#!${process.execPath}
const { spawn } = require('node:child_process');
spawn(process.execPath, [process.env.OPENKIT_TEST_WEB_DESCENDANT_PATH], {
  env: process.env,
  stdio: 'ignore',
});
setInterval(() => {}, 1000);
`,
    { mode: 0o700 }
  );
  process.env.OPENKIT_TEST_WEB_DESCENDANT_MARKER = descendantMarker;
  process.env.OPENKIT_TEST_WEB_DESCENDANT_PATH = descendantPath;
  process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

  const failurePromise = startIsolatedWebStack({
    dataRoot,
    mode: 'local',
    useSimulator: true,
  }).then(
    () => new Error('Web stack unexpectedly started.'),
    (error: unknown) => error
  );

  try {
    const markerDeadline = Date.now() + 10_000;
    while (Date.now() < markerDeadline && descendantPid === undefined) {
      if (existsSync(descendantMarker)) {
        const marker = JSON.parse(readFileSync(descendantMarker, 'utf8'));
        if (Number.isInteger(marker.descendantPid)) descendantPid = marker.descendantPid;
        if (Number.isInteger(marker.leaderPid)) leaderPid = marker.leaderPid;
      }
      // The descendant marker also follows the ready Core's complete lock publication.
      if (descendantPid !== undefined && nanoCorePid === undefined) {
        const lockPath = join(dataRoot, 'server', 'runtime', 'nanocore.lock');
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (Number.isInteger(lock.pid)) nanoCorePid = lock.pid;
      }
      if (descendantPid === undefined) await delay(20);
    }

    expect(descendantPid, 'SIGTERM-ignoring Web descendant did not start.').toBeDefined();
    expect(leaderPid, 'Fake Web leader id was not observed.').toBeDefined();
    expect(nanoCorePid, 'NanoCore did not acquire the temporary data-root lock.').toBeDefined();
    Date.now = () => originalDateNow() + 31_000;
    const failure = await failurePromise;
    Date.now = originalDateNow;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Timed out waiting for');

    let descendantAlive = true;
    let nanoCoreAlive = true;
    try {
      process.kill(descendantPid!, 0);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
        descendantAlive = false;
      } else {
        throw error;
      }
    }
    try {
      process.kill(nanoCorePid!, 0);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
        nanoCoreAlive = false;
      } else {
        throw error;
      }
    }
    expect({
      dataRootExists: existsSync(dataRoot),
      descendantAlive,
      nanoCoreAlive,
    }).toEqual({
      dataRootExists: false,
      descendantAlive: false,
      nanoCoreAlive: false,
    });
  } finally {
    Date.now = originalDateNow;
    await failurePromise.catch(() => {});
    for (const pid of [descendantPid, leaderPid, nanoCorePid]) {
      if (pid === undefined) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    if (originalDescendantMarker === undefined) {
      delete process.env.OPENKIT_TEST_WEB_DESCENDANT_MARKER;
    } else {
      process.env.OPENKIT_TEST_WEB_DESCENDANT_MARKER = originalDescendantMarker;
    }
    if (originalDescendantPath === undefined) {
      delete process.env.OPENKIT_TEST_WEB_DESCENDANT_PATH;
    } else {
      process.env.OPENKIT_TEST_WEB_DESCENDANT_PATH = originalDescendantPath;
    }
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(harnessRoot, { force: true, recursive: true });
  }
});

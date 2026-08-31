// openkit-test-platform: posix
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './servers.js';

test('restarts Core on the same port and data root before final cleanup', async () => {
  test.setTimeout(45_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const coreUrl = stack.coreUrl;
  const dataRoot = stack.dataRoot;
  const lockPath = join(dataRoot, 'server', 'runtime', 'nanocore.lock');

  try {
    const firstPid = JSON.parse(readFileSync(lockPath, 'utf8')).pid as number;
    await stack.restartCore();
    const secondPid = JSON.parse(readFileSync(lockPath, 'utf8')).pid as number;

    expect(stack.coreUrl).toBe(coreUrl);
    expect(stack.dataRoot).toBe(dataRoot);
    expect(secondPid).not.toBe(firstPid);
    await expect(fetch(`${coreUrl}/api/health`)).resolves.toMatchObject({ ok: true });
  } finally {
    await stack.stop();
  }

  expect(existsSync(dataRoot)).toBe(false);
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
      const lockPath = join(dataRoot, 'server', 'runtime', 'nanocore.lock');
      if (nanoCorePid === undefined && existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (Number.isInteger(lock.pid)) nanoCorePid = lock.pid;
      }
      if (existsSync(webPidMarker)) {
        const candidate = Number(readFileSync(webPidMarker, 'utf8'));
        if (Number.isInteger(candidate)) webPid = candidate;
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
  const originalPath = process.env.PATH;
  let nanoCorePid: number | undefined;
  mkdirSync(fakeBin);
  mkdirSync(dataRoot);
  writeFileSync(join(fakeBin, 'pnpm'), '#!/bin/sh\nsleep 2\nexit 23\n', { mode: 0o700 });
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
      if (existsSync(lockPath)) {
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
  const fakeBin = join(harnessRoot, 'bin');
  const dataRoot = join(harnessRoot, 'data-root');
  const fixtureCwdMarker = join(harnessRoot, 'fixture-cwd');
  const originalMarker = process.env.OPENKIT_TEST_FIXTURE_CWD_MARKER;
  const originalPath = process.env.PATH;
  let stackRoot: string | undefined;
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, 'git'),
    `#!${process.execPath}
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.OPENKIT_TEST_FIXTURE_CWD_MARKER, process.cwd(), { flag: 'wx' });
process.stderr.write('pre-spawn initialization sentinel\\n');
process.exit(37);
`,
    { mode: 0o700 }
  );
  process.env.OPENKIT_TEST_FIXTURE_CWD_MARKER = fixtureCwdMarker;
  process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

  try {
    const failure = await startIsolatedWebStack({
      dataRoot,
      mode: 'local',
      useSimulator: true,
    }).then(
      () => new Error('Web stack unexpectedly started.'),
      (error: unknown) => error
    );

    expect(existsSync(fixtureCwdMarker), 'Fixture Git initialization did not run.').toBe(true);
    stackRoot = dirname(dirname(readFileSync(fixtureCwdMarker, 'utf8')));
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      code: 37,
      stderr: 'pre-spawn initialization sentinel\n',
    });
    expect((failure as Error).message).toContain('pre-spawn initialization sentinel');
    expect({
      dataRootExists: existsSync(dataRoot),
      stackRootExists: existsSync(stackRoot),
    }).toEqual({
      dataRootExists: false,
      stackRootExists: false,
    });
  } finally {
    if (originalMarker === undefined) delete process.env.OPENKIT_TEST_FIXTURE_CWD_MARKER;
    else process.env.OPENKIT_TEST_FIXTURE_CWD_MARKER = originalMarker;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
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
      const lockPath = join(dataRoot, 'server', 'runtime', 'nanocore.lock');
      if (nanoCorePid === undefined && existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (Number.isInteger(lock.pid)) nanoCorePid = lock.pid;
      }
      if (existsSync(webPidMarker)) {
        const candidate = Number(readFileSync(webPidMarker, 'utf8'));
        if (Number.isInteger(candidate)) webPid = candidate;
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
      const lockPath = join(dataRoot, 'server', 'runtime', 'nanocore.lock');
      if (nanoCorePid === undefined && existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (Number.isInteger(lock.pid)) nanoCorePid = lock.pid;
      }
      if (existsSync(descendantMarker)) {
        const marker = JSON.parse(readFileSync(descendantMarker, 'utf8'));
        if (Number.isInteger(marker.descendantPid)) descendantPid = marker.descendantPid;
        if (Number.isInteger(marker.leaderPid)) leaderPid = marker.leaderPid;
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

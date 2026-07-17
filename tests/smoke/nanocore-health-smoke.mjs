import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemoWorkspaceDataRoot } from '../support/demo-data.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Runs the NanoCore built-artifact health smoke check.
 *
 * @returns {Promise<void>} Resolves after the smoke check passes.
 */
async function main() {
  const port = await findOpenPort();
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-nano-smoke-'));
  seedDemoWorkspaceDataRoot(dataRoot);
  const child = spawn(process.execPath, [join(repoRoot, 'apps/nanocore/dist/index.js')], {
    cwd: join(repoRoot, 'apps/nanocore'),
    env: {
      ...process.env,
      OPENKIT_CORE_MODE: 'local',
      OPENKIT_DATA_ROOT: dataRoot,
      OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;

    await waitForHttp(`${baseUrl}/api/health`, child);
    await assertOkJson(`${baseUrl}/api/health`, 'health');
    await assertOkJson(`${baseUrl}/api/meta`, 'meta');
    await assertGoalModeRoutes(baseUrl);
    await assertWorkspacePortabilitySmoke(baseUrl, dataRoot);
    console.log('OpenKit NanoCore built-artifact smoke PASS');
  } finally {
    await stopProcess(child);
    await rm(dataRoot, { force: true, recursive: true });
  }
}

/**
 * Verifies built NanoCore can export from one data root and import into a fresh data root.
 *
 * @param {string} sourceBaseUrl Source NanoCore base URL.
 * @param {string} sourceDataRoot Source NanoCore data root.
 * @returns {Promise<void>} Resolves after export, verification, dry-run, and import pass.
 */
async function assertWorkspacePortabilitySmoke(sourceBaseUrl, sourceDataRoot) {
  const workspaceId = 'ws_demo';
  const knowledge = await postJson(
    `${sourceBaseUrl}/api/workspaces/${workspaceId}/knowledge`,
    'create portability knowledge',
    {
      content: 'Workspace portability smoke knowledge must survive import.',
      kind: 'project-context',
      requestId: randomUUID(),
      title: 'Workspace portability smoke',
    }
  );

  if (knowledge.title !== 'Workspace portability smoke') {
    throw new Error(
      `create portability knowledge returned malformed payload: ${JSON.stringify(knowledge)}.`
    );
  }

  const exported = await postJson(
    `${sourceBaseUrl}/api/app/workspaces/${workspaceId}/export`,
    'export workspace',
    {}
  );

  if (
    exported.workspaceId !== workspaceId ||
    typeof exported.exportId !== 'string' ||
    !Array.isArray(exported.checkedFiles) ||
    !exported.checkedFiles.includes('records/workspace.json')
  ) {
    throw new Error(`export workspace returned malformed payload: ${JSON.stringify(exported)}.`);
  }

  const targetPort = await findOpenPort();
  const targetDataRoot = await mkdtemp(join(tmpdir(), 'openkit-nano-portability-target-'));
  const targetExportRoot = join(
    targetDataRoot,
    'server',
    'exports',
    'workspaces',
    workspaceId,
    exported.exportId
  );
  const targetChild = spawn(process.execPath, [join(repoRoot, 'apps/nanocore/dist/index.js')], {
    cwd: join(repoRoot, 'apps/nanocore'),
    env: {
      ...process.env,
      OPENKIT_CORE_MODE: 'local',
      OPENKIT_DATA_ROOT: targetDataRoot,
      OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1',
      PORT: String(targetPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await mkdir(dirname(targetExportRoot), { recursive: true });
  await cp(
    join(sourceDataRoot, 'server', 'exports', 'workspaces', workspaceId, exported.exportId),
    targetExportRoot,
    { recursive: true }
  );

  try {
    const targetBaseUrl = `http://127.0.0.1:${targetPort}`;

    await waitForHttp(`${targetBaseUrl}/api/health`, targetChild);

    const dryRun = await postJson(
      `${targetBaseUrl}/api/app/workspace-imports/dry-run`,
      'dry-run workspace import',
      {
        exportId: exported.exportId,
        sourceWorkspaceId: workspaceId,
      }
    );

    if (dryRun.exportedWorkspaceId !== workspaceId || dryRun.verification?.fileCount < 4) {
      throw new Error(
        `dry-run workspace import returned malformed payload: ${JSON.stringify(dryRun)}.`
      );
    }

    const imported = await postJson(
      `${targetBaseUrl}/api/app/workspace-imports`,
      'import workspace',
      {
        exportId: exported.exportId,
        requestId: randomUUID(),
        sourceWorkspaceId: workspaceId,
      }
    );

    if (
      typeof imported.importedWorkspaceId !== 'string' ||
      imported.workspace?.importedFrom?.sourceWorkspaceId !== workspaceId
    ) {
      throw new Error(`import workspace returned malformed payload: ${JSON.stringify(imported)}.`);
    }

    const importedKnowledge = await assertOkJson(
      `${targetBaseUrl}/api/workspaces/${imported.importedWorkspaceId}/knowledge`,
      'imported workspace knowledge'
    );

    if (
      !Array.isArray(importedKnowledge.items) ||
      !importedKnowledge.items.some((entry) => entry.title === 'Workspace portability smoke')
    ) {
      throw new Error(
        `imported workspace knowledge was not preserved: ${JSON.stringify(importedKnowledge)}.`
      );
    }
  } finally {
    await stopProcess(targetChild);
    await rm(targetDataRoot, { force: true, recursive: true });
  }
}

/**
 * Verifies that built Goal Mode routes and read models boot without providers.
 *
 * @param {string} baseUrl NanoCore base URL.
 * @returns {Promise<void>} Resolves after Goal Mode smoke checks pass.
 */
async function assertGoalModeRoutes(baseUrl) {
  const workspaceId = 'ws_demo';
  const thread = await postJson(
    `${baseUrl}/api/workspaces/${workspaceId}/threads`,
    'create thread',
    {
      name: 'Goal Mode smoke',
      requestId: randomUUID(),
    }
  );

  if (typeof thread.id !== 'string' || !thread.id.startsWith('th_')) {
    throw new Error('create thread route returned a malformed thread id.');
  }

  const threadId = thread.id;
  const goalRoute = `${baseUrl}/api/app/workspaces/${workspaceId}/threads/${threadId}/goal`;
  const started = await postJson(goalRoute, 'start goal', {
    objective: 'Confirm Goal Mode built-artifact smoke coverage.',
    title: 'Goal Mode smoke',
  });

  assertGoalStatus(started, 'planning', 'start goal');

  const planned = await postJson(`${goalRoute}/plan`, 'create goal plan', {
    requestId: randomUUID(),
  });

  assertGoalStatus(planned, 'awaiting_plan_approval', 'create goal plan');

  if (
    typeof planned.planItemId !== 'string' ||
    typeof planned.plan !== 'object' ||
    planned.plan === null
  ) {
    throw new Error('create goal plan route returned a malformed plan payload.');
  }

  const approved = await postJson(`${goalRoute}/plan/approve`, 'approve goal plan', {
    requestId: randomUUID(),
    planItemId: planned.planItemId,
  });

  assertGoalStatus(approved, 'running', 'approve goal plan');

  const summary = await assertOkJson(goalRoute, 'goal summary');

  assertGoalStatus(summary, 'running', 'goal summary');

  const supervised = await postJson(
    `${goalRoute}/test/supervise/step`,
    'test supervise goal step',
    {}
  );

  assertGoalStatus(supervised, 'completed', 'test supervise goal step');
}

/**
 * Verifies that one URL responds with successful JSON.
 *
 * @param {string} url URL to fetch.
 * @param {string} label Human-readable assertion label.
 * @returns {Promise<Record<string, unknown>>} Parsed JSON response.
 * @throws {Error} When the endpoint fails or returns non-JSON.
 */
async function assertOkJson(url, label) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${label} endpoint returned ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

/**
 * Posts JSON to one route and returns its JSON response.
 *
 * @param {string} url URL to fetch.
 * @param {string} label Human-readable assertion label.
 * @param {Record<string, unknown>} body Request body.
 * @returns {Promise<Record<string, unknown>>} Parsed JSON response.
 * @throws {Error} When the endpoint fails or returns non-JSON.
 */
async function postJson(url, label, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${label} route returned ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

/**
 * Asserts that a Goal Mode route response contains the expected goal status.
 *
 * @param {Record<string, unknown>} payload Route payload.
 * @param {string} expectedStatus Expected goal status.
 * @param {string} label Human-readable assertion label.
 * @returns {void}
 * @throws {Error} When the response has no matching goal status.
 */
function assertGoalStatus(payload, expectedStatus, label) {
  const goal = payload.goal;

  if (
    typeof goal !== 'object' ||
    goal === null ||
    !('status' in goal) ||
    goal.status !== expectedStatus
  ) {
    throw new Error(`${label} route returned goal status ${JSON.stringify(goal)}.`);
  }
}

/**
 * Waits until an HTTP URL returns a successful status.
 *
 * @param {string} url URL to poll.
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child Process to monitor.
 * @returns {Promise<void>} Resolves once the URL is reachable.
 * @throws {Error} When the process exits or the deadline is reached.
 */
async function waitForHttp(url, child) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Process exited before ${url} became ready: ${child.exitCode}.`);
    }

    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      await sleep(100);
    }
  }

  throw new Error(`Timed out waiting for ${url}.`);
}

/**
 * Stops one spawned child process.
 *
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child Process to stop.
 * @returns {Promise<void>} Resolves once the process exits or is killed.
 */
async function stopProcess(child) {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    sleep(2_000).then(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

/**
 * Finds one available localhost TCP port.
 *
 * @returns {Promise<number>} Available port.
 */
async function findOpenPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (typeof address !== 'object' || address === null) {
        server.close(() => reject(new Error('Could not allocate a TCP port.')));
        return;
      }

      server.close(() => resolvePort(address.port));
    });
  });
}

/**
 * Resolves after a delay.
 *
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

await main();

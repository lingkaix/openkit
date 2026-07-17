#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemoWorkspaceDataRoot } from '../../tests/support/demo-data.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const nanoCoreDist = join(repoRoot, 'apps/nanocore/dist/index.js');
const mcpDist = join(repoRoot, 'mcp/dist/index.js');
const requestIds = {
  workspace: randomUUID(),
  repository: randomUUID(),
  thread: randomUUID(),
  goalStart: randomUUID(),
  plan: randomUUID(),
  planApprove: randomUUID(),
  step: randomUUID(),
  approval: randomUUID(),
  question: randomUUID(),
};
const smokeObjective =
  process.env.OPENKIT_MCP_SMOKE_OBJECTIVE ?? 'Run one deterministic OpenKit MCP smoke task.';

/**
 * Fails the smoke script when a required build output is missing.
 *
 * @param {string} filePath Build output path.
 * @returns {void}
 */
function assertBuilt(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required build output is missing: ${filePath}`);
  }
}

/**
 * Allocates an available local TCP port.
 *
 * @returns {Promise<number>} Free localhost port.
 */
async function findOpenPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address !== 'object') {
        reject(new Error('Failed to allocate a local port.'));
        return;
      }

      server.close(() => resolvePort(address.port));
    });
  });
}

/**
 * Waits until one NanoCore endpoint responds to `/api/health`.
 *
 * @param {string} baseUrl NanoCore base URL.
 * @param {ReturnType<typeof spawn> | null} child Spawned NanoCore process, when owned.
 * @returns {Promise<void>}
 */
async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`NanoCore exited before health check passed: ${child.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);

      if (response.ok) {
        return;
      }
    } catch {
      await sleep(100);
    }
  }

  throw new Error('Timed out waiting for NanoCore health check.');
}

/**
 * Sleeps for the requested number of milliseconds.
 *
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>}
 */
async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Stops one spawned process.
 *
 * @param {ReturnType<typeof spawn> | null} child Process to stop.
 * @returns {Promise<void>}
 */
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) {
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
 * Creates a JSON-RPC client over the MCP process stdio.
 *
 * @param {ReturnType<typeof spawn>} child Spawned MCP process.
 * @returns {{ call(method: string, params?: unknown): Promise<unknown> }}
 */
function createMcpClient(child) {
  let nextId = 1;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const pending = new Map();
  const requestTimeoutMs = Number(process.env.OPENKIT_MCP_SMOKE_MCP_TIMEOUT_MS ?? 20_000);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const message = JSON.parse(line);
      const deferred = pending.get(message.id);

      if (!deferred) {
        continue;
      }

      clearTimeout(deferred.timeout);
      pending.delete(message.id);

      if (message.error) {
        deferred.reject(new Error(message.error.message));
      } else {
        deferred.resolve(message.result);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;
  });
  child.on('exit', (code) => {
    for (const deferred of pending.values()) {
      clearTimeout(deferred.timeout);
      deferred.reject(new Error(`MCP process exited with ${code}: ${stderrBuffer}`));
    }
    pending.clear();
  });

  return {
    call(method, params) {
      const id = nextId++;

      return new Promise((resolveCall, rejectCall) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error(`Timed out waiting for MCP response to ${method}`));
        }, requestTimeoutMs);
        pending.set(id, { resolve: resolveCall, reject: rejectCall, timeout });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

/**
 * Reads the one-time bootstrap token emitted by an owned server-mode NanoCore.
 *
 * @param {string} root NanoCore data root.
 * @returns {string} Plaintext bootstrap token.
 */
function readBootstrapToken(root) {
  const filePath = join(root, 'server', 'files', 'auth', 'bootstrap-token.txt');
  const stats = statSync(filePath);

  assert((stats.mode & 0o077) === 0, 'Bootstrap token file was not owner-only.');

  const content = readFileSync(filePath, 'utf8');
  const match = /^Token:\s*(okt_[A-Za-z0-9_-]+)$/m.exec(content);

  assert(match, 'Bootstrap token file did not contain a token line.');

  return match[1];
}

/**
 * Posts JSON to one HTTP endpoint.
 *
 * @param {string} url Request URL.
 * @param {Record<string, unknown>} body JSON body.
 * @param {{ bearer?: string } | undefined} auth Optional auth material.
 * @returns {Promise<Response>} Raw response.
 */
async function postJson(url, body, auth) {
  const origin = new URL(url).origin;

  return await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      ...(auth?.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * Creates a workspace and scoped MCP token through public NanoCore routes.
 *
 * @param {string} baseUrl NanoCore base URL.
 * @param {string} adminToken Server-admin token.
 * @returns {Promise<{ token: string, workspaceId: string }>} Scoped MCP auth context.
 */
async function createWorkspaceScopedToken(baseUrl, adminToken) {
  const workspace = await postJson(
    `${baseUrl}/api/workspaces`,
    {
      name: 'OpenKit MCP server smoke',
      requestId: requestIds.workspace,
    },
    { bearer: adminToken }
  );

  if (workspace.status !== 201) {
    throw new Error(
      `Server workspace creation failed with ${workspace.status}: ${await workspace.text()}`
    );
  }

  const workspaceBody = await workspace.json();
  assert(
    typeof workspaceBody.id === 'string' && workspaceBody.id.length > 0,
    'Server workspace id was not returned.'
  );

  const token = await postJson(
    `${baseUrl}/api/app/auth/tokens`,
    {
      scope: 'workspace',
      workspaceIds: [workspaceBody.id],
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
    { bearer: adminToken }
  );

  if (token.status !== 201) {
    throw new Error(`Server token creation failed with ${token.status}: ${await token.text()}`);
  }

  const tokenBody = await token.json();
  assert(typeof tokenBody.token === 'string' && tokenBody.token.length > 0, 'Token was missing.');

  return { token: tokenBody.token, workspaceId: workspaceBody.id };
}

/**
 * Consumes the owned NanoCore bootstrap token and prepares scoped MCP auth.
 *
 * @param {string} baseUrl NanoCore base URL.
 * @param {string} root NanoCore data root.
 * @returns {Promise<{ token: string, workspaceId: string }>} Server auth context.
 */
async function createOwnedServerAuthContext(baseUrl, root) {
  const bootstrapToken = readBootstrapToken(root);
  const consumed = await postJson(`${baseUrl}/api/app/auth/bootstrap/consume`, {
    token: bootstrapToken,
    ownerUserId: `user_mcp_smoke_${Date.now()}`,
    displayName: 'OpenKit MCP Smoke',
    tokenExpiresAt: '2999-01-01T00:00:00.000Z',
  });

  if (consumed.status !== 201) {
    throw new Error(
      `Server bootstrap consume failed with ${consumed.status}: ${await consumed.text()}`
    );
  }

  const consumedBody = await consumed.json();
  assert(
    typeof consumedBody.token === 'string' && consumedBody.token.length > 0,
    'Server bootstrap consume did not return an admin token.'
  );

  return await createWorkspaceScopedToken(baseUrl, consumedBody.token);
}

/**
 * Calls one OpenKit MCP tool and returns structured content.
 *
 * @param {{ call(method: string, params?: unknown): Promise<unknown> }} mcp MCP JSON-RPC client.
 * @param {string} name Tool name.
 * @param {unknown} args Tool arguments.
 * @returns {Promise<Record<string, unknown>>} Tool structured content.
 */
async function callTool(mcp, name, args) {
  const result = await mcp.call('tools/call', { name, arguments: args }).catch((error) => {
    throw new Error(`${name} failed: ${error.message}`);
  });
  return result.structuredContent;
}

/**
 * Ensures the smoke script saw a truthy condition.
 *
 * @param {unknown} condition Condition to assert.
 * @param {string} message Failure message.
 * @returns {void}
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

let nanoCore = null;
let mcpProcess = null;
let dataRoot = null;

try {
  assertBuilt(nanoCoreDist);
  assertBuilt(mcpDist);

  const externalBaseUrl = process.env.OPENKIT_MCP_SMOKE_NANOCORE_URL;
  const port = externalBaseUrl ? null : await findOpenPort();
  const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${port}`;
  dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mcp-smoke-'));
  const coreMode = process.env.OPENKIT_MCP_SMOKE_CORE_MODE ?? 'local';
  const configuredRepositoryPath = process.env.OPENKIT_MCP_SMOKE_REPOSITORY;
  const remoteRepositoryPath = process.env.OPENKIT_MCP_SMOKE_REMOTE_REPOSITORY;
  const configuredWorkspaceId =
    process.env.OPENKIT_MCP_SMOKE_WORKSPACE_ID ?? process.env.OPENKIT_WORKSPACE_ID;
  const repositoryPath = configuredRepositoryPath ?? join(dataRoot, 'repository');
  const nanoCoreRepositoryPath = remoteRepositoryPath ?? repositoryPath;

  assert(
    coreMode === 'local' || coreMode === 'server',
    `Unsupported OPENKIT_MCP_SMOKE_CORE_MODE: ${coreMode}`
  );

  if (!configuredRepositoryPath && !remoteRepositoryPath) {
    mkdirSync(repositoryPath, { recursive: true });
    const git = spawnSync('git', ['init', repositoryPath], { stdio: 'ignore' });
    assert(git.status === 0, 'Failed to initialize temporary git repository.');
  }

  if (!remoteRepositoryPath) {
    assert(
      existsSync(join(repositoryPath, '.git')),
      `Smoke repository must be a git checkout: ${repositoryPath}`
    );
  }

  if (!externalBaseUrl) {
    if (coreMode === 'local') {
      seedDemoWorkspaceDataRoot(dataRoot);
    }

    nanoCore = spawn(process.execPath, [nanoCoreDist], {
      cwd: join(repoRoot, 'apps/nanocore'),
      env: {
        ...process.env,
        ...(coreMode === 'server'
          ? { BETTER_AUTH_TRUSTED_ORIGINS: baseUrl, BETTER_AUTH_URL: baseUrl }
          : {}),
        OPENKIT_CORE_MODE: coreMode,
        OPENKIT_DATA_ROOT: dataRoot,
        OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1',
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  await waitForHealth(baseUrl, nanoCore);
  const externalServerAuth =
    coreMode === 'server' && externalBaseUrl && process.env.OPENKIT_NANOCORE_TOKEN
      ? {
          token: process.env.OPENKIT_NANOCORE_TOKEN,
          workspaceId: configuredWorkspaceId,
        }
      : null;
  if (coreMode === 'server' && externalBaseUrl && !externalServerAuth?.workspaceId) {
    throw new Error(
      'External server-mode smoke requires OPENKIT_NANOCORE_TOKEN and OPENKIT_MCP_SMOKE_WORKSPACE_ID.'
    );
  }

  const serverAuth =
    coreMode === 'server'
      ? (externalServerAuth ?? (await createOwnedServerAuthContext(baseUrl, dataRoot)))
      : null;
  const workspaceId = serverAuth?.workspaceId ?? 'ws_demo';

  mcpProcess = spawn(process.execPath, [mcpDist], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(serverAuth ? { OPENKIT_NANOCORE_TOKEN: serverAuth.token } : {}),
      OPENKIT_NANOCORE_URL: baseUrl,
      OPENKIT_REPO_ROOT: repoRoot,
      OPENKIT_WORKSPACE_ID: workspaceId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const mcp = createMcpClient(mcpProcess);
  await mcp.call('initialize', { protocolVersion: '2025-06-18' });
  const toolList = await mcp.call('tools/list');
  assert(
    toolList.tools.some((tool) => tool.name === 'openkit.step_goal'),
    'MCP tools/list did not include openkit.step_goal.'
  );
  assert(
    !toolList.tools.some((tool) => tool.name === 'openkit.create_evidence_bundle'),
    'MCP tools/list still exposed the removed openkit.create_evidence_bundle tool.'
  );

  await callTool(mcp, 'openkit.read_status', { workspaceId });
  const runtimeDiagnostics = await callTool(mcp, 'openkit.read_runtime_diagnostics', {});
  assert(
    runtimeDiagnostics.raw.runtimeConfig?.currentVersion,
    'Runtime diagnostics did not include runtime config status.'
  );
  await callTool(mcp, 'openkit.link_repository', {
    workspaceId,
    displayName: 'Smoke repository',
    localPath: nanoCoreRepositoryPath,
    requestId: requestIds.repository,
  });
  const repositories = await callTool(mcp, 'openkit.read_repositories', {
    workspaceId,
  });
  assert(
    repositories.raw.diagnostics.defaultResource.ready === true,
    'Repository diagnostics did not become ready.'
  );

  const thread = await callTool(mcp, 'openkit.create_thread', {
    workspaceId,
    title: 'OpenKit MCP smoke',
    requestId: requestIds.thread,
  });
  const threadId = thread.raw.id;
  assert(typeof threadId === 'string' && threadId.length > 0, 'Thread id was not returned.');

  await callTool(mcp, 'openkit.read_thread', { workspaceId, threadId });
  await callTool(mcp, 'openkit.start_goal', {
    workspaceId,
    threadId,
    objective: smokeObjective,
    requestId: requestIds.goalStart,
  });
  const plan = await callTool(mcp, 'openkit.draft_goal_plan', {
    workspaceId,
    threadId,
    requestId: requestIds.plan,
  });
  assert(plan.raw.planItemId, 'Plan item id was not returned.');
  await callTool(mcp, 'openkit.approve_goal_plan', {
    workspaceId,
    threadId,
    planItemId: plan.raw.planItemId,
    requestId: requestIds.planApprove,
  });
  const step = await callTool(mcp, 'openkit.step_goal', {
    workspaceId,
    threadId,
    requestId: requestIds.step,
  });
  assert(step.raw.result.turnId, 'Worker turn id was not returned.');

  let goal = await callTool(mcp, 'openkit.read_goal', { workspaceId, threadId });
  let actionCenter = await callTool(mcp, 'openkit.read_action_center', {
    workspaceId,
  });
  const approvalRow = actionCenter.raw.items.find((item) => item.source.type === 'approval');
  let resolvedApproval = false;
  let answeredQuestion = false;

  if (approvalRow) {
    const grantAction = approvalRow.actions.find((action) => action.kind === 'grant_approval');
    assert(grantAction, 'Approval row did not expose grant_approval.');
    await callTool(mcp, 'openkit.resolve_action_center_item', {
      workspaceId,
      rowId: approvalRow.id,
      actionId: grantAction.kind,
      decision: 'granted',
      requestId: requestIds.approval,
    });
    resolvedApproval = true;
  }

  actionCenter = await callTool(mcp, 'openkit.read_action_center', {
    workspaceId,
  });
  const questionRow = actionCenter.raw.items.find(
    (item) => item.source.type === 'protocol_item' && item.source.itemType === 'user-input-request'
  );

  if (questionRow) {
    const answerAction = questionRow.actions.find((action) => action.kind === 'answer_question');
    assert(answerAction, 'Question row did not expose answer_question.');
    await callTool(mcp, 'openkit.resolve_action_center_item', {
      workspaceId,
      rowId: questionRow.id,
      actionId: answerAction.kind,
      decision: 'answer_question',
      comment: 'Continue the deterministic smoke and produce review evidence.',
      requestId: requestIds.question,
    });
    answeredQuestion = true;
  }

  goal = await callTool(mcp, 'openkit.read_goal', { workspaceId, threadId });
  actionCenter = await callTool(mcp, 'openkit.read_action_center', {
    workspaceId,
  });
  const workspaceReviews = await callTool(mcp, 'openkit.read_workspace_reviews', {
    workspaceId,
  });
  const evidenceResource = await mcp.call('resources/read', {
    uri: `openkit://workspaces/${workspaceId}/evidence-bundles`,
  });
  const evidenceText = evidenceResource.contents?.[0]?.text;
  assert(typeof evidenceText === 'string', 'Evidence resource did not return JSON text.');
  const evidence = JSON.parse(evidenceText);
  assert(
    Array.isArray(evidence.evidenceBundles),
    'Evidence resource did not return a bundle list.'
  );
  const artifactId = step.raw.result.evidence.artifactIds[0] ?? null;
  const artifact = artifactId
    ? await callTool(mcp, 'openkit.read_artifact', { workspaceId, artifactId })
    : null;

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        baseUrl,
        coreMode,
        externalNanoCore: externalBaseUrl !== undefined,
        repositoryMode:
          configuredRepositoryPath || remoteRepositoryPath ? 'configured' : 'temporary',
        serverAuthenticated: serverAuth !== null,
        workspaceId,
        threadId,
        goalStatus: goal.raw.goal?.status ?? null,
        actionCenterItems: actionCenter.raw.items.length,
        workspaceReviews: workspaceReviews.raw.items?.length ?? null,
        runtimeDiagnostics: true,
        resolvedApproval,
        answeredQuestion,
        evidenceBundles: evidence.evidenceBundles.length,
        artifactRead: artifact !== null,
        tools: toolList.tools.length,
      },
      null,
      2
    )
  );
} finally {
  await stopProcess(mcpProcess);
  await stopProcess(nanoCore);

  if (dataRoot) {
    rmSync(dataRoot, { force: true, recursive: true });
  }
}

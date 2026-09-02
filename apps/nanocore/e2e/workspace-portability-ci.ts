import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  seedDemoWorkspaceAuthority,
  seedDemoWorkspaceDataRoot,
} from '../../../tests/support/demo-data.mjs';
import {
  type NanoCoreHarness,
  readTurnEventsUntil,
  removeDataRoot,
  startNanoCoreHarness,
} from './_lib/harness.js';

const ARCHIVE_FILE = 'workspace.openkit-workspace.tar.zst';
const DIGEST_FILE = `${ARCHIVE_FILE}.sha256`;
const SEMANTICS_FILE = 'source-semantics.json';
const WORKSPACE_ID = 'ws_demo';
const KNOWLEDGE_TITLE = 'CI workspace portability knowledge';
const VAULT_REFERENCE_ID = 'vault_portability_ci';
const cliPath = fileURLToPath(new URL('../../../skills/openkit/scripts/openkit', import.meta.url));

type CliEnvelope = {
  ok: true;
  data: Record<string, unknown>;
};

type SemanticSnapshot = {
  knowledge: unknown[];
  threads: unknown[];
  workspace: unknown;
};

const [mode, artifactDir] = process.argv.slice(2);

if ((mode !== 'source' && mode !== 'target') || !artifactDir) {
  throw new Error('Usage: workspace-portability-ci.ts <source|target> <artifact-directory>');
}

await mkdir(artifactDir, { recursive: true });

if (mode === 'source') {
  await runSource(artifactDir);
} else {
  await runTarget(artifactDir);
}

/** Produces one portable archive and its source semantic oracle through public product surfaces. */
async function runSource(outputDir: string): Promise<void> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-portability-source-'));
  const repositoryRoot = await createGitRepository('openkit-portability-source-repository-');
  let harness: NanoCoreHarness | null = null;

  try {
    seedDemoWorkspaceDataRoot(dataRoot);
    await seedDemoWorkspaceAuthority(dataRoot);
    await seedSourceHistory(dataRoot);
    await seedSourceVaultReference(dataRoot);
    harness = await startNanoCoreHarness({ dataRoot, seedDemoWorkspace: false });

    const linked = await runCli(harness.baseUrl, 'repository.set-default', {
      displayName: 'Source portability repository',
      localPath: repositoryRoot,
      workspaceId: WORKSPACE_ID,
    });
    assert.equal(readPath(linked.data, 'repository', 'diagnosticsStatus'), 'ready');
    const sourceReferences = await runCli(harness.baseUrl, 'vault.reference-list', {
      workspaceId: WORKSPACE_ID,
    });
    assert.equal(readPath(sourceReferences.data, 'items', 0, 'status'), 'active');

    await runCli(harness.baseUrl, 'knowledge-entry.create', {
      content: 'The fixed two-job artifact transfer preserves authoritative knowledge.',
      kind: 'project-context',
      requestId: randomUUID(),
      title: KNOWLEDGE_TITLE,
      workspaceId: WORKSPACE_ID,
    });
    const sourceSemantics = await readSemanticSnapshot(harness.baseUrl, WORKSPACE_ID);
    const serializedSemantics = `${JSON.stringify(sourceSemantics, null, 2)}\n`;
    assert(!serializedSemantics.includes(dataRoot));
    assert(!serializedSemantics.includes(repositoryRoot));

    const exported = await runCli(harness.baseUrl, 'workspace.export', {
      workspaceId: WORKSPACE_ID,
    });
    const exportId = requiredString(exported.data.exportId, 'Workspace export id');
    const archivePath = join(outputDir, ARCHIVE_FILE);
    await runCli(harness.baseUrl, 'workspace.archive-download', {
      destinationPath: archivePath,
      exportId,
      workspaceId: WORKSPACE_ID,
    });
    const archive = await readFile(archivePath);
    const digest = createHash('sha256').update(archive).digest('hex');

    assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
    await writeFile(join(outputDir, DIGEST_FILE), `${digest}  ${ARCHIVE_FILE}\n`, {
      mode: 0o600,
    });
    await writeFile(join(outputDir, SEMANTICS_FILE), serializedSemantics, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ archiveSha256: digest, mode, status: 'ok' })}\n`);
  } finally {
    if (harness) {
      await stopHarness(harness);
    } else {
      await removeDataRoot(dataRoot);
    }
    await rm(repositoryRoot, { force: true, recursive: true });
  }
}

/** Imports the transferred archive on a fresh target and proves semantics plus explicit re-binding. */
async function runTarget(inputDir: string): Promise<void> {
  const archivePath = join(inputDir, ARCHIVE_FILE);
  const expectedDigest = (await readFile(join(inputDir, DIGEST_FILE), 'utf8')).split(/\s+/)[0];
  const actualDigest = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');
  const sourceSemantics = JSON.parse(
    await readFile(join(inputDir, SEMANTICS_FILE), 'utf8')
  ) as SemanticSnapshot;
  const repositoryRoot = await createGitRepository('openkit-portability-target-repository-');
  const fakeVaultMaterial = Buffer.from('openkit-portability-ci-fake-secret', 'utf8');
  let harness: NanoCoreHarness | null = null;

  assert.equal(actualDigest, expectedDigest);

  try {
    harness = await startNanoCoreHarness({ seedDemoWorkspace: false });
    const dryRun = await runCli(harness.baseUrl, 'workspace.archive-import-dry-run', {
      sourcePath: archivePath,
    });
    assert.equal(dryRun.data.mode, 'dry-run');
    assert.deepEqual(dryRun.data.collision, { status: 'available', workspaceId: WORKSPACE_ID });

    const imported = await runCli(harness.baseUrl, 'workspace.archive-import', {
      requestId: randomUUID(),
      sourcePath: archivePath,
    });
    const importedWorkspaceId = requiredString(
      imported.data.importedWorkspaceId,
      'Imported Workspace id'
    );
    assert.equal(importedWorkspaceId, WORKSPACE_ID);
    assert.deepEqual(
      await readSemanticSnapshot(harness.baseUrl, importedWorkspaceId),
      sourceSemantics
    );

    const importedRepositories = await runCli(harness.baseUrl, 'repository.list', {
      workspaceId: importedWorkspaceId,
    });
    assert.equal(readPath(importedRepositories.data, 'items', 0, 'diagnosticsStatus'), 'missing');
    assert(
      !JSON.stringify(importedRepositories).includes('openkit-portability-source-repository-')
    );

    const reboundRepository = await runCli(harness.baseUrl, 'repository.set-default', {
      displayName: 'Target portability repository',
      localPath: repositoryRoot,
      workspaceId: importedWorkspaceId,
    });
    assert.equal(readPath(reboundRepository.data, 'repository', 'diagnosticsStatus'), 'ready');

    const importedReferences = await runCli(harness.baseUrl, 'vault.reference-list', {
      workspaceId: importedWorkspaceId,
    });
    assert.equal(readPath(importedReferences.data, 'items', 0, 'status'), 'unbound');
    const referenceId = requiredString(
      readPath(importedReferences.data, 'items', 0, 'referenceId'),
      'Imported Vault reference id'
    );
    const masterKeyBase64 = Buffer.alloc(32, 7).toString('base64');
    const unlocked = await runCli(harness.baseUrl, 'vault.unlock', { masterKeyBase64 });
    const reboundReference = await runCli(harness.baseUrl, 'vault.reference-rebind', {
      materialBase64: fakeVaultMaterial.toString('base64'),
      referenceId,
      workspaceId: importedWorkspaceId,
    });
    assert.equal(readPath(reboundReference.data, 'status'), 'active');
    assert(!unlocked.raw.includes(masterKeyBase64));
    assert(!reboundReference.raw.includes(fakeVaultMaterial.toString('base64')));
    assert(!reboundReference.raw.includes(fakeVaultMaterial.toString('utf8')));

    await runCli(harness.baseUrl, 'knowledge-entry.create', {
      content: 'Target behavior remains writable after explicit local resource re-binding.',
      kind: 'task-summary',
      requestId: randomUUID(),
      title: 'Target portability continuation',
      workspaceId: importedWorkspaceId,
    });

    const reExported = await runCli(harness.baseUrl, 'workspace.export', {
      workspaceId: importedWorkspaceId,
    });
    const reExportPath = join(inputDir, 'target-reexport.openkit-workspace.tar.zst');
    await runCli(harness.baseUrl, 'workspace.archive-download', {
      destinationPath: reExportPath,
      exportId: requiredString(reExported.data.exportId, 'Target export id'),
      workspaceId: importedWorkspaceId,
    });
    const reExportDryRun = await runCli(harness.baseUrl, 'workspace.archive-import-dry-run', {
      sourcePath: reExportPath,
    });
    assert.equal(reExportDryRun.data.mode, 'dry-run');
    assert.deepEqual(reExportDryRun.data.collision, {
      suggestedWorkspaceId: `ws_imported_${importedWorkspaceId}`,
      status: 'collides',
      workspaceId: importedWorkspaceId,
    });

    process.stdout.write(
      `${JSON.stringify({ archiveSha256: actualDigest, importedWorkspaceId, mode, status: 'ok' })}\n`
    );
  } finally {
    await stopHarness(harness);
    await rm(repositoryRoot, { force: true, recursive: true });
  }
}

/** Seeds one deterministic completed Turn through the existing canonical store owner. */
async function seedSourceHistory(dataRoot: string): Promise<void> {
  const { FsStore } = await import('../dist/lib/store.js');
  const store = new FsStore({ dataRoot });
  const actor = { id: 'user_local', kind: 'user' } as const;
  const startedAt = '2026-09-02T00:00:00.000Z';
  const completedAt = '2026-09-02T00:00:01.000Z';
  const turn = store.createTurn(
    WORKSPACE_ID,
    'th_demo',
    'Preserve this complete source Turn history across the portable archive.',
    actor,
    null,
    { startedAt, turnId: 'tu_portability_ci' }
  );
  const userItem = store.createItem({
    actor,
    completedAt: startedAt,
    createdAt: startedAt,
    id: 'it_portability_ci_user',
    status: 'completed',
    text: 'Preserve this complete source Turn history across the portable archive.',
    threadId: 'th_demo',
    turnId: turn.id,
    type: 'user-message',
    workspaceId: WORKSPACE_ID,
  });
  const assistantItem = store.createItem({
    completedAt,
    createdAt: completedAt,
    id: 'it_portability_ci_assistant',
    status: 'completed',
    text: 'Portable history is ready for transfer.',
    threadId: 'th_demo',
    turnId: turn.id,
    type: 'assistant-message',
    workspaceId: WORKSPACE_ID,
  });

  for (const item of [userItem, assistantItem]) {
    store.emitTurnEvent(turn.id, {
      data: { item, itemId: item.id, type: 'item-completed' },
      event: 'item.completed',
      requestId: '00000000-0000-4000-8000-00000000c801',
      threadId: 'th_demo',
      turnId: turn.id,
      workspaceId: WORKSPACE_ID,
    });
  }
  const completed = store.updateTurn(turn.id, { completedAt, status: 'completed' });
  store.emitTurnEvent(turn.id, {
    data: { stopReason: 'completed', turn: completed, type: 'turn-completed' },
    event: 'turn.completed',
    requestId: '00000000-0000-4000-8000-00000000c801',
    threadId: 'th_demo',
    turnId: turn.id,
    workspaceId: WORKSPACE_ID,
  });
}

/** Seeds one source-bound non-secret Vault reference before the isolated server starts. */
async function seedSourceVaultReference(dataRoot: string): Promise<void> {
  const [{ openCoreDb }, { createVaultReference }] = await Promise.all([
    import('../dist/storage/db.js'),
    import('../dist/vault/vault-references.js'),
  ]);
  const coreDb = openCoreDb(dataRoot);

  try {
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: `encrypted-file://workspace/${WORKSPACE_ID}/vault/${VAULT_REFERENCE_ID}`,
      displayName: 'Portable CI fake credential',
      ownerScope: 'workspace',
      referenceId: VAULT_REFERENCE_ID,
      secretKind: 'api-token',
      workspaceId: WORKSPACE_ID,
    });
  } finally {
    coreDb.sqlite.close();
  }
}

/** Reads the complete public Workspace history and authoritative knowledge as a remint-neutral graph. */
async function readSemanticSnapshot(
  baseUrl: string,
  workspaceId: string
): Promise<SemanticSnapshot> {
  const workspace = await getJson(`${baseUrl}/api/workspaces/${workspaceId}`);
  const knowledge = requiredArray(
    (await getJson(`${baseUrl}/api/workspaces/${workspaceId}/knowledge`)).items
  )
    .map((entry) => ({
      id: requiredString(readPath(entry, 'id'), 'Knowledge id'),
      value: stripNonSemanticFields(entry),
    }))
    .sort(compareJson);
  const threads = requiredArray(
    (await getJson(`${baseUrl}/api/workspaces/${workspaceId}/threads`)).items
  ).sort((left, right) =>
    String(readPath(left, 'name')).localeCompare(String(readPath(right, 'name')))
  );
  const threadSnapshots = [];

  for (const thread of threads) {
    const threadId = requiredString(readPath(thread, 'id'), 'Thread id');
    const items = requiredArray(
      (await getJson(`${baseUrl}/api/app/workspaces/${workspaceId}/threads/${threadId}/items`))
        .items
    );
    const turnIds = [
      ...new Set(
        items
          .map((item) => readPath(item, 'turnId'))
          .filter((value): value is string => typeof value === 'string')
      ),
    ];
    const turns = [];

    for (const turnId of turnIds) {
      const turn = await getJson(
        `${baseUrl}/api/workspaces/${workspaceId}/threads/${threadId}/turns/${turnId}`
      );
      const events = await readTurnEventsUntil(
        baseUrl,
        workspaceId,
        threadId,
        turnId,
        (event) => event.event === 'turn.completed'
      );
      const itemIndex = new Map(items.map((item, index) => [readPath(item, 'id'), index] as const));

      turns.push({
        events: events.map((event) => ({
          data: stripNonSemanticFields(event.data),
          event: event.event,
          sequence: event.sequence,
        })),
        items: items
          .filter((item) => readPath(item, 'turnId') === turnId)
          .map((item) => ({
            causationItemIndex: itemIndex.get(readPath(item, 'causationId')) ?? null,
            parentItemIndex: itemIndex.get(readPath(item, 'parentItemId')) ?? null,
            value: stripNonSemanticFields(item),
          })),
        value: stripNonSemanticFields({ ...turn, items: undefined }),
      });
    }

    threadSnapshots.push({ value: stripNonSemanticFields(thread), turns });
  }

  return {
    knowledge,
    threads: threadSnapshots,
    workspace: stripNonSemanticFields(workspace),
  };
}

/** Removes deployment-local identities, reminted digests, and clocks while retaining content and lifecycle semantics. */
function stripNonSemanticFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripNonSemanticFields);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, entry]) =>
          entry !== undefined &&
          key !== 'importedFrom' &&
          key !== 'id' &&
          !key.endsWith('At') &&
          !key.endsWith('Digest') &&
          !key.endsWith('Id') &&
          !key.endsWith('Ids')
      )
      .map(([key, entry]) => [key, stripNonSemanticFields(entry)])
  );
}

/** Runs one bundled CLI operation against the supplied isolated NanoCore process. */
function runCli(
  baseUrl: string,
  operation: string,
  input: Record<string, unknown>
): Promise<CliEnvelope & { raw: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'ops', 'call', operation, '--input', '-'], {
      env: {
        ...process.env,
        OPENKIT_NANOCORE_TOKEN: '',
        OPENKIT_NANOCORE_URL: baseUrl,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);

    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(`OpenKit CLI ${operation} failed with ${code ?? signal}: ${stderr || stdout}`)
        );
        return;
      }
      if (stderr) {
        reject(new Error(`OpenKit CLI ${operation} wrote stderr: ${stderr}`));
        return;
      }
      resolve({ ...(JSON.parse(stdout) as CliEnvelope), raw: stdout });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Creates one disposable Git repository outside every temporary NanoCore data root. */
async function createGitRepository(prefix: string): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), prefix));
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['init', '--quiet'], { cwd: repositoryRoot }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  await writeFile(join(repositoryRoot, 'README.md'), '# Portable CI fixture\n');
  return repositoryRoot;
}

/** Fetches one successful JSON response. */
async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

/** Stops only the isolated child process owned by this runner. */
async function stopHarness(harness: NanoCoreHarness | null): Promise<void> {
  if (!harness) {
    return;
  }
  await harness.stop();
  await removeDataRoot(harness.dataRoot);
}

/** Reads one nested object or array value without introducing a general path helper dependency. */
function readPath(value: unknown, ...path: Array<number | string>): unknown {
  return path.reduce<unknown>((current, segment) => {
    if (typeof segment === 'number' && Array.isArray(current)) {
      return current[segment];
    }
    if (typeof segment === 'string' && current && typeof current === 'object') {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, value);
}

/** Requires one nonempty string result. */
function requiredString(value: unknown, label: string): string {
  assert(typeof value === 'string' && value.length > 0, `${label} is missing.`);
  return value;
}

/** Requires one array result. */
function requiredArray(value: unknown): unknown[] {
  assert(Array.isArray(value), 'Expected an array response field.');
  return value;
}

/** Sorts semantic JSON values deterministically. */
function compareJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

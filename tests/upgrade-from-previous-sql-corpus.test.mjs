import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  compareFamilies,
  EXTERNAL_FAMILIES,
  retainedFamilies,
  summarizeFamilies,
} from '../scripts/upgrade-from-previous.mjs';
import { FILE_CORPUS_FAMILIES } from '../scripts/upgrade-from-previous-corpus.mjs';
import {
  captureIdleNativeBinding,
  checkIdleNativeBinding,
  readSqlCorpus,
  SQL_CORPUS_FAMILIES,
  seedSqlCorpus,
} from '../scripts/upgrade-from-previous-sql-corpus.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = process.env.UPGRADE_CORPUS_APP_ROOT ?? join(repositoryRoot, 'apps/nanocore');

/** Creates real owned prerequisites without an App, provider, Worker, or Host effect. */
async function fixture(t, existingRuntimeTarget = false) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-upgrade-sql-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const load = (name) => import(pathToFileURL(join(appRoot, 'dist', `${name}.js`)).href);
  const { openCoreDb } = await load('storage/db');
  const { applyMigrations } = await load('storage/migrate');
  const { ensureLocalUser } = await load('auth/identity');
  const { FsStore } = await load('lib/store');
  const { recordWorkspaceOwnerMembership } = await load('workspace-membership');
  const coreDb = openCoreDb(join(root, 'data'));
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  if (existingRuntimeTarget) {
    const targets = await load('runtime/nanohost-runtime-target');
    const target = targets.allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      targetId: 'synthetic-existing-target',
      identityId: 'synthetic-existing-identity',
      deploymentId: 'synthetic-existing-deployment',
      observedAt: '2026-10-17T00:00:00.000Z',
    });
    targets.upsertNanoHostRuntimeTarget(coreDb, {
      ...target,
      physicalEpoch: 'f'.repeat(64),
      freshEmpty: true,
      ready: true,
      predecessorFenced: true,
      observedAt: '2026-10-17T00:00:00.000Z',
    });
  }

  const store = new FsStore({ dataRoot: coreDb.dataRoot });
  const workspace = store.createWorkspace('B01 upgrade continuity');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = store.createThread(workspace.id, 'Upgrade corpus');
  const turn = store.createTurn(workspace.id, thread.id, 'Keep the synthetic corpus readable.', {
    kind: 'user',
    id: userId,
  });
  store.createItem({
    id: 'it_00000000-0000-7000-8000-000000000901',
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    text: 'Keep the synthetic corpus readable.',
    actor: { kind: 'user', id: userId },
    status: 'completed',
    createdAt: turn.startedAt,
    completedAt: turn.startedAt,
  });
  const inlineArtifactId = 'ar_00000000-0000-7000-8000-000000000901';
  const artifactBody = '# Synthetic retained inline Artifact\n';
  const artifactDigest = `sha256:${createHash('sha256').update(artifactBody).digest('hex')}`;
  store.createArtifact({
    id: inlineArtifactId,
    workspaceId: workspace.id,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: 'Synthetic retained inline Artifact',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'markdown', body: artifactBody },
    contentDigest: artifactDigest,
    lastMutationRequestId: 'fixture-inline-artifact',
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: 'fixture-inline-artifact',
      sourceDigest: artifactDigest,
      actor: { kind: 'user', id: userId },
      requestId: 'fixture-inline-artifact',
      recordedAt: turn.startedAt,
    },
    createdAt: turn.startedAt,
    updatedAt: turn.startedAt,
  });
  store.updateTurn(turn.id, { status: 'completed', completedAt: turn.startedAt, durationMs: 0 });
  coreDb.sqlite.close();
  const input = {
    appRoot,
    dataRoot: join(root, 'data'),
    retainedRoot: join(root, 'retained'),
    userId,
    selectors: {
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      inlineArtifactId,
    },
  };
  const additional = await seedSqlCorpus(input);
  return { ...input, selectors: { ...input.selectors, ...additional }, load };
}

test('covers every current registered SQLite authority family', () => {
  const register = readFileSync(
    join(repositoryRoot, 'docs/specs/20261017-retained_format_register.md'),
    'utf8'
  );
  const sqlSection = register
    .split('### SQLite Authority Families')[1]
    .split('### Rebuildable And Disposable Boundary')[0];
  const families = [...sqlSection.matchAll(/^\| ([^|]+) \|/gm)]
    .map((match) => match[1].trim())
    .filter((family) => family !== 'Family' && !family.startsWith('---'));
  assert.ok(families.length > 0);
  for (const family of families) {
    assert.ok(SQL_CORPUS_FAMILIES.includes(family), `${family} has native corpus coverage`);
  }
  assert.deepEqual(
    [...FILE_CORPUS_FAMILIES, ...SQL_CORPUS_FAMILIES, ...EXTERNAL_FAMILIES].sort(),
    retainedFamilies(register).sort()
  );
});

test('reopens every SQL family and its linked file owners with exact readback', async (t) => {
  const input = await fixture(t, true);
  const original = await readSqlCorpus(input);
  assert.deepEqual(Object.keys(original).sort(), [...SQL_CORPUS_FAMILIES].sort());
  const candidateSet = original['Candidate sets and selections'].values[0];
  assert.equal(candidateSet.candidates.length, 2);
  assert.equal(candidateSet.judgements.at(-1)?.kind, 'select');
  assert.deepEqual(candidateSet.judgements.at(-1)?.choice, candidateSet.candidates[1]);
  assert.equal(original['Human judgement records'].values.length, 2);
  for (const [family, observed] of Object.entries(original)) {
    assert.ok(observed.values.length > 0, `${family} has actual retained records`);
    for (const bytes of observed.bytes) {
      assert.ok(!bytes.path.startsWith('/'), 'byte evidence uses a domain-relative path');
      assert.ok(bytes.byteLength > 0);
      assert.match(bytes.sha256, /^[a-f0-9]{64}$/);
    }
  }
  const { openCoreDb: openRuntimeDb } = await input.load('storage/db');
  const runtimeDb = openRuntimeDb(input.dataRoot);
  try {
    const targets = await input.load('runtime/nanohost-runtime-target');
    const target = targets.getNanoHostRuntimeTarget(runtimeDb, input.selectors.sql.runtimeTargetId);
    assert.equal(target.targetId, 'synthetic-existing-target');
    targets.fenceNanoHostRuntimeTargetAfterRestart(runtimeDb, '2026-10-19T00:00:00.000Z');
    const reconnected = targets.allocateNanoHostRuntimeTargetConnectionGeneration(runtimeDb, {
      targetId: target.targetId,
      identityId: target.identityId,
      deploymentId: target.deploymentId,
      observedAt: '2026-10-19T00:00:01.000Z',
    });
    targets.upsertNanoHostRuntimeTarget(runtimeDb, {
      ...reconnected,
      physicalEpoch: 'c'.repeat(64),
      freshEmpty: true,
      ready: true,
      predecessorFenced: true,
      observedAt: '2026-10-19T00:00:02.000Z',
    });
    runtimeDb.sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('synthetic-candidate-additive-migration', 9999999999999);
  } finally {
    runtimeDb.sqlite.close();
  }
  const { FsStore } = await input.load('lib/store');
  const pendingFlow = await input.load('runtime/pending-request-flow');
  const { openWorkspaceDb } = await input.load('storage/db');
  pendingFlow.recoverPendingRequestsAtBoot(new FsStore({ dataRoot: input.dataRoot }), {
    openWorkspace: (workspaceId) => openWorkspaceDb(input.dataRoot, workspaceId),
  });
  assert.deepEqual(await readSqlCorpus(input), original);
  assert.equal(
    original['Goals, cards, immutable Plans and Task facts'].values[0].goal.disposition.kind,
    'cancelled'
  );
  assert.equal(
    original['Pending Requests, Workspace receipts and Worker checkpoints'].values[0].delivery,
    'closed-out'
  );
  assert.equal(
    original['Scheduler queue, attempts, recurring history and external event joins'].values[1]
      .phase,
    'closed'
  );
  assert.equal(
    original['Scheduler queue, attempts, recurring history and external event joins'].values[2]
      .status,
    'paused'
  );
  assert.deepEqual(
    original['Scheduler queue, attempts, recurring history and external event joins'].values[3],
    {
      scheduleId: input.selectors.sql.automationId,
      eventKey: input.selectors.sql.externalEventKey,
      sourceTurnId: input.selectors.turnId,
      queueEntryId: input.selectors.sql.queueEntryId,
    }
  );
  const attention = original['Notification attention and delivery attempts'].values[0];
  assert.equal(attention.status, 'failed-no-send');
  assert.equal(attention.attempt.failureCode, 'transport-refused');
  assert.equal(attention.recipientUserId, input.userId);
  const [binding, challenge, disclosure, pairReceipt, inspectReceipt] =
    original['Discord bindings, pairing, disclosures and inbound receipts'].values;
  assert.equal(binding.userId, input.userId);
  assert.equal(challenge.user_id, input.userId);
  assert.ok(challenge.consumed_at !== null);
  assert.equal(disclosure.binding_revision, binding.revision);
  assert.equal(disclosure.pending_request_id, input.selectors.sql.pendingRequestId);
  assert.equal(pairReceipt.state, 'settled');
  assert.equal(inspectReceipt.state, 'settled');
  assert.equal(
    original['Material content, revisions and Thread bindings'].values[1].content,
    'Synthetic upgrade continuity material.\n'
  );
  assert.equal(
    original['Light App metadata, business data, Audit and receipts'].values[1].data.note,
    'Synthetic retained business record.'
  );
  const { openCoreDb } = await input.load('storage/db');
  const db = openCoreDb(input.dataRoot);
  try {
    db.sqlite
      .prepare('DELETE FROM permission_decisions WHERE decision_id = ?')
      .run(input.selectors.sql.serverDecisionId);
  } finally {
    db.sqlite.close();
  }
  await assert.rejects(readSqlCorpus(input), /Core permission decisions.*missing/i);
});

test('verifies original recovery, Context Package and raw provenance bytes', async (t) => {
  const input = await fixture(t);
  const path = join(input.dataRoot, input.selectors.sql.lightAppSnapshotPath);
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(path, bytes);
  await assert.rejects(readSqlCorpus(input), /snapshot digest does not match/i);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(path, bytes);
  const contextPath = join(
    input.dataRoot,
    input.selectors.sql.contextFilePaths.find((file) => file.endsWith('/instructions.md'))
  );
  const instructions = readFileSync(contextPath);
  writeFileSync(contextPath, Buffer.concat([instructions, Buffer.from('changed')]));
  await assert.rejects(readSqlCorpus(input), /Context Package.*(mismatch|digest|inventory)/i);
  writeFileSync(contextPath, instructions);
  const rawPath = join(input.dataRoot, input.selectors.sql.provenancePaths[0]);
  writeFileSync(rawPath, `${readFileSync(rawPath, 'utf8')} `);
  await assert.rejects(readSqlCorpus(input), /Runtime provenance original digest/i);
});

for (const [family, table, column, selector] of [
  ['external event joins', 'external_trigger_admissions', 'queue_entry_id', 'queueEntryId'],
  ['attention', 'notification_attention', 'id', 'attentionId'],
  ['delivery attempt', 'notification_delivery_attempts', 'attention_id', 'attentionId'],
  ['Discord binding', 'discord_account_bindings', 'user_id', 'userId'],
  ['Discord pairing', 'discord_pairing_challenges', 'digest', 'discordChallengeDigest'],
  ['Discord disclosure', 'discord_disclosures', 'token_digest', 'discordDisclosureDigest'],
  ['Discord receipt', 'discord_inbound_receipts', 'event_id', 'discordInspectEventId'],
]) {
  test(`refuses missing selected ${family} records`, async (t) => {
    const input = await fixture(t);
    const { openCoreDb } = await input.load('storage/db');
    const db = openCoreDb(input.dataRoot);
    try {
      db.sqlite
        .prepare(`DELETE FROM ${table} WHERE ${column} = ?`)
        .run(input.selectors.sql[selector]);
    } finally {
      db.sqlite.close();
    }
    await assert.rejects(readSqlCorpus(input), /missing|attention_recovery_required/i);
  });
}

test('detects changes in selected Discord disclosure values', async (t) => {
  const input = await fixture(t);
  const baseline = summarizeFamilies(await readSqlCorpus(input), SQL_CORPUS_FAMILIES);
  const { openCoreDb } = await input.load('storage/db');
  const db = openCoreDb(input.dataRoot);
  try {
    db.sqlite
      .prepare('UPDATE discord_disclosures SET content_digest = ? WHERE token_digest = ?')
      .run('f'.repeat(64), input.selectors.sql.discordDisclosureDigest);
  } finally {
    db.sqlite.close();
  }
  const changed = await readSqlCorpus(input);
  assert.throws(() => compareFamilies(baseline, changed, SQL_CORPUS_FAMILIES), /readback changed/);
});

test('idle native corpus preserves historical AEP bytes and requires fenced retirement evidence', async (t) => {
  const input = await fixture(t, true);
  const { openCoreDb, openWorkspaceDb } = await input.load('storage/db');
  const { FsStore } = await input.load('lib/store');
  const harness = await input.load('runtime/nanohost-harness-records');
  const targets = await input.load('runtime/nanohost-runtime-target');
  const bindings = await input.load('runtime/worker-storage-bindings');
  const aep = await input.load('runtime/aep-snapshot-ledger');
  const { workerTurnCapturePaths } = await import(
    pathToFileURL(createRequire(join(appRoot, 'package.json')).resolve('@openkit/worker-protocol'))
      .href
  );
  const sql = input.selectors.sql;
  const core = openCoreDb(input.dataRoot);
  t.after(() => core.sqlite.close());
  const target = targets.getNanoHostRuntimeTarget(core, sql.runtimeTargetId);
  const store = new FsStore({ dataRoot: input.dataRoot });
  const predecessor = store.getAgentSession(sql.contextAgentSessionId);
  const actor = { kind: 'user', id: input.userId };
  const turnInput = 'Synthetic idle native corpus.';
  const turn = store.createTurn(predecessor.workspaceId, predecessor.threadId, turnInput, actor);
  const requestItemId = 'it_00000000-0000-7000-8000-000000000902';
  store.createItem({
    id: requestItemId,
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'user-message',
    text: turnInput,
    actor,
    status: 'completed',
    createdAt: turn.startedAt,
    completedAt: turn.startedAt,
  });
  const session = store.createAgentSession({
    id: 'as_00000000-0000-7000-8000-000000000902',
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    agentId: predecessor.agentId,
    status: 'busy',
    message: null,
    createdAt: turn.startedAt,
    updatedAt: turn.startedAt,
    environmentPackageSnapshotId: 'aepsnap_idle-native-corpus',
  });
  store.updateTurn(turn.id, { agentSessionId: session.id });
  const snapshotDb = openWorkspaceDb(input.dataRoot, session.workspaceId);
  try {
    const original = aep.requireAgentEnvironmentPackageSnapshot(
      snapshotDb,
      session.workspaceId,
      sql.aepSnapshotId
    );
    const capturePaths = workerTurnCapturePaths(
      turn.threadId,
      original.snapshot.control.adapter.targetRuntime,
      turn.id
    );
    aep.recordAgentEnvironmentPackageSnapshot(snapshotDb, {
      environmentPackage: {
        ...original.snapshot,
        snapshotId: session.environmentPackageSnapshotId,
        createdAt: turn.startedAt,
        scope: {
          ...original.snapshot.scope,
          agentSessionId: session.id,
          turnId: turn.id,
          itemId: requestItemId,
          requestId: 'upgrade-corpus-idle-native',
        },
        control: {
          ...original.snapshot.control,
          transcript: {
            ...original.snapshot.control.transcript,
            root: capturePaths.root,
            eventsPath: capturePaths.eventsPath,
            itemsPath: capturePaths.itemsPath,
            runtimeProvenance: {
              ...original.snapshot.control.transcript.runtimeProvenance,
              nativeOriginIndexPath: capturePaths.nativeOriginIndexPath,
              rawStreamsRoot: capturePaths.rawStreamsRoot,
              streamManifestPath: capturePaths.streamManifestPath,
            },
          },
        },
      },
      createdAt: session.createdAt,
    });
  } finally {
    snapshotDb.sqlite.close();
  }
  const now = target.observedAt;
  targets.upsertNanoHostRuntimeTarget(core, {
    ...target,
    physicalEpoch: 'a'.repeat(64),
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
    observedAt: now,
  });
  const storage = bindings.getWorkerStorageBinding(core, { storageRef: sql.storageRef });
  const reserved = bindings.reserveWorkerStorageAttachment(core, {
    agentSessionId: session.id,
    authorizeContributor: () => true,
    expectedRevision: storage.revision,
    layout: storage.layout,
    purpose: 'work',
    responsibleUserId: input.userId,
    runtimeTargetId: target.targetId,
    storageRef: storage.storageRef,
    threadId: session.threadId,
    workspaceId: session.workspaceId,
    now,
  });
  const attached = bindings.activateWorkerStorageAttachment(core, {
    attachmentGeneration: reserved.attachmentGeneration,
    expectedRevision: reserved.revision,
    sandboxBindingRef: 'idle-corpus-sandbox',
    storageRef: storage.storageRef,
    now,
    targets: reserved.targets.map((entry) => ({ ...entry, initialized: true })),
  });
  store.updateAgentSession(session.id, {
    status: 'idle',
    nativeHandleDigest: 'd'.repeat(64),
    retainedStorage: { storageRef: storage.storageRef, workSlotRef: attached.currentWorkSlotRef },
  });
  harness.createNanoHostHarnessRuntime(core, {
    maxActiveTurns: 1,
    adapterId: 'codex',
    adapterVersion: '0.153.4',
    harnessBindingRef: 'idle-corpus-harness-binding',
    harnessCompatibilityKey: 'b'.repeat(64),
    harnessInstanceId: 'idle-corpus-harness',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    originPhysicalEpoch: 'a'.repeat(64),
    sandboxBindingRef: 'idle-corpus-sandbox',
    sandboxCompatibilityKey: 'c'.repeat(64),
    sandboxIntegrationBindingRef: 'idle-corpus-integration',
    sandboxRuntimeId: 'idle-corpus-runtime',
    runtimeTargetId: target.targetId,
    timestamp: now,
  });
  const opening = {
    agentSessionCompatibilityKey: 'e'.repeat(64),
    agentSessionId: session.id,
    agentSessionRuntimeBindingId: 'idle-corpus-binding',
    effectiveSetupGeneration: 1,
    harnessInstanceId: 'idle-corpus-harness',
    threadId: session.threadId,
    timestamp: now,
    workspaceId: session.workspaceId,
  };
  harness.openNanoHostAgentSessionBinding(core, opening);
  const { harnessInstanceId: _harness, timestamp: _time, ...body } = opening;
  harness.queueNanoHostHarnessOperation(core, {
    body: { ...body, adapterId: 'codex', resume: null },
    harnessInstanceId: opening.harnessInstanceId,
    operation: 'session.open',
    timestamp: now,
  });
  const command = harness.dispatchNanoHostHarnessOperation(core, {
    sandboxIntegrationBindingRef: 'idle-corpus-integration',
    now: () => now,
  });
  harness.settleNanoHostHarnessOperation(core, {
    sandboxIntegrationBindingRef: 'idle-corpus-integration',
    timestamp: now,
    result: {
      schemaVersion: 2,
      harnessInstanceId: opening.harnessInstanceId,
      operationId: command.operationId,
      sequence: command.sequence,
      disposition: 'succeeded',
      body: {
        state: 'open',
        maxActiveTurns: 1,
        nativeHandleState: 'ready',
        nativeHandleDigest: 'd'.repeat(64),
      },
    },
  });
  store.updateTurn(turn.id, {
    status: 'completed',
    completedAt: turn.startedAt,
    durationMs: 0,
  });
  const previous = await captureIdleNativeBinding(input, {
    workspaceId: session.workspaceId,
    threadId: session.threadId,
    turnId: turn.id,
  });
  // Only this synthetic oracle substitutes exact pre-naming bytes. Real upgrade runs use the old writer.
  const snapshotPath = join(input.dataRoot, previous.aepBytes.path);
  const record = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  record.snapshot.capabilities.routes = ['mcp.list_servers', 'mcp.list_tools', 'mcp.call_tool'];
  record.contentDigest = aep.snapshotDigest(record.snapshot);
  const oldBytes = Buffer.from(`${JSON.stringify(record)}\n`);
  writeFileSync(snapshotPath, oldBytes);
  previous.aepBytes.byteLength = oldBytes.length;
  previous.aepBytes.sha256 = createHash('sha256').update(oldBytes).digest('hex');
  const workspace = openWorkspaceDb(input.dataRoot, session.workspaceId);
  try {
    assert.throws(
      () =>
        aep.requireAgentEnvironmentPackageSnapshot(
          workspace,
          session.workspaceId,
          previous.snapshotId
        ),
      /retained record could not be read/i
    );
  } finally {
    workspace.sqlite.close();
  }
  assert.equal((await checkIdleNativeBinding(input, previous)).aepBytesPreserved, true);
  const candidateWorker = {
    workspaceId: input.selectors.workspaceId,
    threadId: input.selectors.threadId,
    turnId: input.selectors.turnId,
  };
  await assert.rejects(checkIdleNativeBinding(input, previous, candidateWorker), /not retired/);
  harness.removeNanoHostSandboxRuntimeByBinding(core, 'idle-corpus-sandbox');
  await assert.rejects(
    checkIdleNativeBinding(input, previous, {
      workspaceId: session.workspaceId,
      threadId: session.threadId,
      turnId: sql.contextTurnId,
    }),
    /physical Epoch/
  );
  // The ordered guest driver already checked live readiness before stopping these writers.
  targets.fenceNanoHostRuntimeTargetAfterRestart(core, now);
  assert.equal(
    (await checkIdleNativeBinding(input, previous, candidateWorker)).idleBindingRetired,
    true
  );
  assert.deepEqual(readFileSync(snapshotPath), oldBytes);
  writeFileSync(snapshotPath, Buffer.concat([oldBytes, Buffer.from(' ')]));
  await assert.rejects(
    checkIdleNativeBinding(input, previous, candidateWorker),
    /AEP bytes changed/
  );
  await assert.rejects(
    checkIdleNativeBinding(input, undefined, candidateWorker),
    /selected retained record is missing/
  );
});

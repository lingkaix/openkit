import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

/** File-family inventory; SQL-correlated files and external Host storage have separate producers. */
export const FILE_CORPUS_FAMILIES = Object.freeze([
  'Layout marker',
  'Workspace record',
  'Thread record',
  'Turn record',
  'Item revision log',
  'Stream event log',
  'Artifact record and inline content',
  'Artifact original file payload',
  'Conversation original file inputs',
  'Notebook content and history',
  'Notebook scope schema',
  'Knowledge Proposal',
  'Knowledge Proposal Review',
  'Knowledge observation ledger',
  'Knowledge claim ledger',
  'Knowledge conflict ledger',
  'Workspace Source identity',
  'Workspace captured Source text',
  'User Source identity',
  'User captured Source text',
  'Memory suppression',
  'AgentSession',
  'Resource catalog',
  'Immutable Skill and Plugin packages',
  'Mutable MCP process data',
  'Authored settings and Policy',
  'Encrypted Vault store',
  'Workspace export',
  'Data Root backup',
  'Workspace deletion closure',
  'Turn human feedback',
  'Query-owned retrieval traces',
]);

const FIXTURE = Object.freeze({
  at: '2026-10-18T00:00:00.000Z',
  text: 'B01 public synthetic retained text.\r\nUnicode Ω.\n',
  original: Buffer.from('00ffc328800a', 'hex'),
  skill:
    '---\nname: continuity\ndescription: Public synthetic upgrade fixture.\n---\n# Retained Skill\n',
});

/** Computes an exact-byte identity without decoding opaque material. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Resolves all producers from the selected revision, never from the caller's checkout. */
async function owners(appRoot) {
  const load = (path) => import(pathToFileURL(join(resolve(appRoot), 'dist', path)).href);
  const modules = {
    store: 'lib/store.js',
    db: 'storage/db.js',
    migrate: 'storage/migrate.js',
    layout: 'storage/fs-layout.js',
    records: 'storage/workspace-file-records.js',
    notebook: 'knowledge/notebook.js',
    notebookOwner: 'knowledge/scoped-notebook-owner.js',
    okf: 'knowledge/okf.js',
    sources: 'knowledge/scoped-knowledge-sources.js',
    memory: 'knowledge/memory-maintenance.js',
    membership: 'workspace-membership.js',
    feedback: 'runtime/feedback.js',
    catalog: 'catalog/resource-catalog.js',
    portableCatalog: 'catalog/catalog-portability.js',
    fileAdmission: 'storage/artifacts/file-admission.js',
    filePayload: 'storage/artifacts/file-payload.js',
    fileRecords: 'storage/artifacts/file-records.js',
    vault: 'vault/vault-encrypted-file-store.js',
    transfer: 'storage/workspace-transfer-routes.js',
    exports: 'storage/workspace-export.js',
    backup: 'storage/data-root-backup.js',
    closure: 'workspace-deletion-evidence.js',
    traces: 'storage/retrieval-traces.js',
    jsonc: 'config/jsonc.js',
  };
  const loaded = Object.fromEntries(
    await Promise.all(Object.entries(modules).map(async ([name, path]) => [name, await load(path)]))
  );
  const require = createRequire(join(resolve(appRoot), 'package.json'));
  loaded.protocol = await import(pathToFileURL(require.resolve('@openkit/protocol')).href);
  loaded.configSchema = await import(pathToFileURL(require.resolve('@openkit/config-schema')).href);
  return loaded;
}

/** Keeps all fixture outputs in two explicit, disjoint real directories. */
function roots(dataRoot, retainedRoot) {
  const data = resolve(dataRoot),
    retained = resolve(retainedRoot);
  if (
    data === retained ||
    data.startsWith(`${retained}${sep}`) ||
    retained.startsWith(`${data}${sep}`)
  ) {
    throw new Error('Corpus Data Root and retained root must be disjoint.');
  }
  for (const root of [data, retained]) {
    let current = root;
    while (!existsSync(current)) current = dirname(current);
    for (;;) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Corpus root is not canonical.');
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return { data, retained, corpus: join(retained, 'file-corpus') };
}

/** Inventories exact retained bytes and rejects links, special files and path escapes. */
function bytesAt(root, path, domain) {
  const target = resolve(root, path),
    rel = relative(root, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('Corpus path escapes its root.');
  const result = [];
  const visit = (absolute) => {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('Corpus bytes cannot follow symbolic links.');
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) visit(join(absolute, entry));
    } else if (stat.isFile()) {
      const bytes = readFileSync(absolute);
      result.push({
        path: `${domain}/${relative(root, absolute).split(sep).join('/')}`,
        byteLength: bytes.length,
        sha256: sha256(bytes),
      });
    } else throw new Error('Corpus bytes contain an unsupported file.');
  };
  let parent = dirname(target);
  while (parent !== root) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Corpus parent is not canonical.');
    parent = dirname(parent);
  }
  visit(target);
  return result;
}

/** Creates one valid initial Artifact whose exact contents remain owned by the Artifact reader. */
function artifact(o, selectors, body, file = false) {
  const digest = `sha256:${sha256(body)}`,
    id = o.protocol.allocateEntityId('ar');
  return {
    id,
    workspaceId: selectors.workspaceId,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: file ? 'Opaque original' : 'Inline original',
    status: 'ready',
    summary: null,
    version: 1,
    content: file
      ? { format: 'file', mediaType: 'application/octet-stream', byteLength: body.length }
      : { format: 'text', body },
    contentDigest: digest,
    lastMutationRequestId: id,
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: id,
      sourceDigest: digest,
      actor: { kind: 'user', id: selectors.userId },
      requestId: id,
      recordedAt: FIXTURE.at,
    },
    createdAt: FIXTURE.at,
    updatedAt: FIXTURE.at,
  };
}

/** Opens only existing User authority; the helper cannot create, rename or replace an account. */
function context(o, dataRoot, userId, initialize = false) {
  if (!o.protocol.isEntityId('usr', userId))
    throw new Error('Corpus requires a canonical synthetic User.');
  const coreDb = o.db.openExistingCoreDbWithIntegrityCheck(dataRoot);
  const user = coreDb.sqlite.prepare('SELECT kind FROM users WHERE id = ?').get(userId);
  if (!user) {
    coreDb.sqlite.close();
    throw new Error('Corpus User must already exist.');
  }
  let userDb;
  try {
    userDb = o.db.openUserDb(dataRoot, userId);
    if (initialize) o.migrate.applyScopedMigrations(userDb);
    return {
      coreDb,
      userDb,
      actor: { kind: user.kind === 'local' ? 'local' : 'session', userId },
      store: new o.store.FsStore({ dataRoot }),
      inflightCommands: new WeakMap(),
    };
  } catch (error) {
    userDb?.sqlite.close();
    coreDb.sqlite.close();
    throw error;
  }
}

/** Seeds one small public B01 Workspace through the selected release's native file producers. Writers must already be stopped. */
export async function seedFileCorpus({ appRoot, dataRoot, retainedRoot, userId }) {
  const r = roots(dataRoot, retainedRoot),
    o = await owners(appRoot);
  if (existsSync(r.corpus)) throw new Error('File corpus already exists; retain this attempt.');
  const ctx = context(o, r.data, userId, true),
    selectors = { userId };
  try {
    mkdirSync(r.corpus, { recursive: true, mode: 0o700 });
    const producer = { kind: 'user', id: userId };
    const workspace = ctx.store.createWorkspace('B01 upgrade continuity', {
      requestId: randomUUID(),
      producer,
      instructionReference: 'fixture:upgrade-from-previous',
    });
    selectors.workspaceId = workspace.id;
    o.membership.recordWorkspaceOwnerMembership({
      coreDb: ctx.coreDb,
      ownerUserId: userId,
      workspaceId: workspace.id,
    });
    const thread = ctx.store.createThread(workspace.id, 'Retained B01 history');
    selectors.threadId = thread.id;
    const inputSource = join(r.corpus, 'input-original.bin');
    writeFileSync(inputSource, FIXTURE.original, { flag: 'wx', mode: 0o600 });
    const turn = ctx.store.createTurn(workspace.id, thread.id, FIXTURE.text, producer, null, {
      captureCoverage: { scope: 'server', value: 'off' },
      startedAt: FIXTURE.at,
      executorKind: 'person',
      fileInputs: [
        {
          name: 'synthetic-original.bin',
          mediaType: 'application/octet-stream',
          sizeBytes: FIXTURE.original.length,
          contentDigest: `sha256:${sha256(FIXTURE.original)}`,
        },
      ],
      filePayloadPaths: [inputSource],
      fileWriteAdmission: new o.fileAdmission.FileStorageAdmission(r.data, () => 0n),
    });
    selectors.turnId = turn.id;
    const lineage = { workspaceId: workspace.id, threadId: thread.id, turnId: turn.id };
    for (const item of [
      { type: 'user-message', actor: producer, text: FIXTURE.text },
      { type: 'assistant-message', text: 'Public synthetic previous-release response.' },
      {
        type: 'command-execution',
        command: 'printf fixture',
        cwd: '/workspace',
        output: 'fixture',
        exitCode: 0,
        durationMs: 1,
      },
    ])
      ctx.store.createItem({
        ...lineage,
        id: o.protocol.allocateEntityId('it'),
        ...item,
        status: 'completed',
        createdAt: FIXTURE.at,
        completedAt: FIXTURE.at,
      });
    ctx.store.emitTurnEvent(turn.id, {
      ...lineage,
      event: 'turn.started',
      requestId: randomUUID(),
      data: { type: 'turn-started', turnId: turn.id, status: 'running' },
    });
    selectors.agentSessionId = o.protocol.allocateEntityId('as');
    ctx.store.createAgentSession({
      id: selectors.agentSessionId,
      agentId: 'agent_continuity_fixture',
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'closed',
      message: null,
      createdAt: FIXTURE.at,
      updatedAt: FIXTURE.at,
    });
    const inline = artifact(o, selectors, FIXTURE.text);
    selectors.inlineArtifactId = inline.id;
    ctx.store.createArtifact(inline);
    const original = artifact(o, selectors, FIXTURE.original, true);
    selectors.fileArtifactId = original.id;
    const workspaceRoot = join(r.data, 'workspaces', workspace.id);
    const capacity = new o.fileAdmission.FileStorageAdmission(r.data, () => 0n);
    const reservation = capacity.reserve({
      stagingBytes: 12n,
      publicationBytes: 12n,
      extractionBytes: 0n,
      derivativeBytes: 0n,
    });
    const staged = await o.filePayload.stageArtifactPayload({
      workspaceRoot,
      reservation,
      source: Readable.from([FIXTURE.original]),
      expectedByteLength: FIXTURE.original.length,
      expectedDigest: original.contentDigest,
    });
    try {
      ctx.store.createArtifact(original, staged);
    } finally {
      await staged.remove();
      reservation.release();
    }
    selectors.sourceId = o.protocol.allocateEntityId('ks');
    ctx.store.createKnowledgeSource(
      {
        id: selectors.sourceId,
        workspaceId: workspace.id,
        kind: 'document',
        title: 'Public synthetic Source',
        uri: null,
        contentDigest: `sha256:${sha256(FIXTURE.text)}`,
        originatingThreadId: thread.id,
        originatingTurnId: turn.id,
        originatingFileId: null,
        capturedAt: FIXTURE.at,
        createdAt: FIXTURE.at,
        updatedAt: FIXTURE.at,
      },
      FIXTURE.text
    );
    selectors.userSourceId = (
      await o.sources.registerUserKnowledgeSource(ctx, {
        requestId: randomUUID(),
        kind: 'document',
        title: 'Public synthetic User Source',
        content: FIXTURE.text,
      })
    ).id;
    selectors.notebooks = [];
    for (const scope of ['workspace', 'user', 'server']) {
      const notebookRoot =
        scope === 'workspace'
          ? join(workspaceRoot, 'knowledge')
          : scope === 'user'
            ? o.layout.userMemoryRoot(r.data, userId)
            : o.layout.serverKnowledgeRoot(r.data);
      if (scope !== 'workspace' && !existsSync(notebookRoot))
        o.notebookOwner.initializeScopedNotebook({
          ...ctx,
          target: { kind: scope },
          initialization: {
            requestId: randomUUID(),
            instructionReference: 'fixture:upgrade-from-previous',
          },
        });
      const notebook = new o.notebook.KnowledgeNotebook({
        repositoryPath: join(notebookRoot, 'notebook.git'),
      });
      const baseRevision = notebook.publishedRevision();
      const ownerScope =
        scope === 'workspace'
          ? { kind: scope, workspaceId: workspace.id }
          : scope === 'user'
            ? { kind: scope, userId }
            : { kind: scope };
      const content = o.records.serializeUserAuthoredKnowledgePage(
        {
          id: 'continuity',
          kind: 'project-context',
          title: 'Public synthetic continuity',
          content: FIXTURE.text,
          createdAt: FIXTURE.at,
          updatedAt: FIXTURE.at,
        },
        ownerScope
      );
      const candidateRevision = notebook.prepare({
        baseRevision,
        changes: { 'continuity.md': content },
        metadata: {
          summary: 'Public synthetic upgrade fixture',
          producer,
          authority: { kind: 'direct', instructionReference: 'fixture:upgrade-from-previous' },
          changeRequest: { requestId: randomUUID(), inputDigest: `sha256:${sha256(content)}` },
          sourceReferences: [],
        },
      });
      notebook.publish({ baseRevision, candidateRevision });
      selectors.notebooks.push({ scope, revision: candidateRevision });
    }
    const userNotebook = selectors.notebooks.find((entry) => entry.scope === 'user');
    const memoryNotebook = new o.notebook.KnowledgeNotebook({
      repositoryPath: join(o.layout.userMemoryRoot(r.data, userId), 'notebook.git'),
    });
    const suppressedPage = memoryNotebook.readRevision(userNotebook.revision).files[
      'continuity.md'
    ];
    // This direct owner records exact synthetic history without physical erasure of its Git bytes.
    o.memory.appendMemorySuppression(o.layout.userMemoryRoot(r.data, userId), {
      userId,
      actorId: userId,
      requestId: randomUUID(),
      pageId: 'continuity',
      lastRevision: userNotebook.revision,
      digest: `sha256:${sha256(suppressedPage)}`,
      sourceFingerprints: [],
    });
    const notebook = new o.notebook.KnowledgeNotebook({
      repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
    });
    const candidatePage = o.records.serializeUserAuthoredKnowledgePage(
      {
        id: 'candidate',
        kind: 'project-context',
        title: 'Public synthetic candidate',
        content: FIXTURE.text,
        createdAt: FIXTURE.at,
        updatedAt: FIXTURE.at,
      },
      { kind: 'workspace', workspaceId: workspace.id }
    );
    const proposal = ctx.store.createKnowledgeProposal({
      workspaceId: workspace.id,
      requestId: randomUUID(),
      baseRevision: notebook.publishedRevision(),
      changes: [{ path: 'candidate.md', content: candidatePage }],
      sourceReferences: [],
      summary: 'Public synthetic retained candidate',
      producer,
      createdAt: FIXTURE.at,
      verifiedExternalReferences: [],
    });
    selectors.proposalId = proposal.id;
    const proposalBytes = readFileSync(
      join(workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`)
    );
    ctx.store.recordKnowledgeProposalReviewDecision({
      workspaceId: workspace.id,
      proposalId: proposal.id,
      requestId: randomUUID(),
      decision: 'rejected',
      proposalDigest: `sha256:${sha256(proposalBytes)}`,
      baseRevision: proposal.baseRevision,
      candidateRevision: proposal.candidateRevision,
      actor: producer,
      decidedAt: FIXTURE.at,
      verifiedExternalReferences: [],
    });
    selectors.claimId = o.protocol.allocateEntityId('kc');
    ctx.store.recordKnowledgeClaim({
      id: selectors.claimId,
      workspaceId: workspace.id,
      statement: 'Public synthetic retained claim.',
      sourceReferences: ['knowledge:continuity'],
      scope: 'workspace',
      producer: 'upgrade-corpus',
      confidence: 1,
      freshness: 'current',
      reviewState: 'accepted',
      conflictStatus: 'none',
      createdAt: FIXTURE.at,
      updatedAt: FIXTURE.at,
    });
    ctx.store.recordKnowledgeObservation({
      id: o.protocol.allocateEntityId('ko'),
      workspaceId: workspace.id,
      kind: 'maintenance',
      summary: 'Public synthetic observation.',
      sourceReferences: [`claim:${selectors.claimId}`],
      scope: 'workspace',
      producer: 'upgrade-corpus',
      confidence: 1,
      freshness: 'current',
      status: 'retained',
      observedAt: FIXTURE.at,
      createdAt: FIXTURE.at,
    });
    ctx.store.recordKnowledgeConflict({
      id: o.protocol.allocateEntityId('kf'),
      workspaceId: workspace.id,
      subjectReferences: ['knowledge:continuity', `claim:${selectors.claimId}`],
      sourceReferences: ['knowledge:continuity'],
      status: 'needs_review',
      summary: 'Public synthetic historical conflict.',
      suggestedActions: ['Inspect synthetic fixture.'],
      producer: 'upgrade-corpus',
      createdAt: FIXTURE.at,
      updatedAt: FIXTURE.at,
    });
    await seedRemainingFiles(o, ctx, r, selectors, producer, workspaceRoot);
  } finally {
    ctx.userDb.sqlite.close();
    ctx.coreDb.sqlite.close();
  }
  const backupRoot = join(r.corpus, 'data-root-backup');
  o.backup.assertExternalColdBackupDestination(r.data, backupRoot);
  o.backup.copyColdDataRoot({ dataRoot: r.data, backupRoot });
  o.backup.writeColdDataRootBackupManifest({
    backupRoot,
    backupId: o.protocol.allocateEntityId('drb'),
    sourceDeploymentId: o.layout.readDataRootLayoutMarker(r.data).deploymentId,
    startedAt: FIXTURE.at,
    completedAt: new Date().toISOString(),
  });
  return selectors;
}

/** Produces catalog, encrypted fixture, export and closure bytes without any external execution. */
async function seedRemainingFiles(o, ctx, r, selectors, producer, workspaceRoot) {
  const packageRoot = join(r.corpus, 'plugin-source');
  mkdirSync(join(packageRoot, 'skills', 'continuity'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(packageRoot, 'plugin.json'),
    JSON.stringify({ name: 'continuity-fixture', version: '1.0.0' })
  );
  writeFileSync(join(packageRoot, 'skills', 'continuity', 'SKILL.md'), FIXTURE.skill);
  const imported = o.catalog.importWorkspacePlugin({
    dataRoot: r.data,
    workspaceId: selectors.workspaceId,
    treeRoot: packageRoot,
    install: true,
    producer,
    createdAt: FIXTURE.at,
    expectedRevision: 0,
  });
  selectors.pluginId = imported.version.entryId;
  selectors.skillId = imported.catalog.skills.versions[0].entryId;
  // This family is opaque process-owned bytes. It has no OpenKit payload parser or portable import.
  const mcpData = join(workspaceRoot, 'catalog', 'mcp-data', 'continuity-fixture');
  mkdirSync(mcpData, { recursive: true, mode: 0o700 });
  writeFileSync(join(mcpData, 'opaque.bin'), FIXTURE.original, { flag: 'wx', mode: 0o600 });
  const workspaceConfig = join(workspaceRoot, 'config', 'workspace.jsonc');
  writeFileSync(
    workspaceConfig,
    `// Public synthetic authored comment.\n${readFileSync(workspaceConfig, 'utf8')}`
  );

  const vaultRoot = join(r.corpus, 'vault-store'),
    key = randomBytes(32);
  writeFileSync(join(r.corpus, 'vault-key.bin'), key, { flag: 'wx', mode: 0o600 });
  try {
    o.vault.initializeOrVerifyEncryptedFileVaultStore({ storeDir: vaultRoot, masterKey: key });
    selectors.vaultReferenceId = o.protocol.allocateEntityId('vault');
    o.vault.sealEncryptedFileVaultEntry({
      storeDir: vaultRoot,
      referenceId: selectors.vaultReferenceId,
      version: 1,
      metadata: { ownerScope: 'workspace', workspaceId: selectors.workspaceId },
      material: FIXTURE.text,
      masterKey: key,
      createdAt: FIXTURE.at,
    });
  } finally {
    key.fill(0);
  }

  const lineage = {
    workspaceId: selectors.workspaceId,
    threadId: selectors.threadId,
    turnId: selectors.turnId,
  };
  const reference = {
    scopeId: `retrieval-trace/turn/${selectors.workspaceId}/${selectors.threadId}/${selectors.turnId}`,
    objectId: o.protocol.allocateEntityId('krt'),
  };
  selectors.retrievalTraceReference = reference;
  o.traces.publishRetrievalTrace(workspaceRoot, reference, {
    sourceKind: 'conversation',
    traceId: reference.objectId,
    queryContext: {
      serverId: o.layout.readDataRootLayoutMarker(r.data).deploymentId,
      ...lineage,
      actor: producer,
    },
    requestDigest: `sha256:${sha256(FIXTURE.text)}`,
    retrievalParameters: { mode: 'lexical', limit: 1 },
    selected: [],
    complete: true,
    createdAt: FIXTURE.at,
  });
  ctx.store.updateTurn(selectors.turnId, {
    status: 'completed',
    completedAt: FIXTURE.at,
    durationMs: 0,
  });
  o.feedback.updateTurnFeedback(
    ctx.store,
    selectors.turnId,
    { rating: 'good', note: 'Public synthetic feedback.' },
    producer
  );

  const repositoryWorkspaceDb = (workspaceId) => {
    const db = o.db.openWorkspaceDb(r.data, workspaceId);
    o.migrate.applyScopedMigrations(db);
    return db;
  };
  const exported = o.transfer.createVerifiedWorkspaceExport({
    authorityUserId: selectors.userId,
    requestActor: ctx.actor,
    authorityActor: producer,
    coreDb: ctx.coreDb,
    dataRoot: r.data,
    repositoryWorkspaceDb,
    store: ctx.store,
    workspaceId: selectors.workspaceId,
  });
  selectors.exportId = exported.response.exportId;
  const exportRoot = o.transfer.existingWorkspaceExportRoot(
    r.data,
    selectors.workspaceId,
    selectors.exportId
  );
  selectors.closure = {
    workspaceId: selectors.workspaceId,
    requestId: randomUUID(),
    originalOwnerUserId: selectors.userId,
    sourceRegistryRevision: 1,
    closureId: `wsclose_${randomUUID()}`,
    cutoffTimestamp: new Date().toISOString(),
    recoveryExportId: selectors.exportId,
    recoveryExportManifestDigest: `sha256:${sha256(readFileSync(join(exportRoot, 'openkit-workspace-export.json')))}`,
  };
  o.closure.createWorkspaceDeletionClosure({
    ...selectors.closure,
    dataRoot: r.data,
    coreDb: ctx.coreDb,
    repositoryWorkspaceDb,
  });
}

/** Reads every implemented family through native readers and measures originals by digest. This returns corpus evidence, never a release qualification verdict. */
export async function readFileCorpus({ appRoot, dataRoot, retainedRoot, selectors }) {
  const r = roots(dataRoot, retainedRoot),
    o = await owners(appRoot);
  for (const [kind, id] of [
    ['usr', selectors.userId],
    ['ws', selectors.workspaceId],
    ['th', selectors.threadId],
    ['tu', selectors.turnId],
    ['as', selectors.agentSessionId],
    ['ar', selectors.inlineArtifactId],
    ['ar', selectors.fileArtifactId],
    ['ks', selectors.sourceId],
    ['ks', selectors.userSourceId],
  ]) {
    if (!o.protocol.isEntityId(kind, id))
      throw new Error('Corpus selectors contain an invalid identity.');
  }
  const ctx = context(o, r.data, selectors.userId),
    result = {};
  const workspacePath = `workspaces/${selectors.workspaceId}`,
    workspaceRoot = join(r.data, workspacePath);
  const turnPath = `${workspacePath}/threads/${selectors.threadId}/turns/${selectors.turnId}`;
  const record = (family, values, paths, retainedPaths = []) => {
    if (!values.length || values.some((value) => value === null || value === undefined))
      throw new Error(`${family}: no native reader result.`);
    result[family] = {
      values,
      bytes: [
        ...paths.flatMap((path) => bytesAt(r.data, path, 'data')),
        ...retainedPaths.flatMap((path) => bytesAt(r.retained, path, 'retained')),
      ].sort((a, b) => a.path.localeCompare(b.path)),
    };
    if (!result[family].bytes.length) throw new Error(`${family}: retained bytes are missing.`);
  };
  try {
    record('Layout marker', [o.layout.readDataRootLayoutMarker(r.data)], ['server/layout.json']);
    record(
      'Workspace record',
      [ctx.store.getWorkspace(selectors.workspaceId)],
      [`${workspacePath}/workspace-record.json`]
    );
    record(
      'Thread record',
      [ctx.store.getThread(selectors.workspaceId, selectors.threadId)],
      [`${workspacePath}/threads/${selectors.threadId}/thread.json`]
    );
    record('Turn record', [ctx.store.getTurnById(selectors.turnId)], [`${turnPath}/turn.json`]);
    const fileTurn = ctx.store.getTurnById(selectors.turnId);
    o.records.verifyTurnFileInputs(workspaceRoot, fileTurn);
    record(
      'Conversation original file inputs',
      [fileTurn.fileInputs],
      [`${turnPath}/inputs/0/payload`]
    );
    record('Item revision log', ctx.store.listWorkspaceItemRevisions(selectors.workspaceId), [
      `${turnPath}/items.jsonl`,
    ]);
    record('Stream event log', ctx.store.getTurnEventsForExport(selectors.turnId), [
      `${turnPath}/runtime/events.jsonl`,
    ]);
    record(
      'Turn human feedback',
      [o.feedback.readTurnFeedback(ctx.store, selectors.turnId)],
      [`${turnPath}/feedback.json`]
    );
    record(
      'AgentSession',
      [ctx.store.getAgentSession(selectors.agentSessionId)],
      [`${workspacePath}/runtime/agent-sessions/${selectors.agentSessionId}/session.json`]
    );
    const inline = ctx.store.getArtifact(selectors.workspaceId, selectors.inlineArtifactId);
    record(
      'Artifact record and inline content',
      [inline],
      [
        `${workspacePath}/artifacts/${inline.id}/artifact.json`,
        `${workspacePath}/artifacts/${inline.id}/files`,
      ]
    );
    const original = ctx.store.getArtifact(selectors.workspaceId, selectors.fileArtifactId);
    o.fileRecords.verifyArtifactFilePayload({
      workspaceRoot,
      artifactId: original.id,
      version: 1,
      byteLength: original.content.byteLength,
      contentDigest: original.contentDigest,
    });
    record(
      'Artifact original file payload',
      [original],
      [`${workspacePath}/artifacts/${original.id}/versions/1/payload`]
    );
    const notebookValues = [],
      notebookPaths = [],
      schemaValues = [],
      schemaPaths = [];
    for (const { scope } of selectors.notebooks) {
      const path =
        scope === 'workspace'
          ? `${workspacePath}/knowledge`
          : scope === 'user'
            ? `users/${selectors.userId}/memory`
            : 'server/knowledge';
      const notebook = new o.notebook.KnowledgeNotebook({
        repositoryPath: join(r.data, path, 'notebook.git'),
      });
      const revision = notebook.readRevision(notebook.publishedRevision());
      notebookValues.push({ scope, ...revision });
      notebookPaths.push(`${path}/notebook.git`);
      const schema = o.okf.parseScopeKnowledgeSchema(
        readFileSync(join(r.data, path, 'schema', 'scope-schema.yaml'), 'utf8')
      );
      if (!schema.ok) throw new Error('Retained notebook schema is invalid.');
      schemaValues.push({ scope, schema: schema.schema });
      schemaPaths.push(`${path}/schema/scope-schema.yaml`);
    }
    record('Notebook content and history', notebookValues, notebookPaths);
    record('Notebook scope schema', schemaValues, schemaPaths);
    record(
      'Knowledge Proposal',
      [ctx.store.getKnowledgeProposal(selectors.proposalId)],
      [`${workspacePath}/knowledge/proposals/${selectors.proposalId}.md`]
    );
    record(
      'Knowledge Proposal Review',
      ctx.store.listKnowledgeProposalReviewDecisions(selectors.workspaceId, selectors.proposalId),
      [`${workspacePath}/knowledge/reviews/${selectors.proposalId}.json`]
    );
    record(
      'Knowledge observation ledger',
      ctx.store.listKnowledgeObservations(selectors.workspaceId),
      [`${workspacePath}/knowledge/observations`]
    );
    record('Knowledge claim ledger', ctx.store.listKnowledgeClaims(selectors.workspaceId), [
      `${workspacePath}/knowledge/claims`,
    ]);
    record('Knowledge conflict ledger', ctx.store.listKnowledgeConflicts(selectors.workspaceId), [
      `${workspacePath}/knowledge/conflicts`,
    ]);
    record(
      'Workspace Source identity',
      [ctx.store.getKnowledgeSource(selectors.workspaceId, selectors.sourceId)],
      [`${workspacePath}/sources/registry/${selectors.sourceId}.json`]
    );
    record(
      'Workspace captured Source text',
      [ctx.store.readKnowledgeSourceMaterial(selectors.workspaceId, selectors.sourceId)],
      [`${workspacePath}/sources/materials/${selectors.sourceId}/content.txt`]
    );
    const userSource = o.sources.readUserKnowledgeSource(ctx, selectors.userSourceId);
    record(
      'User Source identity',
      [userSource.source],
      [`users/${selectors.userId}/sources/registry/${selectors.userSourceId}.json`]
    );
    record(
      'User captured Source text',
      [userSource.content],
      [`users/${selectors.userId}/sources/materials/${selectors.userSourceId}/content.txt`]
    );
    record(
      'Memory suppression',
      [
        ...o.memory.readMemorySuppressions(
          o.layout.userMemoryRoot(r.data, selectors.userId),
          selectors.userId
        ),
      ],
      [`users/${selectors.userId}/memory/observations`]
    );
    const catalog = o.catalog.loadWorkspaceResourceCatalog(r.data, selectors.workspaceId);
    record('Resource catalog', [catalog], [`${workspacePath}/catalog/catalog.json`]);
    const portable = o.portableCatalog.projectWorkspaceCatalogExport(r.data, selectors.workspaceId);
    const plugins = catalog.plugins.versions.map((version) => {
      const tree = o.configSchema.digestOpenKitTree(
        join(
          workspaceRoot,
          'catalog',
          'plugin-snapshots',
          version.entryId,
          version.digest.slice(7)
        ),
        { maxBytes: 64 * 1024 * 1024, maxEntries: 4096 }
      );
      if (tree.digest !== version.digest) throw new Error('Retained Plugin tree digest mismatch.');
      return { entryId: version.entryId, digest: tree.digest };
    });
    record(
      'Immutable Skill and Plugin packages',
      [portable, ...plugins],
      [`${workspacePath}/catalog/skill-snapshots`, `${workspacePath}/catalog/plugin-snapshots`]
    );
    const mutableBytes = bytesAt(r.data, `${workspacePath}/catalog/mcp-data`, 'data');
    record(
      'Mutable MCP process data',
      [{ opaque: true, fileCount: mutableBytes.length }],
      [`${workspacePath}/catalog/mcp-data`]
    );
    const config = o.configSchema.WorkspaceConfigSchema.parse(
      o.jsonc.parseJsoncObject(
        readFileSync(join(workspaceRoot, 'config', 'workspace.jsonc'), 'utf8'),
        'synthetic workspace config'
      )
    );
    record('Authored settings and Policy', [config], [`${workspacePath}/config/workspace.jsonc`]);
    const vaultRoot = join(r.corpus, 'vault-store'),
      key = readFileSync(join(r.corpus, 'vault-key.bin'));
    let material;
    try {
      o.vault.initializeOrVerifyEncryptedFileVaultStore({ storeDir: vaultRoot, masterKey: key });
      material = o.vault.openEncryptedFileVaultEntry({
        storeDir: vaultRoot,
        referenceId: selectors.vaultReferenceId,
        version: 1,
        masterKey: key,
      });
      record(
        'Encrypted Vault store',
        [{ materialDigest: sha256(material), version: 1 }],
        [],
        ['file-corpus/vault-store']
      );
    } finally {
      key.fill(0);
      material?.fill(0);
    }
    const exportRoot = o.transfer.existingWorkspaceExportRoot(
      r.data,
      selectors.workspaceId,
      selectors.exportId
    );
    const exported = o.exports.verifyWorkspaceExportTree({ exportRoot });
    record('Workspace export', [exported.manifest], [relative(r.data, exportRoot)]);
    const backup = o.backup.verifyDataRootBackupManifest({
      backupRoot: join(r.corpus, 'data-root-backup'),
    });
    record('Data Root backup', [backup.manifest], [], ['file-corpus/data-root-backup']);
    const closureRoot = o.closure.existingWorkspaceDeletionClosureRoot(
      r.data,
      selectors.workspaceId,
      selectors.closure.closureId
    );
    const closure = o.closure.verifyWorkspaceDeletionClosure({ ...selectors.closure, closureRoot });
    record('Workspace deletion closure', [closure], [relative(r.data, closureRoot)]);
    record(
      'Query-owned retrieval traces',
      [
        o.traces.readRetrievalTrace(
          workspaceRoot,
          selectors.retrievalTraceReference,
          'conversation'
        ),
      ],
      [`${workspacePath}/${o.traces.retrievalTraceRelativePath(selectors.retrievalTraceReference)}`]
    );
  } finally {
    ctx.userDb.sqlite.close();
    ctx.coreDb.sqlite.close();
  }
  return JSON.parse(JSON.stringify(result));
}

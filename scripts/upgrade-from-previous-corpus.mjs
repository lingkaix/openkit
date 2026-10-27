import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
  'Artifact current-head record',
  'Immutable Artifact versions',
  'Artifact original payload',
  'Conversation original file inputs',
  'Notebook content and history',
  'Notebook scope schema',
  'Knowledge Proposal',
  'Knowledge Proposal Review',
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
  'Unaccepted Workspace capture source',
]);

/** Mutable metadata compared through native snapshots rather than disposable file projections. */
export const NATIVE_METADATA_FAMILIES = Object.freeze([
  'Workspace record',
  'Thread record',
  'Turn record',
  'AgentSession',
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
    controlWorker: 'storage/control-store-worker-client.js',
    db: 'storage/db.js',
    migrate: 'storage/migrate.js',
    layout: 'storage/fs-layout.js',
    records: 'storage/workspace-file-records.js',
    products: 'storage/control-store-products.js',
    notebook: 'knowledge/notebook.js',
    notebookOwner: 'knowledge/scoped-notebook-owner.js',
    knowledgeBase: 'config/knowledge-base.js',
    okf: 'knowledge/okf.js',
    pageFixture: 'test-support/knowledge-page.js',
    sources: 'knowledge/scoped-knowledge-sources.js',
    sourcePublisher: 'knowledge/source-publication.js',
    sourcePointers: 'knowledge/source-pointers.js',
    sourceReader: 'knowledge/source-reading.js',
    notebookAdmission: 'knowledge/notebook-workspace-admission.js',
    runtimeConfig: 'config/runtime-config.js',
    mutationAdmission: 'workspace-mutation-admission.js',
    memory: 'knowledge/memory-maintenance.js',
    membership: 'workspace-membership.js',
    feedback: 'runtime/feedback.js',
    catalog: 'catalog/resource-catalog.js',
    portableCatalog: 'catalog/catalog-portability.js',
    fileAdmission: 'storage/artifacts/file-admission.js',
    filePayload: 'storage/artifacts/file-payload.js',
    vault: 'vault/vault-encrypted-file-store.js',
    transfer: 'storage/workspace-transfer-routes.js',
    exports: 'storage/workspace-export.js',
    backup: 'storage/data-root-backup.js',
    closure: 'workspace-deletion-evidence.js',
    traces: 'storage/retrieval-traces.js',
    snapshotChain: 'runtime/workspace-snapshot-chain.js',
    jsonc: 'config/jsonc.js',
    tokens: 'auth/access-token-store.js',
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

/** Opens existing User authority with the selected release's current admin-Token projection, without account or Token mutation. */
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
    const adminTokenId =
      user.kind === 'local' ? null : o.tokens.resolveSessionDeploymentAdminTokenId(coreDb, userId);
    if (user.kind !== 'local' && !adminTokenId)
      throw new Error('Corpus User requires current deployment administrator authority.');
    userDb = o.db.openUserDb(dataRoot, userId);
    if (initialize) o.migrate.applyScopedMigrations(userDb);
    return {
      coreDb,
      userDb,
      actor: {
        kind: user.kind === 'local' ? 'local' : 'session',
        userId,
        ...(adminTokenId ? { adminTokenId } : {}),
      },
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
    const workspace = await ctx.store.createWorkspace('B01 upgrade continuity', {
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
    const thread = await ctx.store.createThread(workspace.id, 'Retained B01 history');
    selectors.threadId = thread.id;
    const inputSource = join(r.corpus, 'input-original.bin');
    writeFileSync(inputSource, FIXTURE.original, { flag: 'wx', mode: 0o600 });
    const turn = await ctx.store.createTurn(workspace.id, thread.id, FIXTURE.text, producer, null, {
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
    // File-corpus entries must exceed the inline boundary; native inline bodies have separate coverage.
    let completedItem;
    for (const item of [
      { type: 'user-message', actor: producer, text: FIXTURE.text.repeat(2_000) },
      {
        type: 'assistant-message',
        text: 'Public synthetic previous-release response.'.repeat(2_000),
      },
      {
        type: 'command-execution',
        command: 'printf fixture',
        cwd: '/workspace',
        output: 'fixture'.repeat(10_000),
        exitCode: 0,
        durationMs: 1,
      },
    ]) {
      const stored = await ctx.store.createItem({
        owner: turn.owner,
        threadId: thread.id,
        turnId: turn.id,
        id: o.protocol.allocateEntityId('it'),
        ...item,
        status: 'completed',
        createdAt: FIXTURE.at,
        completedAt: FIXTURE.at,
      });
      completedItem ??= stored;
    }
    const completedEvent = await ctx.store.persistTurnEvent(turn.id, {
      ...lineage,
      event: 'item.completed',
      requestId: randomUUID(),
      data: { type: 'item-completed', itemId: completedItem.id, item: completedItem },
    });
    ctx.store.emitTurnEvent(turn.id, completedEvent);
    selectors.agentSessionId = o.protocol.allocateEntityId('as');
    await ctx.store.createAgentSession({
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
    await ctx.store.createArtifact(inline);
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
      await ctx.store.createArtifact(original, staged);
    } finally {
      await staged.remove();
      reservation.release();
    }
    selectors.sourceId = o.protocol.allocateEntityId('ks');
    const sourceDb = o.db.openWorkspaceDb(r.data, workspace.id);
    try {
      o.migrate.applyScopedMigrations(sourceDb);
      const requestId = randomUUID();
      const source = {
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
      };
      const notebook = new o.notebook.KnowledgeNotebook({
        repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
      });
      const runtimeConfigManager = {
        current: () => o.runtimeConfig.createInMemoryRuntimeConfigSnapshot({ dataRoot: r.data }),
      };
      const workspaceMutationAdmission = new o.mutationAdmission.WorkspaceMutationAdmission();
      await o.sourcePublisher.publishCapturedSource(
        {
          owner: { dataRoot: r.data, ownerScope: { kind: 'workspace', workspaceId: workspace.id } },
          database: { kind: 'workspace', workspaceDb: sourceDb },
          access: {
            store: ctx.store,
            coreDb: ctx.coreDb,
            actor: producer,
            requestActor: ctx.actor,
          },
          producer,
          requestId,
          commandInput: source,
          captureChannel: 'knowledge.source.register',
          revalidatePublication: () =>
            o.notebookAdmission.readWorkspaceNotebookAdmission({
              store: ctx.store,
              coreDb: ctx.coreDb,
              workspaceDb: sourceDb,
              actor: producer,
              requestActor: ctx.actor,
              notebook,
              runtimeConfigManager,
              workspaceMutationAdmission,
              request: {
                workspaceId: workspace.id,
                requestId,
                baseRevision: notebook.publishedRevision(),
                changes: [],
                summary: 'Capture public corpus evidence.',
              },
            }),
        },
        source,
        Buffer.from(FIXTURE.text)
      );
    } finally {
      sourceDb.sqlite.close();
    }
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
      const content = o.pageFixture.serializeKnowledgePageFixture(
        {
          title: 'Public synthetic continuity',
          content: FIXTURE.text,
          createdAt: FIXTURE.at,
          updatedAt: FIXTURE.at,
        },
        ownerScope
      );
      const changes = { 'continuity.md': content };
      if (scope === 'workspace') {
        const knowledgeBaseId = o.knowledgeBase.readDefaultKnowledgeBaseId({
          dataRoot: r.data,
          scope: ownerScope,
        });
        const pageScopeId = `page/workspace/${workspace.id}/${knowledgeBaseId}`;
        const claim = o.okf.updateOkfFrontmatter({
          path: 'continuity-claim.md',
          content,
          updates: { type: 'Claim', openkit_entry_id: 'continuity-claim', confidence: 0.75 },
        });
        changes['continuity-claim.md'] = claim;
        changes['continuity-assessment.md'] = o.okf.updateOkfFrontmatter({
          path: 'continuity-assessment.md',
          content,
          updates: {
            type: 'Observation',
            openkit_entry_id: 'continuity-assessment',
            openkit_status: 'draft',
            status: 'draft',
            conflict_status: 'unresolved',
            subject_refs: [
              o.protocol.formatReferenceUri(
                { scopeId: pageScopeId, objectId: 'continuity-claim' },
                `sha256:${sha256(claim)}`
              ),
            ],
          },
        });
      }
      const candidateRevision = notebook.prepare({
        baseRevision,
        changes,
        metadata: {
          summary: 'Public synthetic upgrade fixture',
          producer,
          authority: { kind: 'direct', instructionReference: 'fixture:upgrade-from-previous' },
          changeRequest: {
            requestId: randomUUID(),
            inputDigest: `sha256:${sha256(JSON.stringify(changes))}`,
          },
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
    const candidatePage = o.pageFixture.serializeKnowledgePageFixture(
      {
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
    // Raw source is unaccepted evidence; these synthetic claims grant no physical admission.
    const packageSnapshotId = 'b01-public-unaccepted-package';
    selectors.rawCaptureIdentity = o.snapshotChain.WorkspaceCollectionIdentitySchema.parse({
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      agentSessionId: selectors.agentSessionId,
      storageRef: o.protocol.allocateEntityId('wst'),
      scopeDigest: `sha256:${sha256(Buffer.from('B01 synthetic raw source scope'))}`,
      attachmentGeneration: 1,
      sandboxId: 'b01-synthetic-source-sandbox',
      workSlot: 'b01-source-slot',
      packageSnapshotId,
      collectionId: `turn-end-${sha256(Buffer.from(packageSnapshotId))}`,
    });
    const captureStaging = join(workspaceRoot, 'runtime', 'staging');
    mkdirSync(captureStaging, { recursive: true, mode: 0o700 });
    const capturePath = join(mkdtempSync(join(captureStaging, 'b01-capture-')), 'complete');
    writeFileSync(capturePath, FIXTURE.original, { flag: 'wx', mode: 0o600 });
    await o.snapshotChain.preserveRawWorkspaceCapture({
      dataRoot: r.data,
      identity: selectors.rawCaptureIdentity,
      result: {
        outcome: 'candidate',
        sha256: `sha256:${sha256(FIXTURE.original)}`,
        byteLength: FIXTURE.original.length,
        head: { tree: '3'.repeat(40), manifest: '4'.repeat(40) },
        previousHead: { tree: '1'.repeat(40), manifest: '2'.repeat(40) },
        acceptedBase: { tree: '1'.repeat(40), manifest: '2'.repeat(40) },
        unstable: false,
      },
      staged: { bytes: FIXTURE.original, path: capturePath },
      admission: new o.fileAdmission.FileStorageAdmission(r.data, () => 0n),
    });
    // Seed before logical export and cold backup; only full Data Root backup retains this source.
    await seedRemainingFiles(o, ctx, r, selectors, producer, workspaceRoot);
  } finally {
    await o.controlWorker.shutdownControlStoreWorkerClient();
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
  await ctx.store.updateTurn(selectors.turnId, {
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
  const exported = await o.transfer.createVerifiedWorkspaceExport({
    fileAdmission: new o.fileAdmission.FileStorageAdmission(r.data, () => 0n),
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
    if (!result[family].bytes.length && !NATIVE_METADATA_FAMILIES.includes(family))
      throw new Error(`${family}: retained bytes are missing.`);
  };
  try {
    const rawCapture = await o.snapshotChain.readRawWorkspaceCapture(
      r.data,
      selectors.rawCaptureIdentity
    );
    record(
      'Unaccepted Workspace capture source',
      rawCapture ? [{ identity: rawCapture.identity, result: rawCapture.result }] : [],
      [
        `${workspacePath}/evidence/backend/workspace-capture/${selectors.rawCaptureIdentity.collectionId}`,
      ]
    );
    record('Layout marker', [o.layout.readDataRootLayoutMarker(r.data)], ['server/layout.json']);
    const scope = o.records.nativeProductScope(r.data, {
      kind: 'workspace',
      workspaceId: selectors.workspaceId,
    });
    const nativeRecord = (family, kind, id) => {
      const snapshot = o.records.readNativeProduct(scope, kind, id);
      if (!snapshot) throw new Error(`${family}: no native reader result.`);
      record(family, [{ owner: scope.owner, ...snapshot }], []);
    };
    nativeRecord('Workspace record', 'workspace', selectors.workspaceId);
    nativeRecord('Thread record', 'thread', selectors.threadId);
    nativeRecord('Turn record', 'turn', selectors.turnId);
    // Ordered native entries retain their exact immutable payload bytes and revision facts.
    const nativeEntries = (family, kind) => {
      const values = o.records.readNativeProductEntries(scope, selectors.turnId, kind);
      const reader = o.products.openControlStoreProductReadHandle(scope.path, scope.owner);
      const paths = [];
      try {
        let after = 0;
        for (;;) {
          const page = reader.entries(selectors.turnId, kind, after);
          if (!page.length) break;
          for (const entry of page) {
            paths.push(
              relative(r.data, join(scope.contentMount.root, entry.content.reference.locator.path))
            );
            after = entry.sequence;
          }
        }
      } finally {
        reader.close();
      }
      record(family, values, paths);
    };
    const fileTurn = ctx.store.getTurnById(selectors.turnId);
    o.records.verifyTurnFileInputs(workspaceRoot, fileTurn);
    record(
      'Conversation original file inputs',
      [fileTurn.fileInputs],
      [`${turnPath}/inputs/0/payload`]
    );
    nativeEntries('Item revision log', 'item');
    nativeEntries('Stream event log', 'event');
    record(
      'Turn human feedback',
      [o.feedback.readTurnFeedback(ctx.store, selectors.turnId)],
      [`${turnPath}/feedback.json`]
    );
    nativeRecord('AgentSession', 'agent-session', selectors.agentSessionId);
    const inline = ctx.store.getArtifact(selectors.workspaceId, selectors.inlineArtifactId);
    const original = ctx.store.getArtifact(selectors.workspaceId, selectors.fileArtifactId);
    const versions = [inline, original].map((artifact) =>
      ctx.store.getArtifactVersion(selectors.workspaceId, artifact.id, artifact.version)
    );
    record(
      'Artifact current-head record',
      [inline, original],
      [
        `${workspacePath}/artifacts/${inline.id}/artifact.json`,
        `${workspacePath}/artifacts/${inline.id}/files`,
        `${workspacePath}/artifacts/${original.id}/artifact.json`,
      ]
    );
    record(
      'Immutable Artifact versions',
      versions,
      versions.map(
        ({ artifact }) =>
          `${workspacePath}/artifacts/${artifact.id}/versions/${artifact.version}/version-record.json`
      )
    );
    record(
      'Artifact original payload',
      versions.map(({ artifact }) => artifact),
      versions.map(
        ({ artifact }) =>
          `${workspacePath}/artifacts/${artifact.id}/versions/${artifact.version}/payload`
      )
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
    const sourceOwner = {
      dataRoot: r.data,
      ownerScope: { kind: 'workspace', workspaceId: selectors.workspaceId },
    };
    const workspaceSource = o.sourcePointers
      .readSourcePointers(sourceOwner)
      .get(selectors.sourceId);
    if (!workspaceSource) throw new Error('Corpus Source pointer is unavailable.');
    record(
      'Workspace Source identity',
      [ctx.store.getKnowledgeSource(selectors.workspaceId, selectors.sourceId)],
      [`${workspacePath}/knowledge/notebook.git`]
    );
    const sourceText = await o.sourceReader.readManagedSourceText({
      owner: sourceOwner,
      access: {
        store: ctx.store,
        coreDb: ctx.coreDb,
        actor: { kind: 'user', id: selectors.userId },
        requestActor: ctx.actor,
      },
      pointer: workspaceSource,
    });
    if (sourceText.status !== 'ok') throw new Error('Corpus Source original is unavailable.');
    record(
      'Workspace captured Source text',
      [sourceText.value],
      [`${workspacePath}/knowledge/raw/${workspaceSource.fields.contentRef.locator.path}`]
    );
    const userSource = await o.sources.readUserKnowledgeSource(ctx, selectors.userSourceId);
    if (!userSource) throw new Error('Corpus User Source is unavailable.');
    record(
      'User Source identity',
      [userSource.source],
      [`users/${selectors.userId}/memory/notebook.git`]
    );
    record(
      'User captured Source text',
      [userSource.content],
      [`users/${selectors.userId}/memory/raw/sources/${selectors.userSourceId}/original`]
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
    await o.controlWorker.shutdownControlStoreWorkerClient();
    ctx.userDb.sqlite.close();
    ctx.coreDb.sqlite.close();
  }
  return JSON.parse(JSON.stringify(result));
}

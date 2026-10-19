// openkit-test-platform: posix
// Current native scope admission and real Source/Storage effects are distinct from Worker exposure.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActorRef, allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { LocalStorage } from '@openkit/storage';
import { describe, expect, it, onTestFinished } from 'vitest';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { readDefaultKnowledgeBaseId, readKnowledgeMounts } from '../config/knowledge-base.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import {
  admitKnowledgeRetrieval,
  type KnowledgeRetrievalAccess,
} from '../retrieval-knowledge-adapter.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { resolveKnowledgeMeaningReference } from './knowledge-meaning-reference.js';
import { deriveManagedSourceAccess } from './managed-source-access.js';
import { KnowledgeNotebook } from './notebook.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';
import { readSourceByteRange } from './source-bytes.js';
import { publishCapturedSource } from './source-publication.js';
import { readManagedSourceText } from './source-reading.js';

const original = 'Native Knowledge work keeps exact originals.\r\nΩ 雪.\n';
const digest = `sha256:${createHash('sha256').update(Buffer.from(original)).digest('hex')}`;

/** Current membership and native Notebook admission supply authority without minting a credential or lease. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'source-native-role-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Native Knowledge authority');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const actor = { kind: 'agent' as const, id: 'knowledge-manager', responsibleUserId: userId };
  const access: KnowledgeRetrievalAccess = { store, coreDb, actor };
  const ownerScope = { kind: 'workspace' as const, workspaceId: workspace.id };
  const owner = { dataRoot, ownerScope };
  const knowledgeBaseId = readDefaultKnowledgeBaseId({ dataRoot, scope: ownerScope });
  const mount = readKnowledgeMounts({ dataRoot, scope: ownerScope }).find(
    (candidate) => candidate.default
  )!;
  const root = join(dataRoot, 'workspaces', workspace.id, 'knowledge');
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const runtimeConfigManager = {
    current: () => ({ workspaceConfigs: [] }),
  } as unknown as RuntimeConfigManager;
  const currentAuthority = (subject: ActorRef) => {
    if (!currentWorkspaceAuthority(coreDb, workspace.id, subject, 'knowledge.write', true))
      throw new OperationError(
        'workspace_access_denied',
        'Current native Knowledge admission denied.',
        403
      );
  };
  const revalidatePublication = (subject: ActorRef) => {
    currentAuthority(subject);
    readWorkspaceNotebookAdmission({
      store,
      coreDb,
      workspaceDb,
      currentAuthority: () => currentAuthority(subject),
      actor: { kind: 'user', id: userId },
      runtimeConfigManager,
      workspaceMutationAdmission,
      notebook,
      request: {
        workspaceId: workspace.id,
        requestId: randomUUID(),
        baseRevision: notebook.publishedRevision(),
        changes: [],
        summary: 'Native Source capture.',
      },
    });
  };
  const now = new Date().toISOString();
  const source = {
    id: allocateEntityId('ks'),
    kind: 'document' as const,
    title: 'Native exact original',
    contentDigest: digest,
    uri: null,
    originatingThreadId: null,
    originatingTurnId: null,
    originatingFileId: null,
    capturedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const publish = (
    selected: KnowledgeRetrievalAccess,
    producer: Extract<ActorRef, { kind: 'user' | 'agent' }>
  ) =>
    publishCapturedSource(
      {
        owner,
        database: { kind: 'workspace', workspaceDb },
        access: selected,
        producer,
        requestId: randomUUID(),
        commandInput: source,
        captureChannel: 'knowledge.source.register',
        revalidatePublication: () => revalidatePublication(selected.actor),
      },
      source,
      Buffer.from(original)
    );
  onTestFinished(() => {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    dataRoot,
    coreDb,
    workspaceDb,
    userId,
    store,
    workspace,
    actor,
    access,
    ownerScope,
    owner,
    knowledgeBaseId,
    mount,
    root,
    notebook,
    source,
    publish,
    revalidatePublication,
  };
}

describe('native role Source authority and Worker raw exposure', () => {
  it('admits the accountable native KM without a public credential, captures and reads, then honors current disable', async () => {
    const f = fixture();
    expect(f.access).not.toHaveProperty('requestActor');
    expect(
      currentWorkspaceAuthority(f.coreDb, f.workspace.id, f.actor, 'knowledge.read', true)
    ).toBe('member');
    expect(
      currentWorkspaceAuthority(f.coreDb, f.workspace.id, f.actor, 'knowledge.write', true)
    ).toBe('member');
    expect(() =>
      admitKnowledgeRetrieval({ workspaceId: f.workspace.id, access: f.access })
    ).not.toThrow();
    expect(() => f.revalidatePublication(f.actor)).not.toThrow();
    const input = {
      owner: f.owner,
      knowledgeBaseId: f.knowledgeBaseId,
      mount: f.mount,
      access: f.access,
      consumer: 'native' as const,
      mode: 'read-only' as const,
    };
    const native = deriveManagedSourceAccess(input);
    expect.soft(native).toEqual({
      basis: 'knowledge',
      ownerScope: f.ownerScope,
      knowledgeBaseId: f.knowledgeBaseId,
      mount: f.mount.name,
      pathPrefix: 'sources',
      mode: 'read-only',
    });
    const publication = f.publish(f.access, f.actor);
    await expect(publication).resolves.toMatchObject({
      source: { id: f.source.id, contentDigest: digest },
      fields: {
        byteLength: Buffer.byteLength(original),
        contentRef: { knowledgeBaseId: f.knowledgeBaseId, contentDigest: digest },
      },
    });
    const pointer = await publication;
    const revision = f.notebook.publishedRevision();
    expect(f.notebook.readSourcePointers(revision)[f.source.id]).toBe(pointer.content);
    expect(f.notebook.readRevision(revision).metadata.producer).toEqual(f.actor);
    const audit = f.workspaceDb.sqlite
      .prepare("SELECT actor_json FROM audit_events WHERE action = 'knowledge.source.register'")
      .get() as { actor_json: string };
    expect(JSON.parse(audit.actor_json)).toEqual(f.actor);
    expect(native).not.toHaveProperty('grantId');
    expect(native).not.toHaveProperty('expiresAt');
    expect(native).not.toHaveProperty('revoked');
    await expect(
      readManagedSourceText({ owner: f.owner, pointer, access: f.access })
    ).resolves.toEqual({ status: 'ok', value: original });
    expect(deriveManagedSourceAccess({ ...input, consumer: 'worker' })).toBeNull();
    const storage = new LocalStorage({
      mounts: [
        {
          name: f.mount.name,
          knowledgeBaseId: f.knowledgeBaseId,
          ownerScope: f.ownerScope,
          root: join(f.root, 'raw'),
          managed: true,
        },
      ],
      stagingRoot: join(f.root, '.source-staging'),
    });
    try {
      await expect(
        readSourceByteRange({
          storage,
          pointer,
          admit: () => deriveManagedSourceAccess({ ...input, consumer: 'worker' }),
          offset: 0,
          length: 64,
        })
      ).resolves.toEqual({ status: 'denied' });
    } finally {
      await storage.close();
    }
    f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.userId))();
    expect(
      currentWorkspaceAuthority(f.coreDb, f.workspace.id, f.actor, 'knowledge.read', true)
    ).toBeNull();
    expect(deriveManagedSourceAccess(input)).toBeNull();
    await expect(
      readManagedSourceText({ owner: f.owner, pointer, access: f.access })
    ).resolves.toEqual({ status: 'denied' });
    expect(f.notebook.publishedRevision()).toBe(revision);
  });

  it('keeps actual Worker-shaped raw meaning unavailable despite the responsible member’s native Knowledge rights', async () => {
    const f = fixture();
    const human = { kind: 'user' as const, id: f.userId };
    const humanAccess: KnowledgeRetrievalAccess = {
      store: f.store,
      coreDb: f.coreDb,
      actor: human,
      requestActor: { kind: 'local', userId: f.userId },
    };
    const pointer = await f.publish(humanAccess, human);
    const reference = formatReferenceUri(
      {
        scopeId: `raw/workspace/${f.workspace.id}/${f.knowledgeBaseId}`,
        objectId: pointer.fields.contentRef.locator.path,
      },
      digest
    );
    await expect(
      resolveKnowledgeMeaningReference({
        workspaceId: f.workspace.id,
        reference,
        access: humanAccess,
      })
    ).resolves.toMatchObject({ status: 'available', content: original, contentDigest: digest });
    const thread = f.store.createThread(
      f.workspace.id,
      'Worker destination',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const sessionId = allocateEntityId('as');
    const turn = f.store.createTurn(
      f.workspace.id,
      thread.id,
      'Inspect exact meaning.',
      human,
      null,
      { agentId: 'agent_codex_host', agentSessionId: sessionId }
    );
    const now = new Date().toISOString();
    const session = f.store.createAgentSession({
      id: sessionId,
      agentId: turn.agentId!,
      workspaceId: f.workspace.id,
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: now,
      updatedAt: now,
    });
    // Use the exact current Worker fields projected by native Kernel and context assembly.
    const access: KnowledgeRetrievalAccess = {
      store: f.store,
      coreDb: f.coreDb,
      actor: turn.triggerActor,
      outputThreadId: thread.id,
      outputTurnId: turn.id,
      resourcePolicyActor: {
        kind: 'agent',
        userId: f.userId,
        agentId: turn.agentId!,
        processId: session.id,
      },
    };
    expect(access).not.toHaveProperty('requestActor');
    expect(() => admitKnowledgeRetrieval({ workspaceId: f.workspace.id, access })).not.toThrow();
    await expect(
      resolveKnowledgeMeaningReference({ workspaceId: f.workspace.id, reference, access })
    ).resolves.toEqual({ status: 'unavailable', reference });
    expect(f.notebook.readSourcePointers(f.notebook.publishedRevision())[f.source.id]).toBe(
      pointer.content
    );
  });
});

// openkit-test-platform: posix
// LocalStorage verifies actual fixture bytes through descriptor-confined mounts.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeMount } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { LocalStorage, type StorageContent } from '@openkit/storage';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseJsoncObject } from '../config/jsonc.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import type { KnowledgeRetrievalAccess } from '../retrieval-knowledge-adapter.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  recordWorkspaceOwnerMembership,
  resolveWorkspaceMembershipRelation,
} from '../workspace-membership.js';
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  removeWorkspaceMember,
} from '../workspace-sharing.js';

// Keep the Storage contract case independently runnable from the Native admission owner.
const nativeFactoryModule = './managed-source-access.js';

/** Real current human memberships and scoped KBs; no Policy statement, lease or host mount is created. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-managed-source-authority-'));
  const coreDb = openCoreDb(dataRoot);
  let storage: LocalStorage | undefined;
  onTestFinished(async () => {
    try {
      await storage?.close();
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
  applyMigrations(coreDb);
  const store = new FsStore({ dataRoot });
  const subjects = ['A', 'B'].map((name) => {
    const userId = allocateEntityId('usr');
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, status) VALUES (?, 'human', ?, ?, 0, ?, ?, 'active')"
      )
      .run(userId, name, `${userId}@example.invalid`, Date.now(), Date.now());
    const workspaceId = store.createWorkspace(`Source owner ${name}`, {
      requestId: randomUUID(),
      producer: { kind: 'user', id: userId },
      instructionReference: 'test:managed-source-authority',
    }).id;
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
    const ownerScope = { kind: 'workspace', workspaceId } as const;
    const knowledgeBaseId = readDefaultKnowledgeBaseId({ dataRoot, scope: ownerScope });
    const mount: KnowledgeMount = {
      name: 'managed',
      backend: 'local',
      root: 'raw',
      default: true,
      knowledgeBaseId,
    };
    const root = join(dataRoot, 'workspaces', workspaceId, 'knowledge', 'raw');
    mkdirSync(join(root, 'sources'), { recursive: true });
    const bytes = Buffer.from(`Exact original for ${name}.\n`);
    writeFileSync(join(root, 'sources', 'original.bin'), bytes);
    const content: StorageContent = {
      reference: {
        knowledgeBaseId,
        contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        locator: { ownerScope, mount: 'managed', path: 'sources/original.bin' },
        range: null,
        availability: 'available',
      },
      byteLength: bytes.byteLength,
      mediaType: 'application/octet-stream',
    };
    const access: KnowledgeRetrievalAccess = {
      coreDb,
      store,
      actor: { kind: 'user', id: userId },
      requestActor: { kind: 'session', userId },
    };
    return {
      userId,
      workspaceId,
      root,
      bytes,
      content,
      input: {
        owner: { dataRoot, ownerScope },
        knowledgeBaseId,
        mount,
        access,
        consumer: 'native' as const,
        mode: 'read-only' as const,
      },
    };
  });
  const [a, b] = subjects as [(typeof subjects)[number], (typeof subjects)[number]];
  const externalRoot = join(dataRoot, 'external-originals');
  mkdirSync(join(externalRoot, 'sources'), { recursive: true });
  writeFileSync(join(externalRoot, 'sources', 'original.bin'), a.bytes);
  const externalMount: KnowledgeMount = {
    name: 'external',
    backend: 'local',
    root: externalRoot,
    default: false,
    knowledgeBaseId: a.input.knowledgeBaseId,
  };
  const configPath = join(dataRoot, 'workspaces', a.workspaceId, 'config', 'workspace.jsonc');
  const config = parseJsoncObject(readFileSync(configPath, 'utf8'));
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      workspace: {
        ...(config.workspace as Record<string, unknown>),
        knowledgeMounts: [a.input.mount, externalMount],
      },
    })
  );
  const mounts = [
    ...subjects.map((subject) => ({
      knowledgeBaseId: subject.input.knowledgeBaseId,
      ownerScope: subject.input.owner.ownerScope,
      name: 'managed',
      root: subject.root,
      managed: true,
    })),
    {
      knowledgeBaseId: a.input.knowledgeBaseId,
      ownerScope: a.input.owner.ownerScope,
      name: 'external',
      root: externalRoot,
      managed: false,
    },
  ];
  const stagingRoot = join(dataRoot, 'staging');
  mkdirSync(stagingRoot);
  storage = new LocalStorage({ mounts, stagingRoot });
  const knowledgeAccess = {
    basis: 'knowledge' as const,
    ownerScope: a.input.owner.ownerScope,
    knowledgeBaseId: a.input.knowledgeBaseId,
    mount: 'managed',
    pathPrefix: 'sources',
    mode: 'read-only' as const,
  };
  return { coreDb, storage, a, b, externalMount, knowledgeAccess };
}

describe('request-local managed Source authority', () => {
  it('admits current Knowledge bytes on an explicitly managed Storage mount without a lease', async () => {
    const f = fixture();
    await expect(
      f.storage.read({ access: f.knowledgeAccess, content: f.a.content, offset: 0, length: 64 })
    ).resolves.toEqual({
      status: 'ok',
      value: { data: f.a.bytes.toString('base64'), offset: 0, nextOffset: null },
    });
    await expect(
      f.storage.read({ access: f.knowledgeAccess, content: f.b.content, offset: 0, length: 64 })
    ).resolves.toEqual({ status: 'denied' });
    await expect(
      f.storage.read({
        access: { ...f.knowledgeAccess, mount: 'external' },
        content: {
          ...f.a.content,
          reference: {
            ...f.a.content.reference,
            locator: { ...f.a.content.reference.locator, mount: 'external' },
          },
        },
        offset: 0,
        length: 64,
      })
    ).resolves.toEqual({ status: 'denied' });
  });

  it('derives native A authority without lease facts and cannot use it for KB B', async () => {
    const { deriveManagedSourceAccess } = await import(nativeFactoryModule);
    const f = fixture();
    const access = deriveManagedSourceAccess(f.a.input);
    expect(access).toMatchObject(f.knowledgeAccess);
    for (const field of ['grantId', 'expiresAt', 'revoked'])
      expect(access).not.toHaveProperty(field);
    await expect(
      f.storage.read({ access, content: f.a.content, offset: 0, length: 64 })
    ).resolves.toMatchObject({ status: 'ok', value: { data: f.a.bytes.toString('base64') } });
    await expect(
      f.storage.read({ access, content: f.b.content, offset: 0, length: 64 })
    ).resolves.toEqual({ status: 'denied' });
    expect(deriveManagedSourceAccess({ ...f.b.input, access: f.a.input.access })).toBeNull();
    expect(
      deriveManagedSourceAccess({ ...f.a.input, knowledgeBaseId: f.b.input.knowledgeBaseId })
    ).toBeNull();
  });

  it('denies the next native read admission after current Workspace membership is removed', async () => {
    const { deriveManagedSourceAccess } = await import(nativeFactoryModule);
    const f = fixture();
    const invitation = f.coreDb.sqlite.transaction(() =>
      createWorkspaceInvitation({
        coreDb: f.coreDb,
        workspaceId: f.a.workspaceId,
        inviterUserId: f.a.userId,
        inviteeEmail: `${f.b.userId}@example.invalid`,
      })
    )();
    expect(invitation.kind).toBe('created');
    if (invitation.kind !== 'created') throw new Error('Fixture member invitation failed.');
    const accepted = f.coreDb.sqlite.transaction(() =>
      acceptWorkspaceInvitation({
        coreDb: f.coreDb,
        workspaceId: f.a.workspaceId,
        invitationId: invitation.invitation.invitationId,
        inviteeUserId: f.b.userId,
        expectedRevision: invitation.invitation.revision,
      })
    )();
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('Fixture member admission failed.');
    const memberInput = { ...f.a.input, access: f.b.input.access };
    expect(deriveManagedSourceAccess(memberInput)).toMatchObject(f.knowledgeAccess);
    const removed = f.coreDb.sqlite.transaction(() =>
      removeWorkspaceMember({
        coreDb: f.coreDb,
        workspaceId: f.a.workspaceId,
        actorUserId: f.a.userId,
        memberUserId: f.b.userId,
        expectedRevision: accepted.member.revision,
      })
    )();
    expect(removed.kind).toBe('removed');
    expect(resolveWorkspaceMembershipRelation(f.coreDb, f.a.workspaceId, f.a.userId)).toBe('owner');
    expect(deriveManagedSourceAccess(memberInput)).toBeNull();
  });

  it('does not turn responsible human Knowledge authority into Worker raw exposure', async () => {
    const { deriveManagedSourceAccess } = await import(nativeFactoryModule);
    const f = fixture();
    expect(deriveManagedSourceAccess(f.a.input)).toMatchObject(f.knowledgeAccess);
    expect(deriveManagedSourceAccess({ ...f.a.input, consumer: 'worker' })).toBeNull();
  });

  it('does not extend current Knowledge authority to a declared external local mount', async () => {
    const { deriveManagedSourceAccess } = await import(nativeFactoryModule);
    const f = fixture();
    expect(deriveManagedSourceAccess(f.a.input)).toMatchObject(f.knowledgeAccess);
    expect(deriveManagedSourceAccess({ ...f.a.input, mount: f.externalMount })).toBeNull();
  });
});

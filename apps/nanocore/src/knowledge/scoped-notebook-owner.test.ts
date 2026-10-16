import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeOwnerScope } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  verifyOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { openCoreDb, openUserDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook, NotebookError } from './notebook.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './okf.js';
import {
  initializeScopedNotebook,
  pinScopedNotebook,
  resolveScopedNotebookOwner,
} from './scoped-notebook-owner.js';

const alice = 'usr_00000000-0000-7000-8000-000000000001';
const bob = 'usr_00000000-0000-7000-8000-000000000002';

/** Isolated current identity, Token, User Audit and real Git owners; all bytes are removed after the test. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'scoped-notebook-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  for (const id of [alice, bob])
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES (?, ?, ?, false, ?, ?, 'human')"
      )
      .run(id, id === alice ? 'Alice' : 'Bob', `${id}@example.invalid`, Date.now(), Date.now());
  const userDb = openUserDb(dataRoot, alice);
  applyScopedMigrations(userDb);
  const actor: Actor = { kind: 'session', userId: alice };
  const initialization = { requestId: randomUUID(), instructionReference: 'creation:test' };
  onTestFinished(() => {
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    dataRoot,
    coreDb,
    userDb,
    actor,
    initialization,
    initializeUser: () =>
      initializeScopedNotebook({
        coreDb,
        actor,
        target: { kind: 'user' },
        userDb,
        initialization,
      }),
    /** Authenticate the real issued bearer before constructing its trusted native actor. */
    admin: (userId = bob): Actor => {
      const issued = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: userId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      const verified = verifyOpenKitAccessTokenRecord(coreDb, issued.secret);
      if (!verified) throw new Error('Test bearer must authenticate.');
      return {
        kind: 'token',
        userId: verified.ownerUserId,
        tokenId: verified.tokenId,
        tokenScope: verified.scope,
      };
    },
  };
}

/** Governed v4 content uses the exact trusted owner mapping, separate from Git revision and page digest. */
function page(ownerScope: KnowledgeOwnerScope, body = 'Exact first bytes.\r\n'): string {
  return `---\ntype: KnowledgePage\ntitle: Personal note\nschema_version: openkit-scope-knowledge-schema-v4\nrequiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]\nopenkit_status: active\nstatus: stable\nscope: ${JSON.stringify(ownerScope)}\nsource_refs: []\nreview_state: user-authored\nsensitivity: normal\nfreshness: current\ncreated_at: "2026-10-16T00:00:00.000Z"\nupdated_at: "2026-10-16T00:00:00.000Z"\n---\n${body}`;
}

/** Low-level Git publisher represents later native lifecycle integration; it supplies no scope or disclosure grant. */
function publish(notebook: KnowledgeNotebook, files: Record<string, string>): string {
  const baseRevision = notebook.publishedRevision();
  const candidateRevision = notebook.prepare({
    baseRevision,
    changes: files,
    metadata: notebook.readRevision(baseRevision).metadata,
  });
  return notebook.publish({ baseRevision, candidateRevision }).revision;
}

describe('User Memory and Server Knowledge scope foundation', () => {
  it('initializes a self-owned empty notebook with scope-homed Audit and schema without touching another root', () => {
    const f = fixture();
    const revision = f.initializeUser();
    const input = { coreDb: f.coreDb, actor: f.actor, target: { kind: 'user' } as const };
    const owner = resolveScopedNotebookOwner(input);
    expect(owner).toEqual({
      ownerScope: { kind: 'user', userId: alice },
      notebookRoot: join(f.dataRoot, 'users', alice, 'memory'),
    });
    const pinned = pinScopedNotebook(input);
    expect(pinned.notebookRevision).toBe(revision);
    expect(pinned.read()).toMatchObject({
      revision,
      parentRevision: null,
      files: { 'index.md': DEFAULT_NOTEBOOK_INDEX },
      metadata: { producer: { kind: 'user', id: alice } },
    });
    expect(readFileSync(join(owner.notebookRoot, 'schema', 'scope-schema.yaml'), 'utf8')).toBe(
      DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT
    );
    const rows = f.userDb.sqlite
      .prepare(
        'SELECT action, notebook_admission_json AS evidence FROM audit_events ORDER BY rowid'
      )
      .all() as Array<{ action: string; evidence: string }>;
    expect(rows.map(({ action }) => action)).toEqual([
      'knowledge.notebook.admit',
      'knowledge.notebook.initialize',
    ]);
    expect(JSON.parse(rows[0]!.evidence)).toMatchObject({
      ownerScope: owner.ownerScope,
      candidateRevision: revision,
      producer: { kind: 'user', id: alice },
    });
    expect(existsSync(join(f.dataRoot, 'server', 'knowledge'))).toBe(false);
    expect(existsSync(join(f.dataRoot, 'users', bob, 'memory'))).toBe(false);
    expect(() => f.initializeUser()).toThrow(NotebookError);
  });

  it('refuses a different User Audit owner before fresh notebook effects', () => {
    const f = fixture();
    const foreignDb = openUserDb(f.dataRoot, bob);
    applyScopedMigrations(foreignDb);
    try {
      expect(() =>
        initializeScopedNotebook({
          coreDb: f.coreDb,
          actor: f.actor,
          target: { kind: 'user' },
          userDb: foreignDb,
          initialization: f.initialization,
        })
      ).toThrow('Notebook invalid request.');
      expect(existsSync(join(f.dataRoot, 'users', alice, 'memory'))).toBe(false);
      expect(foreignDb.sqlite.prepare('SELECT * FROM audit_events').all()).toEqual([]);
    } finally {
      foreignDb.sqlite.close();
    }
  });

  it('refuses ordinary foreign inspection before notebook reads, including a forged cached admin fact', () => {
    const f = fixture();
    f.initializeUser();
    const input = {
      coreDb: f.coreDb,
      actor: { kind: 'session', userId: bob, adminTokenId: 'untrusted-cached-fact' } as Actor,
      target: { kind: 'user-inspection', userId: alice } as const,
    };
    // Removing the repository makes an attempted content read distinguishable from admission refusal.
    rmSync(join(f.dataRoot, 'users', alice, 'memory', 'notebook.git'), { recursive: true });
    expect(() => pinScopedNotebook(input)).toThrow('Scoped notebook access denied.');
    expect(() => resolveScopedNotebookOwner(input)).toThrow('Scoped notebook access denied.');
  });

  it('does not convert a Workspace credential into User Memory authority', () => {
    const f = fixture();
    f.initializeUser();
    const issued = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: alice,
      scope: 'workspace',
      workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const verified = verifyOpenKitAccessTokenRecord(f.coreDb, issued.secret)!;
    const actor: Actor = {
      kind: 'token',
      userId: verified.ownerUserId,
      tokenId: verified.tokenId,
      tokenScope: verified.scope,
      tokenWorkspaceIds: verified.workspaceIds,
    };
    expect(() => pinScopedNotebook({ coreDb: f.coreDb, actor, target: { kind: 'user' } })).toThrow(
      'Scoped notebook access denied.'
    );
    expect(() =>
      pinScopedNotebook({
        coreDb: f.coreDb,
        actor,
        target: { kind: 'user-inspection', userId: bob },
      })
    ).toThrow('Scoped notebook access denied.');
  });

  it('admits current administrative inspection while keeping me bound to the administrator, then refuses revocation', () => {
    const f = fixture();
    f.initializeUser();
    const actor = f.admin();
    const input = {
      coreDb: f.coreDb,
      actor,
      target: { kind: 'user-inspection', userId: alice } as const,
    };
    const pinned = pinScopedNotebook(input);
    expect(pinned.ownerScope).toEqual({ kind: 'user', userId: alice });
    expect(pinned.read().files['index.md']).toBe(DEFAULT_NOTEBOOK_INDEX);
    expect(resolveScopedNotebookOwner({ ...input, target: { kind: 'user' } }).ownerScope).toEqual({
      kind: 'user',
      userId: bob,
    });
    revokeOpenKitAccessTokenRecord(f.coreDb, actor.tokenId!);
    expect(() => pinned.read()).toThrow('Scoped notebook access denied.');
    expect(() => pinScopedNotebook(input)).toThrow('Scoped notebook access denied.');
    expect(() => resolveScopedNotebookOwner({ ...input, target: { kind: 'user' } })).toThrow(
      'Scoped notebook access denied.'
    );
  });

  it('uses current session administrator eligibility and refuses disabled or missing owners', () => {
    const f = fixture();
    f.initializeUser();
    const actor: Actor = { kind: 'session', userId: bob };
    const input = {
      coreDb: f.coreDb,
      actor,
      target: { kind: 'user-inspection', userId: alice } as const,
    };
    expect(() => pinScopedNotebook(input)).toThrow('Scoped notebook access denied.');
    const admin = f.admin();
    expect(pinScopedNotebook(input).read().files['index.md']).toBe(DEFAULT_NOTEBOOK_INDEX);
    revokeOpenKitAccessTokenRecord(f.coreDb, admin.tokenId!);
    expect(() => pinScopedNotebook(input)).toThrow('Scoped notebook access denied.');
    const currentAdmin = f.admin();
    f.coreDb.sqlite.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(alice);
    expect(() => pinScopedNotebook({ ...input, actor: currentAdmin })).toThrow(
      'Scoped notebook access denied.'
    );
    expect(() => pinScopedNotebook({ ...input, actor: f.actor, target: { kind: 'user' } })).toThrow(
      'Scoped notebook access denied.'
    );
    expect(() =>
      resolveScopedNotebookOwner({
        ...input,
        actor: currentAdmin,
        target: { kind: 'user-inspection', userId: 'usr_00000000-0000-7000-8000-000000000003' },
      })
    ).toThrow('Scoped notebook access denied.');
    f.coreDb.sqlite.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(bob);
    expect(() => resolveScopedNotebookOwner({ ...input, actor: currentAdmin })).toThrow(
      'Scoped notebook access denied.'
    );
  });

  it('keeps Server and User roots independent and requires the current administrator for Server access', () => {
    const f = fixture();
    const userRevision = f.initializeUser();
    const input = { coreDb: f.coreDb, actor: f.actor, target: { kind: 'server' } as const };
    expect(() => pinScopedNotebook(input)).toThrow('Scoped notebook access denied.');
    const actor = f.admin();
    const revision = initializeScopedNotebook({
      ...input,
      actor,
      initialization: f.initialization,
    });
    const owner = resolveScopedNotebookOwner({ ...input, actor });
    expect(owner).toEqual({
      ownerScope: { kind: 'server' },
      notebookRoot: join(f.dataRoot, 'server', 'knowledge'),
    });
    expect(pinScopedNotebook({ ...input, actor }).read().revision).toBe(revision);
    expect(
      pinScopedNotebook({ ...input, target: { kind: 'user' }, actor: f.actor }).read().revision
    ).toBe(userRevision);
    const rows = f.coreDb.sqlite
      .prepare(
        "SELECT notebook_admission_json AS evidence FROM audit_events WHERE action = 'knowledge.notebook.initialize'"
      )
      .all() as Array<{ evidence: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.evidence)).toMatchObject({
      ownerScope: { kind: 'server' },
      producer: { kind: 'user', id: bob },
      candidateRevision: revision,
    });
    revokeOpenKitAccessTokenRecord(f.coreDb, actor.tokenId!);
    expect(() => pinScopedNotebook({ ...input, actor })).toThrow('Scoped notebook access denied.');
  });

  it('does not initialize during a read or replace missing retained authority', () => {
    const f = fixture();
    const input = { coreDb: f.coreDb, actor: f.actor, target: { kind: 'user' } as const };
    const root = join(f.dataRoot, 'users', alice, 'memory');
    expect(() => pinScopedNotebook(input)).toThrow(NotebookError);
    expect(existsSync(root)).toBe(false);
    f.initializeUser();
    rmSync(join(root, 'notebook.git'), { recursive: true });
    expect(() => pinScopedNotebook(input)).toThrow(NotebookError);
    expect(() => f.initializeUser()).toThrow(NotebookError);
    expect(existsSync(join(root, 'notebook.git'))).toBe(false);
  });

  it('pins exact page bytes across later publication and refuses a page with another owner', () => {
    const f = fixture();
    f.initializeUser();
    const input = { coreDb: f.coreDb, actor: f.actor, target: { kind: 'user' } as const };
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(f.dataRoot, 'users', alice, 'memory', 'notebook.git'),
    });
    const text = page({ kind: 'user', userId: alice });
    const revision = publish(notebook, { 'note.md': text });
    const pinned = pinScopedNotebook(input);
    publish(notebook, { 'note.md': page({ kind: 'user', userId: alice }, 'Later bytes.\n') });
    expect(pinned.notebookRevision).toBe(revision);
    expect(pinned.read().files['note.md']).toBe(text);
    expect(pinScopedNotebook(input).read().files['note.md']).not.toBe(text);
    const schemaPath = join(f.dataRoot, 'users', alice, 'memory', 'schema', 'scope-schema.yaml');
    rmSync(schemaPath);
    expect(() => pinned.read()).toThrow(NotebookError);
    expect(existsSync(schemaPath)).toBe(false);
    writeFileSync(schemaPath, DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT);
    publish(notebook, { 'note.md': page({ kind: 'user', userId: bob }) });
    expect(() => pinScopedNotebook(input).read()).toThrow(NotebookError);
  });
});

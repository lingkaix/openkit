import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRecordEnvelope } from '@openkit/config-schema';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { createOpenKitAccessTokenRecord, revokeOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openUserDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import {
  editMemoryPage,
  listMemoryPages,
  readMemoryPage,
  recordMemorySuppression,
  saveMemoryPage,
} from './memory-lifecycle.js';
import { KnowledgeNotebook } from './notebook.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';
import { publishScopedNotebook } from './scoped-notebook-publication.js';

const alice = 'usr_00000000-0000-7000-8000-000000000001';
const bob = 'usr_00000000-0000-7000-8000-000000000002';

/** Real self admission, scoped SQLite receipts and immutable Git pages supply the oracle. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-native-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  for (const userId of [alice, bob])
    coreDb.sqlite.prepare(
      "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES (?, ?, ?, false, ?, ?, 'human')"
    ).run(userId, userId, `${userId}@example.invalid`, Date.now(), Date.now());
  const userDb = openUserDb(dataRoot, alice);
  applyScopedMigrations(userDb);
  onTestFinished(() => {
    vi.restoreAllMocks();
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const input = {
    coreDb, userDb, actor: { kind: 'session' as const, userId: alice },
    store: new FsStore(), runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
    inflightCommands: new WeakMap(),
  };
  const baseRevision = initializeScopedNotebook({ ...input, target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:fresh-memory' } });
  const root = join(dataRoot, 'users', alice, 'memory');
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const request = (base = baseRevision, pageId = 'preferences', body = 'Exact private text.\r\n') => ({
    requestId: randomUUID(), baseRevision: base, pageId,
    content: serializeUserAuthoredKnowledgePage({ id: pageId, kind: 'preference', title: 'Private title',
      content: body, sourceReferences: [], createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z' }, { kind: 'user', userId: alice }),
    summary: 'Save my exact preference',
  });
  return { input, notebook, root, request, baseRevision };
}

describe('explicit native self Memory', () => {
  it('saves, lists and reads exact authored bytes, edits one fixed base and replays the original receipt', async () => {
    const f = fixture();
    const request = f.request();
    const saved = await saveMemoryPage(f.input, request);
    const selected = readMemoryPage(f.input, request.pageId);
    expect(selected).toMatchObject({ content: request.content, notebookRevision: saved.notebookRevision,
      digest: `sha256:${createHash('sha256').update(request.content).digest('hex')}` });
    expect(listMemoryPages(f.input)).toMatchObject({ notebookRevision: saved.notebookRevision,
      pages: [{ id: request.pageId, title: 'Private title', path: `${request.pageId}.md` }] });
    const edit = f.request(saved.notebookRevision, request.pageId, 'Human changed bytes.\n');
    const updated = await editMemoryPage(f.input, edit);
    expect(readMemoryPage(f.input, request.pageId)?.content).toBe(edit.content);
    expect(await saveMemoryPage({ ...f.input, store: new FsStore(), inflightCommands: new WeakMap() }, request)).toEqual(saved);
    expect(f.notebook.publishedRevision()).toBe(updated.notebookRevision);
    await expect(editMemoryPage(f.input, f.request(saved.notebookRevision))).rejects.toMatchObject({ code: 'conflict' });
    await expect(saveMemoryPage(f.input, f.request(updated.notebookRevision))).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('refuses foreign handles, Workers and disabled current authority without returning private metadata', async () => {
    const f = fixture();
    await saveMemoryPage(f.input, f.request());
    expect(() => listMemoryPages({ ...f.input, actor: { kind: 'session', userId: bob } })).toThrow('Scoped notebook access denied.');
    const worker = { ...f.input, actor: { kind: 'worker', userId: alice } } as unknown as typeof f.input;
    expect(() => listMemoryPages(worker)).toThrow('Scoped notebook access denied.');
    f.input.coreDb.sqlite.transaction(() => disableCanonicalUser(f.input.coreDb, alice))();
    expect(() => readMemoryPage(f.input, 'preferences')).toThrow('Scoped notebook access denied.');
    await expect(editMemoryPage(f.input, f.request(f.notebook.publishedRevision()))).rejects.toThrow('Scoped notebook access denied.');
  });

  it('refuses Source-bearing content and unsafe identities before effects', async () => {
    const f = fixture();
    const request = f.request();
    await expect(saveMemoryPage(f.input, { ...request, content: request.content.replace('source_refs: []', 'source_refs: ["source:private"]') })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(saveMemoryPage(f.input, { ...request, pageId: '../outside' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
    expect(listMemoryPages(f.input).pages).toEqual([]);
  });

  it('uses current bearer authority and recognizes personal sensitivity without widening restricted reads', async () => {
    const f = fixture();
    const issued = createOpenKitAccessTokenRecord(f.input.coreDb, { ownerUserId: alice, scope: 'server-admin',
      workspaceIds: [], expiresAt: '2999-01-01T00:00:00.000Z' });
    const bearer = { ...f.input, actor: { kind: 'token' as const, userId: alice, tokenId: issued.tokenId, tokenScope: 'server-admin' as const } };
    const request = f.request();
    const confidential = { ...request, content: request.content.replace('sensitivity: "normal"', 'sensitivity: "confidential"') };
    await saveMemoryPage(bearer, confidential);
    expect(readMemoryPage(bearer, request.pageId)?.sensitivity).toBe('confidential');
    await expect(editMemoryPage(bearer, { ...f.request(f.notebook.publishedRevision()),
      content: request.content.replace('sensitivity: "normal"', 'sensitivity: "restricted"') })).rejects.toMatchObject({ code: 'invalid_request' });
    revokeOpenKitAccessTokenRecord(f.input.coreDb, issued.tokenId);
    expect(() => listMemoryPages(bearer)).toThrow('Scoped notebook access denied.');
    await expect(saveMemoryPage(bearer, f.request(f.notebook.publishedRevision(), 'new'))).rejects.toThrow('Scoped notebook access denied.');
  });

  it('does not disclose retained Source-bearing metadata or bodies through the source-free self reader', async () => {
    const f = fixture();
    const request = f.request();
    const saved = await saveMemoryPage(f.input, request);
    // Seed exact retained bytes below publication admission to exercise the reader's independent source boundary.
    const candidateRevision = f.notebook.prepare({ baseRevision: saved.notebookRevision,
      changes: { 'preferences.md': request.content.replace('source_refs: []', 'source_refs: ["source:private"]') },
      metadata: f.notebook.readRevision(saved.notebookRevision).metadata });
    f.notebook.publish({ baseRevision: saved.notebookRevision, candidateRevision });
    expect(listMemoryPages(f.input).pages).toEqual([]);
    expect(readMemoryPage(f.input, request.pageId)).toBeNull();
  });

  it('hides suppressed identities and bytes across restart, retains only exact minimal evidence and reserves the id', async () => {
    const f = fixture();
    const request = f.request();
    const saved = await saveMemoryPage(f.input, request);
    const current = readMemoryPage(f.input, request.pageId)!;
    const suppression = { requestId: randomUUID(), pageId: current.id,
      notebookRevision: current.notebookRevision, digest: current.digest };
    expect(() => recordMemorySuppression(f.input, { ...suppression, digest: `sha256:${'0'.repeat(64)}` })).toThrow();
    const retained = recordMemorySuppression(f.input, suppression);
    expect(recordMemorySuppression(f.input, suppression)).toEqual(retained);
    const reopened = { ...f.input, store: new FsStore(), inflightCommands: new WeakMap() };
    expect(listMemoryPages(reopened).pages).toEqual([]);
    expect(readMemoryPage(reopened, request.pageId)).toBeNull();
    await expect(saveMemoryPage(reopened, request)).rejects.toThrow('Memory page unavailable.');
    await expect(publishScopedNotebook({ ...reopened, target: { kind: 'user' } }, {
      requestId: randomUUID(), baseRevision: saved.notebookRevision,
      changes: [{ path: `${request.pageId}.md`, content: f.request(saved.notebookRevision).content }], summary: 'Try old identity',
    })).rejects.toThrow('Memory page unavailable.');
    const ledger = readFileSync(join(f.root, 'observations', readdirSync(join(f.root, 'observations'))[0]!), 'utf8');
    expect(ledger).not.toContain('Exact private text');
    expect(ledger).not.toContain('Private title');
    expect(ledger.trim().split('\n')).toHaveLength(1);
    expect(() => parseRecordEnvelope(JSON.parse(ledger))).toThrow('Unsupported required feature: openkit.memory-suppression.v1');
    // Suppression precedes future Git/index cleanup; this primitive makes no erasure claim.
    expect(f.notebook.readRevision(saved.notebookRevision).files['preferences.md']).toBe(request.content);
  });

  it('rechecks suppression after candidate preparation before the Git CAS', async () => {
    const f = fixture();
    const saved = await saveMemoryPage(f.input, f.request());
    const selected = readMemoryPage(f.input, 'preferences')!;
    const prepare = KnowledgeNotebook.prototype.prepare;
    vi.spyOn(KnowledgeNotebook.prototype, 'prepare').mockImplementationOnce(function(this: KnowledgeNotebook, input) {
      const candidate = prepare.call(this, input);
      recordMemorySuppression(f.input, { requestId: randomUUID(), pageId: selected.id,
        notebookRevision: selected.notebookRevision, digest: selected.digest });
      return candidate;
    });
    await expect(editMemoryPage(f.input, f.request(saved.notebookRevision, 'preferences', 'Pending edit'))).rejects.toThrow('Memory page unavailable.');
    expect(f.notebook.publishedRevision()).toBe(saved.notebookRevision);
  });

  it('refuses malformed retained suppression without leaking decoder content or repairing bytes', async () => {
    const f = fixture();
    await saveMemoryPage(f.input, f.request());
    const selected = readMemoryPage(f.input, 'preferences')!;
    recordMemorySuppression(f.input, { requestId: randomUUID(), pageId: selected.id,
      notebookRevision: selected.notebookRevision, digest: selected.digest });
    const path = join(f.root, 'observations', readdirSync(join(f.root, 'observations'))[0]!);
    appendFileSync(path, '{"private":"must-not-leak"');
    const retained = readFileSync(path, 'utf8');
    expect(() => listMemoryPages(f.input)).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    expect(readFileSync(path, 'utf8')).toBe(retained);
  });
});

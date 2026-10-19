// openkit-test-platform: posix
// LocalStorage uses descriptor-confined access to actual fixture files.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { LocalStorage, type StorageAccess } from '@openkit/storage';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';
import { readSourceByteRange, readSourceText } from './source-bytes.js';
import { parseSourcePointer } from './source-pointers.js';

/** Real scoped identity and byte backend; the explicit test access makes no Policy-activation claim. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-source-bytes-'));
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
  const userId = ensureLocalUser(coreDb);
  initializeScopedNotebook({
    coreDb,
    actor: { kind: 'local', userId },
    target: { kind: 'server' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:source-byte-seam' },
  });
  const ownerScope = { kind: 'server' } as const;
  const knowledgeBaseId = readDefaultKnowledgeBaseId({ dataRoot, scope: ownerScope });
  const root = join(dataRoot, 'server', 'knowledge', 'raw');
  const stagingRoot = join(dataRoot, 'source-byte-staging');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(stagingRoot);
  const bytes = Buffer.from([0, 255, 128, 1, 2, 13, 10, 0, 100]);
  const path = join(root, 'docs', 'original.bin');
  writeFileSync(path, bytes);
  const reference = {
    knowledgeBaseId,
    contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    locator: { ownerScope, mount: 'managed', path: 'docs/original.bin' },
    range: null,
    availability: 'available',
  };
  const pointer = parseSourcePointer(
    { dataRoot, ownerScope },
    allocateEntityId('ks'),
    `---\n${JSON.stringify({
      okf_version: '0.2',
      type: 'SourceSummary',
      title: 'Opaque original',
      schema_version: 'openkit-scope-knowledge-schema-v4',
      openkit_status: 'active',
      scope: ownerScope,
      requiredFeatures: ['openkit.knowledge-owner-scope.v1', 'openkit.knowledge-git-notebook.v1'],
      source_refs: [],
      review_state: 'user-authored',
      sensitivity: 'internal',
      freshness: 'current',
      created_at: '2026-10-19T00:00:00.000Z',
      updated_at: '2026-10-19T00:00:00.000Z',
      contentRef: reference,
      byteLength: bytes.byteLength,
      mediaType: 'application/octet-stream',
      sourceKind: 'document',
      uri: null,
      capturedAt: '2026-10-19T00:00:00.000Z',
      captureChannel: 'knowledge.source.register',
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
    })}\n---\nAn admitted binary original.\n`
  );
  storage = new LocalStorage({
    mounts: [{ knowledgeBaseId, ownerScope, name: 'managed', root }],
    stagingRoot,
  });
  const access: StorageAccess = {
    grantId: allocateEntityId('grant'),
    knowledgeBaseId,
    ownerScope,
    mount: 'managed',
    pathPrefix: 'docs',
    mode: 'read-only',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revoked: false,
  };
  return { storage, access, pointer, reference, bytes, path };
}

describe('Native Source reads over LocalStorage', () => {
  it('returns an exact non-UTF8 byte range under the captured whole-original digest', async () => {
    const f = fixture();
    expect(f.pointer.fields.contentRef).toEqual(f.reference);
    await expect(
      readSourceByteRange({ ...f, admit: () => f.access, offset: 2, length: 5 })
    ).resolves.toEqual({ status: 'ok', value: f.bytes.subarray(2, 7) });
  });

  it('refuses binary text decoding while keeping the original byte route available', async () => {
    const f = fixture();
    await expect(readSourceText({ ...f, admit: () => f.access })).resolves.toEqual({
      status: 'unavailable',
      reason: 'unsupported',
      reference: f.reference,
    });
    await expect(
      readSourceByteRange({ ...f, admit: () => f.access, offset: 0, length: f.bytes.byteLength })
    ).resolves.toEqual({ status: 'ok', value: f.bytes });
  });

  it('refuses changed bytes outside the requested range instead of substituting the same path', async () => {
    const f = fixture();
    const changed = Buffer.from(f.bytes);
    changed[changed.length - 1] = 101;
    writeFileSync(f.path, changed);
    await expect(
      readSourceByteRange({ ...f, admit: () => f.access, offset: 0, length: 1 })
    ).resolves.toEqual({
      status: 'unavailable',
      reason: 'changed',
      reference: { ...f.reference, availability: 'unavailable' },
    });
  });

  it('denies a pointer read when current Native admission is absent', async () => {
    const f = fixture();
    await expect(
      readSourceByteRange({ ...f, admit: () => null, offset: 0, length: 1 })
    ).resolves.toEqual({ status: 'denied' });
  });

  it('rechecks current Native admission after the actual asynchronous byte read', async () => {
    const f = fixture();
    await expect(
      readSourceByteRange({ ...f, admit: () => f.access, offset: 0, length: 1 })
    ).resolves.toEqual({ status: 'ok', value: f.bytes.subarray(0, 1) });
    let current: StorageAccess | null = f.access;
    let admissions = 0;
    const pending = readSourceByteRange({
      ...f,
      offset: 0,
      length: 1,
      admit: () => {
        admissions += 1;
        return current;
      },
    });
    expect(admissions).toBe(1);
    current = null;
    // Storage's admitted projection stays valid, so only the Native delivery check can refuse it.
    expect(f.access.revoked).toBe(false);
    await expect(pending).resolves.toEqual({ status: 'denied' });
    expect(admissions).toBe(2);
  });
});

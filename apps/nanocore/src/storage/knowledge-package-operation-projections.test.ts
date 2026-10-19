// openkit-test-platform: posix
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { allocateEntityId, ContentReferenceSchema, formatReferenceUri } from '@openkit/protocol';
import { LocalStorage } from '@openkit/storage';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId, readKnowledgeMounts } from '../config/knowledge-base.js';
import { deriveManagedSourceAccess } from '../knowledge/managed-source-access.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { parseOkfDocument } from '../knowledge/okf.js';
import { readSourceByteRange } from '../knowledge/source-bytes.js';
import { readSourcePointers } from '../knowledge/source-pointers.js';
import { FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { captureWorkspaceSourceFixture } from '../test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

/** Measures actual bytes independently of the package writer and its manifest. */
function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Decodes only the classic regular-file/directory tar carrier used by this tiny fixture. */
function tarFiles(archive: Buffer): Map<string, { bytes: Buffer; offset: number }> {
  const files = new Map<string, { bytes: Buffer; offset: number }>();
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    expect(Number.isSafeInteger(size) && size >= 0).toBe(true);
    const type = header[156];
    expect([0, 48, 53], `Unexpected tar entry type for ${path}`).toContain(type);
    offset += 512;
    expect(offset + size).toBeLessThanOrEqual(archive.length);
    if (type !== 53) {
      expect(files.has(path), `Duplicate tar path: ${path}`).toBe(false);
      files.set(path, { bytes: archive.subarray(offset, offset + size), offset });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Reads actual canonical Git bytes at an exact revision without a materialized-page fallback. */
function publishedFile(root: string, revision: string, path: string): Buffer {
  return execFileSync('git', [
    `--git-dir=${join(root, 'notebook.git')}`,
    'show',
    `${revision}:${path}`,
  ]);
}

/** Records the exact destination Knowledge files without reading deployment or runtime state. */
function knowledgeFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(directory, entry.name), `${path}/`);
      else {
        expect(entry.isFile(), `Expected a regular Knowledge file: ${path}`).toBe(true);
        files[path] = readFileSync(join(directory, entry.name)).toString('base64');
      }
    }
  };
  visit(root);
  return files;
}

/** Supplies real local User, Workspace membership, fixed Knowledge bases and native HTTP dispatch. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-package-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const workspace = (name: string) => {
    const record = store.createWorkspace(name);
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: record.id, ownerUserId: userId });
    const root = join(dataRoot, 'workspaces', record.id, 'knowledge');
    return {
      id: record.id,
      root,
      notebook: new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') }),
      knowledgeBaseId: readDefaultKnowledgeBaseId({
        dataRoot,
        scope: { kind: 'workspace', workspaceId: record.id },
      }),
    };
  };
  const source = workspace('Knowledge package source');
  const target = workspace('Fresh Knowledge package target');
  const tamperTarget = workspace('Unchanged tamper target');
  const app = createApp({ coreDb, dataRoot, store });
  const call = async (
    operation: string,
    workspaceId: string,
    input: Record<string, unknown> = {}
  ) => {
    const response = await app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
      body: JSON.stringify({ workspaceId, ...input }),
    });
    const text = await response.text();
    return { status: response.status, body: text.startsWith('{') ? JSON.parse(text) : text };
  };
  const transfer = (operation: 'export' | 'import', workspaceId: string, bytes?: Buffer) => {
    // Split tiny fixture bytes across framing boundaries to exercise streamed request consumption.
    const body =
      bytes === undefined
        ? undefined
        : new ReadableStream<Uint8Array>({
            start(controller) {
              for (let offset = 0; offset < bytes.length; offset += 37)
                controller.enqueue(bytes.subarray(offset, offset + 37));
              controller.close();
            },
          });
    const request = new Request(
      `http://localhost/api/app/operations/knowledge.package.${operation}?workspaceId=${workspaceId}`,
      {
        method: 'POST',
        headers: {
          'x-openkit-request-id': randomUUID(),
          ...(bytes === undefined ? {} : { 'content-type': 'application/x-tar' }),
        },
        ...(body === undefined ? {} : { body, duplex: 'half' }),
      } as RequestInit & { duplex?: 'half' }
    );
    return app.fetch(request);
  };
  return { source, target, tamperTarget, call, transfer, dataRoot, coreDb, store, userId };
}

describe('Knowledge package public operation round trip', () => {
  it('preserves pinned Knowledge and binary originals, remints owned references, and refuses tampered bytes before publication', async () => {
    const f = fixture();
    const original = Buffer.from([0x00, 0xff, 0x80, 0x0d, 0x0a, 0x41, 0xc3, 0x28, 0x00]);
    const ownerScope = { kind: 'workspace' as const, workspaceId: f.source.id };
    const owner = { dataRoot: f.dataRoot, ownerScope };
    const mounts = readKnowledgeMounts({ dataRoot: f.dataRoot, scope: ownerScope });
    expect(mounts).toEqual([
      {
        name: 'managed',
        backend: 'local',
        root: 'raw',
        default: true,
        knowledgeBaseId: f.source.knowledgeBaseId,
      },
    ]);
    const mount = mounts[0]!;
    const sourceAccess = {
      store: f.store,
      coreDb: f.coreDb,
      actor: { kind: 'user' as const, id: f.userId },
      requestActor: { kind: 'local' as const, userId: f.userId },
    };
    const capturedAt = '2026-10-19T00:00:00.000Z';
    // The existing fixture composes current Notebook admission with the real binary Source publisher.
    const binarySource = await captureWorkspaceSourceFixture({
      dataRoot: f.dataRoot,
      store: f.store,
      coreDb: f.coreDb,
      userId: f.userId,
      source: {
        id: allocateEntityId('ks'),
        workspaceId: f.source.id,
        kind: 'document',
        title: 'Exact binary original',
        contentDigest: digest(original),
        uri: null,
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt,
        createdAt: capturedAt,
        updatedAt: capturedAt,
      },
      content: original,
    });
    const binaryPointer = readSourcePointers(owner).get(binarySource.id)!;
    expect(binaryPointer.source).toMatchObject({
      id: binarySource.id,
      contentDigest: digest(original),
    });
    expect(binaryPointer.fields).toMatchObject({
      byteLength: original.length,
      contentRef: {
        knowledgeBaseId: f.source.knowledgeBaseId,
        contentDigest: digest(original),
        locator: { ownerScope, mount: mount.name },
        availability: 'available',
      },
    });
    const rawPath = `raw/${binaryPointer.fields.contentRef.locator.path}`;
    const storage = new LocalStorage({
      mounts: [
        {
          knowledgeBaseId: mount.knowledgeBaseId,
          ownerScope,
          name: mount.name,
          root: resolve(f.source.root, mount.root),
          managed: true,
        },
      ],
      stagingRoot: join(f.source.root, '.source-staging'),
    });
    onTestFinished(() => storage.close());
    const admit = () =>
      deriveManagedSourceAccess({
        owner,
        knowledgeBaseId: f.source.knowledgeBaseId,
        mount,
        access: sourceAccess,
        consumer: 'native',
        mode: 'read-only',
      });
    expect(admit()).toEqual({
      basis: 'knowledge',
      knowledgeBaseId: f.source.knowledgeBaseId,
      ownerScope,
      mount: mount.name,
      pathPrefix: 'sources',
      mode: 'read-only',
    });
    const read = await readSourceByteRange({
      storage,
      pointer: binaryPointer,
      admit,
      offset: 0,
      length: original.length,
    });
    expect(read.status, 'Binary setup must use current Native authority and real Storage').toBe(
      'ok'
    );
    if (read.status !== 'ok') throw new Error('Binary Storage setup failed.');
    expect(read.value).toEqual(original);
    const schemaNames = readdirSync(join(f.source.root, 'schema')).filter((name) =>
      name.endsWith('.yaml')
    );
    expect(schemaNames).toHaveLength(1);
    const schemaPath = `schema/${schemaNames[0]}`;
    const schema = `${readFileSync(join(f.source.root, schemaPath), 'utf8')}\n# Authored package round-trip schema annotation.\n`;
    writeFileSync(join(f.source.root, schemaPath), schema);
    const capturedText = 'Exact Source original.\r\nUnicode Ω 雪.\n';
    const registered = await f.call('knowledge.source.register', f.source.id, {
      kind: 'document',
      title: 'Published original evidence',
      content: capturedText,
    });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    const sourcePin = `source:${registered.body.source.id}@${registered.body.source.contentDigest}`;
    const companionContent = serializeKnowledgePageFixture(
      {
        title: 'Companion',
        content: 'Independent companion page.',
        sourceReferences: [sourcePin],
        createdAt: capturedAt,
        updatedAt: capturedAt,
      },
      ownerScope
    );
    const companion = await f.call('knowledge.notebook.create', f.source.id, {
      baseRevision: f.source.notebook.publishedRevision(),
      path: 'nested/companion.md',
      content: companionContent,
      summary: 'Publish exact companion page.',
    });
    expect(companion.status, JSON.stringify(companion.body)).toBe(200);
    const companionBytes = f.source.notebook.readRevision(f.source.notebook.publishedRevision())
      .files['nested/companion.md']!;
    const companionUri = formatReferenceUri(
      {
        scopeId: `page/workspace/${f.source.id}/${f.source.knowledgeBaseId}`,
        objectId: 'nested/companion',
      },
      digest(companionBytes)
    );
    const originalUri = formatReferenceUri(
      {
        scopeId: `raw/workspace/${f.source.id}/${f.source.knowledgeBaseId}`,
        objectId: binaryPointer.fields.contentRef.locator.path,
      },
      digest(original)
    );
    const guideBody = `Exact guide: café 雪.\r\n[Original](../../${rawPath})\n[Qualified original](${originalUri})\n[Companion](${companionUri})`;
    const guideContent = serializeKnowledgePageFixture(
      {
        title: 'Package round-trip guide',
        content: guideBody,
        sourceReferences: [sourcePin, companionUri],
        createdAt: capturedAt,
        updatedAt: capturedAt,
      },
      ownerScope
    );
    const guide = await f.call('knowledge.notebook.create', f.source.id, {
      baseRevision: f.source.notebook.publishedRevision(),
      path: 'nested/guide.md',
      content: guideContent,
      summary: 'Publish exact package guide.',
    });
    expect(guide.status, JSON.stringify(guide.body)).toBe(200);
    const pinnedRevision = f.source.notebook.publishedRevision();
    const pinnedPages = f.source.notebook.readRevision(pinnedRevision).files;
    const admitted = await f.call('knowledge.notebook.list', f.source.id);
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
    expect(admitted.body.notebookRevision).toBe(pinnedRevision);
    expect(admitted.body.knowledgeBaseId).toBe(f.source.knowledgeBaseId);
    expect(admitted.body.pages).toContainEqual({
      id: 'nested/guide',
      path: 'nested/guide.md',
      content: guideContent,
      contentDigest: digest(guideContent),
    });
    const sourcePointers = readSourcePointers(owner, pinnedRevision);
    expect([...sourcePointers.keys()].sort()).toEqual(
      [binarySource.id, registered.body.source.id].sort()
    );
    expect(sourcePointers.get(registered.body.source.id)!.fields.contentRef.contentDigest).toBe(
      digest(capturedText)
    );
    expect(f.target.knowledgeBaseId).not.toBe(f.source.knowledgeBaseId);

    // Expected RED before implementation: valid authorized Notebook setup reaches the missing export operation.
    const exported = await f.transfer('export', f.source.id);
    expect(
      exported.status,
      `Public Knowledge package export: ${await exported.clone().text()}`
    ).toBe(200);
    expect(exported.headers.get('content-type')?.split(';')[0]).toBe('application/x-tar');
    const archive = Buffer.from(await exported.arrayBuffer());
    const files = tarFiles(archive);
    const manifest = JSON.parse(files.get('manifest.json')!.bytes.toString('utf8'));
    expect(manifest).toMatchObject({
      format: 'openkit.knowledge-package',
      schemaVersion: 1,
      ownerScope: { kind: 'workspace', workspaceId: f.source.id },
      knowledgeBaseId: f.source.knowledgeBaseId,
      notebookRevision: pinnedRevision,
    });
    expect(manifest).not.toHaveProperty('formatVersion');
    expect(manifest.mounts.filter((mount: { default: boolean }) => mount.default)).toEqual([
      expect.objectContaining({ backend: 'local', root: 'raw/' }),
    ]);
    expect(manifest.contentInventory.map((entry: { path: string }) => entry.path).sort()).toEqual(
      [...files.keys()].filter((path) => path !== 'manifest.json').sort()
    );
    for (const entry of manifest.contentInventory) {
      const bytes = files.get(entry.path)!.bytes;
      expect(entry.byteLength, entry.path).toBe(bytes.length);
      expect(entry.contentDigest, entry.path).toBe(digest(bytes));
    }
    for (const [path, bytes] of Object.entries(pinnedPages))
      expect(files.get(`pages/${path}`)?.bytes, path).toEqual(Buffer.from(bytes));
    expect(files.get(schemaPath)?.bytes).toEqual(Buffer.from(schema));
    expect(files.get(rawPath)?.bytes).toEqual(original);
    const pointerPath = `sources/${registered.body.source.id}.md`;
    expect(files.get(pointerPath)?.bytes).toEqual(
      publishedFile(f.source.root, pinnedRevision, pointerPath)
    );
    const binaryPointerPath = `sources/${binarySource.id}.md`;
    expect(files.get(binaryPointerPath)?.bytes).toEqual(
      publishedFile(f.source.root, pinnedRevision, binaryPointerPath)
    );

    const targetSeed = f.target.notebook.publishedRevision();
    const imported = await f.transfer('import', f.target.id, archive);
    expect(imported.status, await imported.clone().text()).toBe(200);
    const result = await imported.json();
    expect(result).toMatchObject({
      workspaceId: f.target.id,
      knowledgeBaseId: f.target.knowledgeBaseId,
    });
    expect(result.notebookRevision).toBe(f.target.notebook.publishedRevision());
    expect(result.notebookRevision).not.toBe(targetSeed);
    expect(f.target.notebook.readRevision(result.notebookRevision).parentRevision).toBe(targetSeed);
    expect(readFileSync(join(f.target.root, schemaPath))).toEqual(Buffer.from(schema));
    const listed = await f.call('knowledge.notebook.list', f.target.id);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.notebookRevision).toBe(result.notebookRevision);
    const targetSources = await f.call('knowledge.source.list', f.target.id);
    expect(targetSources.status, JSON.stringify(targetSources.body)).toBe(200);
    expect(targetSources.body.items).toHaveLength(2);
    const targetSource = targetSources.body.items.find(
      (source: { contentDigest: string }) => source.contentDigest === digest(capturedText)
    );
    const targetBinarySource = targetSources.body.items.find(
      (source: { contentDigest: string }) => source.contentDigest === digest(original)
    );
    expect(targetSource).toBeDefined();
    expect(targetBinarySource).toBeDefined();
    expect(targetSource.id).not.toBe(registered.body.source.id);
    expect(targetSource.contentDigest).toBe(registered.body.source.contentDigest);
    expect(targetBinarySource.id).not.toBe(binarySource.id);
    const targetOwnerScope = { kind: 'workspace' as const, workspaceId: f.target.id };
    expect(readKnowledgeMounts({ dataRoot: f.dataRoot, scope: targetOwnerScope })).toEqual([
      {
        name: 'managed',
        backend: 'local',
        root: 'raw',
        default: true,
        knowledgeBaseId: f.target.knowledgeBaseId,
      },
    ]);
    const targetBinaryPointer = readSourcePointers(
      { dataRoot: f.dataRoot, ownerScope: targetOwnerScope },
      result.notebookRevision
    ).get(targetBinarySource.id)!;
    expect(targetBinaryPointer.fields).toMatchObject({
      byteLength: original.length,
      contentRef: {
        knowledgeBaseId: f.target.knowledgeBaseId,
        contentDigest: digest(original),
        locator: { ownerScope: targetOwnerScope, mount: 'managed' },
        availability: 'available',
      },
    });
    expect(targetBinaryPointer.fields.contentRef.locator.path).toBe(
      binaryPointer.fields.contentRef.locator.path.replace(binarySource.id, targetBinarySource.id)
    );
    const targetRawPath = `raw/${targetBinaryPointer.fields.contentRef.locator.path}`;
    expect(readFileSync(join(f.target.root, targetRawPath))).toEqual(original);
    const targetPages = f.target.notebook.readRevision(result.notebookRevision).files;
    const targetCompanionUri = formatReferenceUri(
      {
        scopeId: `page/workspace/${f.target.id}/${f.target.knowledgeBaseId}`,
        objectId: 'nested/companion',
      },
      digest(targetPages['nested/companion.md']!)
    );
    const targetOriginalUri = formatReferenceUri(
      {
        scopeId: `raw/workspace/${f.target.id}/${f.target.knowledgeBaseId}`,
        objectId: targetBinaryPointer.fields.contentRef.locator.path,
      },
      digest(original)
    );
    const targetCompanion = parseOkfDocument({
      path: 'nested/companion.md',
      content: targetPages['nested/companion.md']!,
    });
    const targetGuide = parseOkfDocument({
      path: 'nested/guide.md',
      content: targetPages['nested/guide.md']!,
    });
    expect(targetCompanion.ok).toBe(true);
    expect(targetGuide.ok).toBe(true);
    if (!targetCompanion.ok || !targetGuide.ok)
      throw new Error('Imported Notebook page is invalid.');
    expect(targetCompanion.document.frontmatter).toMatchObject({
      type: 'KnowledgePage',
      title: 'Companion',
      scope: targetOwnerScope,
      source_refs: [`source:${targetSource.id}@${targetSource.contentDigest}`],
    });
    expect(targetCompanion.document.body).toBe('Independent companion page.\n');
    expect(targetGuide.document.frontmatter).toMatchObject({
      type: 'KnowledgePage',
      title: 'Package round-trip guide',
      scope: targetOwnerScope,
      source_refs: [`source:${targetSource.id}@${targetSource.contentDigest}`, targetCompanionUri],
    });
    expect(targetGuide.document.body).toBe(
      `${guideBody}\n`
        .replaceAll(companionUri, targetCompanionUri)
        .replaceAll(originalUri, targetOriginalUri)
        .replaceAll(`../../${rawPath}`, `../../${targetRawPath}`)
    );
    for (const path of ['nested/companion.md', 'nested/guide.md'])
      expect(listed.body.pages).toContainEqual({
        id: path.slice(0, -3),
        path,
        content: targetPages[path],
        contentDigest: digest(targetPages[path]!),
      });
    expect(targetPages['nested/guide.md']).not.toContain(f.source.id);
    expect(targetPages['nested/guide.md']).not.toContain(f.source.knowledgeBaseId);
    const targetPointer = publishedFile(
      f.target.root,
      result.notebookRevision,
      `sources/${targetSource.id}.md`
    ).toString('utf8');
    expect(targetPointer).toContain(f.target.knowledgeBaseId);
    expect(targetPointer).toContain(targetSource.contentDigest);
    expect(targetPointer).not.toContain(f.source.knowledgeBaseId);
    const parsedPointer = parseOkfDocument({
      path: `sources/${targetSource.id}.md`,
      content: targetPointer,
    });
    expect(parsedPointer.ok).toBe(true);
    if (!parsedPointer.ok) throw new Error('Imported Source pointer is invalid.');
    const contentRef = ContentReferenceSchema.parse(parsedPointer.document.frontmatter.contentRef);
    expect(contentRef).toMatchObject({
      knowledgeBaseId: f.target.knowledgeBaseId,
      contentDigest: digest(capturedText),
      locator: { ownerScope: { kind: 'workspace', workspaceId: f.target.id } },
      availability: 'available',
    });
    expect(readFileSync(join(f.target.root, 'raw', contentRef.locator.path))).toEqual(
      Buffer.from(capturedText)
    );
    expect(
      readDefaultKnowledgeBaseId({
        dataRoot: f.dataRoot,
        scope: { kind: 'workspace', workspaceId: f.target.id },
      })
    ).toBe(f.target.knowledgeBaseId);

    const beforeTamper = knowledgeFiles(f.tamperTarget.root);
    const tamperSeed = f.tamperTarget.notebook.publishedRevision();
    const tampered = Buffer.from(archive);
    const rawOffset = files.get(rawPath)!.offset;
    const firstByte = tampered[rawOffset];
    if (firstByte === undefined) throw new Error('Exported binary fixture is empty.');
    tampered[rawOffset] = firstByte ^ 1;
    const refused = await f.transfer('import', f.tamperTarget.id, tampered);
    expect(refused.status, await refused.clone().text()).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'invalid_request' });
    expect(f.tamperTarget.notebook.publishedRevision()).toBe(tamperSeed);
    expect(knowledgeFiles(f.tamperTarget.root)).toEqual(beforeTamper);
    expect(
      readDefaultKnowledgeBaseId({
        dataRoot: f.dataRoot,
        scope: { kind: 'workspace', workspaceId: f.tamperTarget.id },
      })
    ).toBe(f.tamperTarget.knowledgeBaseId);
  });
});

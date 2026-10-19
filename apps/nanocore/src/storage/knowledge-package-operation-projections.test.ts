// openkit-test-platform: posix
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, ContentReferenceSchema, formatReferenceUri } from '@openkit/protocol';
import { LocalStorage } from '@openkit/storage';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { parseOkfDocument } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
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
  return { source, target, tamperTarget, call, transfer, dataRoot };
}

describe('Knowledge package public operation round trip', () => {
  it('preserves pinned Knowledge and binary originals, remints owned references, and refuses tampered bytes before publication', async () => {
    const f = fixture();
    const original = Buffer.from([0x00, 0xff, 0x80, 0x0d, 0x0a, 0x41, 0xc3, 0x28, 0x00]);
    const rawPath = 'raw/original.bin';
    mkdirSync(join(f.source.root, 'raw'), { recursive: true });
    writeFileSync(join(f.source.root, rawPath), original);
    // This is a real local Storage fixture, not an invented binary Source registration API.
    const ownerScope = { kind: 'workspace' as const, workspaceId: f.source.id };
    const storage = new LocalStorage({
      mounts: [
        {
          knowledgeBaseId: f.source.knowledgeBaseId,
          ownerScope,
          name: 'fixture-local',
          root: join(f.source.root, 'raw'),
        },
      ],
      stagingRoot: join(f.dataRoot, 'fixture-staging'),
    });
    onTestFinished(() => storage.close());
    const access = {
      basis: 'lease' as const,
      grantId: allocateEntityId('grant'),
      knowledgeBaseId: f.source.knowledgeBaseId,
      ownerScope,
      mount: 'fixture-local',
      pathPrefix: '',
      mode: 'read-only' as const,
      expiresAt: '2099-01-01T00:00:00.000Z',
      revoked: false,
    };
    const observed = await storage.stat({
      access,
      locator: { ownerScope, mount: access.mount, path: 'original.bin' },
    });
    expect(observed.status, 'Binary setup must reach the real Storage owner').toBe('ok');
    if (observed.status !== 'ok') throw new Error('Binary Storage setup failed.');
    expect(observed.value.reference.contentDigest).toBe(digest(original));
    const read = await storage.read({
      access,
      content: observed.value,
      offset: 0,
      length: original.length,
    });
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') throw new Error('Binary Storage read failed.');
    expect(Buffer.from(read.value.data, 'base64')).toEqual(original);
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
    const companion = await f.call('knowledge.create', f.source.id, {
      baseRevision: f.source.notebook.publishedRevision(),
      knowledgePageId: 'nested/companion',
      kind: 'project-context',
      title: 'Companion',
      content: 'Independent companion page.',
      sourceReferences: [sourcePin],
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
        objectId: 'original.bin',
      },
      digest(original)
    );
    const guide = await f.call('knowledge.create', f.source.id, {
      baseRevision: f.source.notebook.publishedRevision(),
      knowledgePageId: 'nested/guide',
      kind: 'project-context',
      title: 'Package round-trip guide',
      content: `Exact guide: café 雪.\r\n[Original](../../raw/original.bin)\n[Qualified original](${originalUri})\n[Companion](${companionUri})`,
      sourceReferences: [sourcePin, companionUri],
    });
    expect(guide.status, JSON.stringify(guide.body)).toBe(200);
    const pinnedRevision = f.source.notebook.publishedRevision();
    const pinnedPages = f.source.notebook.readRevision(pinnedRevision).files;
    const admitted = await f.call('knowledge.list', f.source.id);
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
    expect(admitted.body.notebookRevision).toBe(pinnedRevision);
    expect(admitted.body.items).toContainEqual(expect.objectContaining({ id: 'nested/guide' }));
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
    expect(readFileSync(join(f.target.root, rawPath))).toEqual(original);
    expect(readFileSync(join(f.target.root, schemaPath))).toEqual(Buffer.from(schema));
    const listed = await f.call('knowledge.list', f.target.id);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.notebookRevision).toBe(result.notebookRevision);
    const targetSources = await f.call('knowledge.source.list', f.target.id);
    expect(targetSources.status, JSON.stringify(targetSources.body)).toBe(200);
    expect(targetSources.body.items).toHaveLength(1);
    const targetSource = targetSources.body.items[0];
    expect(listed.body.items).toContainEqual(
      expect.objectContaining({
        id: 'nested/companion',
        title: 'Companion',
        content: 'Independent companion page.',
        sourceReferences: [`source:${targetSource.id}@${targetSource.contentDigest}`],
      })
    );
    expect(targetSource.id).not.toBe(registered.body.source.id);
    expect(targetSource.contentDigest).toBe(registered.body.source.contentDigest);
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
        objectId: 'original.bin',
      },
      digest(original)
    );
    expect(listed.body.items).toContainEqual(
      expect.objectContaining({
        id: 'nested/guide',
        title: 'Package round-trip guide',
        content: guide.body.content
          .replaceAll(companionUri, targetCompanionUri)
          .replaceAll(originalUri, targetOriginalUri),
        sourceReferences: [
          `source:${targetSource.id}@${targetSource.contentDigest}`,
          targetCompanionUri,
        ],
      })
    );
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

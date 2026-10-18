// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, ContentReferenceSchema } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STORAGE_LIMITS,
  type StorageAccess,
  type StorageContent,
  type StorageLocator,
  type StorageResult,
} from './contract.js';
import { LocalStorage } from './local.js';

const fixtures: { directory: string; storage: LocalStorage }[] = [];

/** Exercise the JSON boundary, including response values that serialization would change. */
async function invoke<Request, Value>(
  operation: (request: Request) => Promise<StorageResult<Value>>,
  request: Request
): Promise<StorageResult<Value>> {
  const result = await operation(JSON.parse(JSON.stringify(request)) as Request);
  const transported = JSON.parse(JSON.stringify(result)) as StorageResult<Value>;
  expect(transported).toEqual(result);
  return transported;
}

/** A positive assertion makes scaffold refusals fail at behavior, not collection. */
function value<Value>(result: StorageResult<Value>): Value {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(`Expected success; got ${result.status}`);
  return result.value;
}

/** Derive the expected identity from fixture bytes independently of Storage. */
function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** One real mount and a separate staging area, each removed after the test. */
async function fixture(mode: StorageAccess['mode'] = 'read-only') {
  const directory = await mkdtemp(join(tmpdir(), 'storage-local-'));
  const root = join(directory, 'originals');
  const stagingRoot = join(directory, 'staging');
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(stagingRoot);
  const knowledgeBaseId = allocateEntityId('kb');
  const ownerScope = { kind: 'workspace' as const, workspaceId: allocateEntityId('ws') };
  const storage = new LocalStorage({
    mounts: [{ knowledgeBaseId, ownerScope, name: 'local', root }],
    stagingRoot,
  });
  fixtures.push({ directory, storage });
  const access: StorageAccess = {
    grantId: allocateEntityId('grant'),
    knowledgeBaseId,
    ownerScope,
    mount: 'local',
    pathPrefix: 'docs',
    mode,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revoked: false,
  };
  const locator: StorageLocator = { ownerScope, mount: 'local', path: 'docs/original.bin' };
  const bytes = Buffer.from([0, 255, 128, 1, 2, 13, 10, 0, 100]);
  await writeFile(join(root, locator.path), bytes);
  return { directory, root, stagingRoot, storage, access, locator, bytes };
}

/** Resolve current original metadata through the public service. */
async function capture(f: Awaited<ReturnType<typeof fixture>>): Promise<StorageContent> {
  return value(await invoke(f.storage.stat, { access: f.access, locator: f.locator }));
}

afterEach(async () => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) {
    try {
      await f.storage.close();
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

describe('LocalStorage original identity and Protocol boundary', () => {
  it('captures exact binary identity and reads split chunks after JSON serialization', async () => {
    const f = await fixture();
    const content = await capture(f);
    expect(ContentReferenceSchema.parse(content.reference)).toEqual(content.reference);
    expect(content).toEqual({
      reference: {
        knowledgeBaseId: f.access.knowledgeBaseId,
        contentDigest: digest(f.bytes),
        locator: f.locator,
        range: null,
        availability: 'available',
      },
      byteLength: 9,
      mediaType: 'application/octet-stream',
    });
    const first = value(
      await invoke(f.storage.read, { access: f.access, content, offset: 0, length: 4 })
    );
    const last = value(
      await invoke(f.storage.read, { access: f.access, content, offset: 4, length: 20 })
    );
    expect(first).toEqual({
      data: f.bytes.subarray(0, 4).toString('base64'),
      offset: 0,
      nextOffset: 4,
    });
    expect(last).toEqual({
      data: f.bytes.subarray(4).toString('base64'),
      offset: 4,
      nextOffset: null,
    });
    expect(
      Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(last.data, 'base64')])
    ).toEqual(f.bytes);
  });

  it('sniffs media from bytes rather than the filename extension', async () => {
    const f = await fixture();
    await writeFile(join(f.root, f.locator.path), '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    expect((await capture(f)).mediaType).toBe('application/pdf');
  });

  it('checks the full digest before serving an unchanged prefix', async () => {
    const f = await fixture();
    const content = await capture(f);
    const changed = Buffer.from(f.bytes);
    changed[changed.length - 1] = 101;
    await writeFile(join(f.root, f.locator.path), changed);
    expect(
      await invoke(f.storage.read, { access: f.access, content, offset: 0, length: 2 })
    ).toMatchObject({
      status: 'unavailable',
      reason: 'changed',
    });
    expect((await capture(f)).reference.contentDigest).toBe(digest(changed));
  });

  it('checks captured size independently of digest', async () => {
    const f = await fixture();
    const captured = await capture(f);
    const content = { ...captured, byteLength: captured.byteLength + 1 };
    expect(
      await invoke(f.storage.read, { access: f.access, content, offset: 0, length: 2 })
    ).toMatchObject({
      status: 'unavailable',
      reason: 'changed',
    });
  });

  it('reports a deleted captured original without replaying a retained copy', async () => {
    const f = await fixture();
    const content = await capture(f);
    value(await invoke(f.storage.read, { access: f.access, content, offset: 0, length: 2 }));
    await rm(join(f.root, f.locator.path));
    expect(
      await invoke(f.storage.read, { access: f.access, content, offset: 0, length: 2 })
    ).toMatchObject({
      status: 'unavailable',
      reason: 'missing',
    });
    expect(await invoke(f.storage.stat, { access: f.access, locator: f.locator })).toMatchObject({
      status: 'unavailable',
      reason: 'missing',
    });
  });

  it('uses absolute byte coordinates and stops at the captured half-open range', async () => {
    const f = await fixture();
    const captured = await capture(f);
    const content = {
      ...captured,
      reference: ContentReferenceSchema.parse({
        ...captured.reference,
        range: { kind: 'bytes', start: 2, end: 7 },
      }),
    };
    expect(
      value(await invoke(f.storage.read, { access: f.access, content, offset: 2, length: 20 }))
    ).toEqual({
      data: f.bytes.subarray(2, 7).toString('base64'),
      offset: 2,
      nextOffset: null,
    });
    expect(
      (await invoke(f.storage.read, { access: f.access, content, offset: 1, length: 1 })).status
    ).not.toBe('ok');
  });

  it.each([
    { kind: 'page', page: 1 },
    { kind: 'time', startSeconds: 0, endSeconds: 1 },
    { kind: 'frame', frame: 0, numbering: 'zero-based', coordinateSpace: 'source-video' },
  ])('refuses implicit $kind-to-byte conversion', async (range) => {
    const f = await fixture();
    const captured = await capture(f);
    const content = {
      ...captured,
      reference: ContentReferenceSchema.parse({ ...captured.reference, range }),
    };
    expect(
      await invoke(f.storage.read, { access: f.access, content, offset: 0, length: 2 })
    ).toMatchObject({
      status: 'unavailable',
      reason: 'unsupported',
    });
  });

  it('refuses oversized chunks and malformed byte offsets', async () => {
    const f = await fixture();
    const content = await capture(f);
    for (const request of [
      { offset: -1, length: 1 },
      { offset: 0.5, length: 1 },
      { offset: 0, length: -1 },
      { offset: 0, length: STORAGE_LIMITS.chunkBytes + 1 },
    ]) {
      expect(
        (await invoke(f.storage.read, { access: f.access, content, ...request })).status
      ).not.toBe('ok');
    }
  });
});

describe('LocalStorage current access and confinement', () => {
  it.each([
    'ownerScope',
    'knowledgeBaseId',
    'mount',
    'pathPrefix',
    'expiresAt',
    'revoked',
  ] as const)('denies a mismatched or inactive %s without disclosing metadata', async (dimension) => {
    const f = await fixture();
    const access = { ...f.access };
    switch (dimension) {
      case 'ownerScope':
        access.ownerScope = { kind: 'workspace', workspaceId: allocateEntityId('ws') };
        break;
      case 'knowledgeBaseId':
        access.knowledgeBaseId = allocateEntityId('kb');
        break;
      case 'mount':
        access.mount = 'other';
        break;
      case 'pathPrefix':
        access.pathPrefix = 'private';
        break;
      case 'expiresAt':
        access.expiresAt = new Date(Date.now() - 1).toISOString();
        break;
      case 'revoked':
        access.revoked = true;
        break;
    }
    expect(await invoke(f.storage.stat, { access, locator: f.locator })).toEqual({
      status: 'denied',
    });
  });

  it('does not infer an admitted scope or mount from a captured locator', async () => {
    const f = await fixture();
    for (const locator of [
      { ...f.locator, ownerScope: { kind: 'server' as const } },
      { ...f.locator, mount: 'other' },
    ]) {
      expect(await invoke(f.storage.stat, { access: f.access, locator })).toEqual({
        status: 'denied',
      });
    }
  });

  it('denies a forged reference Knowledge Base and an unconfigured matching mount', async () => {
    const f = await fixture();
    const captured = await capture(f);
    const content = {
      ...captured,
      reference: ContentReferenceSchema.parse({
        ...captured.reference,
        knowledgeBaseId: allocateEntityId('kb'),
      }),
    };
    expect(
      await invoke(f.storage.read, { access: f.access, content, offset: 0, length: 1 })
    ).toEqual({ status: 'denied' });
    expect(
      await invoke(f.storage.stat, {
        access: { ...f.access, mount: 'unconfigured' },
        locator: { ...f.locator, mount: 'unconfigured' },
      })
    ).toEqual({ status: 'denied' });
  });

  it('checks prefix segments instead of accepting a matching string prefix', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'docs-private'));
    await writeFile(join(f.root, 'docs-private', 'secret.bin'), 'secret');
    expect(
      await invoke(f.storage.stat, {
        access: f.access,
        locator: { ...f.locator, path: 'docs-private/secret.bin' },
      })
    ).toEqual({ status: 'denied' });
  });

  it('rechecks revocation on reads rather than retaining a successful prior grant', async () => {
    const f = await fixture();
    const content = await capture(f);
    value(await invoke(f.storage.read, { access: f.access, content, offset: 0, length: 1 }));
    expect(
      await invoke(f.storage.read, {
        access: { ...f.access, revoked: true },
        content,
        offset: 0,
        length: 1,
      })
    ).toEqual({ status: 'denied' });
  });

  it('allows read-only reads but denies staging without overwriting an original', async () => {
    const f = await fixture();
    const access: StorageAccess = { ...f.access, mode: 'read-only' };
    const content = value(await invoke(f.storage.stat, { access, locator: f.locator }));
    value(await invoke(f.storage.read, { access, content, offset: 0, length: 1 }));
    expect(
      await invoke(f.storage.beginStage, { access, locator: f.locator, maxByteLength: 10 })
    ).toEqual({ status: 'denied' });
    expect(await readFile(join(f.root, f.locator.path))).toEqual(f.bytes);
  });

  it('refuses traversal, absolute paths, backslashes and noncanonical segments', async () => {
    const f = await fixture();
    for (const path of [
      '../outside',
      '/etc/passwd',
      'docs/../../outside',
      'docs/./original.bin',
      'docs//original.bin',
      'docs\\original.bin',
    ]) {
      const result = await invoke(f.storage.stat, {
        access: f.access,
        locator: { ...f.locator, path },
      });
      expect(result.status).not.toBe('ok');
      expect(JSON.stringify(result)).not.toContain(f.root);
    }
  });

  it('refuses final and parent symlinks even when they point within the mount', async () => {
    const f = await fixture();
    await symlink(join(f.root, f.locator.path), join(f.root, 'docs', 'link.bin'));
    await symlink(join(f.root, 'docs'), join(f.root, 'docs', 'alias'));
    for (const path of ['docs/link.bin', 'docs/alias/original.bin']) {
      expect(
        (
          await invoke(f.storage.stat, {
            access: f.access,
            locator: { ...f.locator, path },
          })
        ).status
      ).not.toBe('ok');
    }
    expect(
      (
        await invoke(f.storage.stat, {
          access: f.access,
          locator: { ...f.locator, path: 'docs' },
        })
      ).status
    ).not.toBe('ok');
  });
});

describe('LocalStorage bounded shallow scans', () => {
  it('continues without duplicate entries and does not recurse into child directories', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'docs', 'second.bin'), 'second');
    await mkdir(join(f.root, 'docs', 'nested'));
    await writeFile(join(f.root, 'docs', 'nested', 'hidden.bin'), 'hidden');
    const directory = { ...f.locator, path: 'docs' };
    const entries = [];
    let finished = false;
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result = value(
        await invoke(f.storage.scan, {
          access: f.access,
          directory,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        })
      );
      expect(result.entries.length).toBeLessThanOrEqual(1);
      entries.push(...result.entries);
      if (result.cursor === null) {
        finished = true;
        break;
      }
      cursor = result.cursor;
    }
    expect(finished).toBe(true);
    expect(entries.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'docs/nested', kind: 'directory', byteLength: expect.any(Number) },
      { path: 'docs/original.bin', kind: 'file', byteLength: 9 },
      { path: 'docs/second.bin', kind: 'file', byteLength: 6 },
    ]);
  });

  it('can return an empty filtered page with continuation after examining its limit', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'docs', 'second.bin'), 'second');
    const result = value(
      await invoke(f.storage.scan, {
        access: f.access,
        directory: { ...f.locator, path: 'docs' },
        limit: 1,
        nameIncludes: 'no-match',
      })
    );
    expect(result.entries).toEqual([]);
    expect(result.cursor).toEqual(expect.any(String));
  });

  it('requires a rescan when a directory changes or a cursor is unusable', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'docs', 'second.bin'), 'second');
    const directory = { ...f.locator, path: 'docs' };
    const first = value(await invoke(f.storage.scan, { access: f.access, directory, limit: 1 }));
    expect(first.cursor).toEqual(expect.any(String));
    await writeFile(join(f.root, 'docs', 'new.bin'), 'new');
    for (const cursor of [first.cursor as string, 'not-a-scan-cursor']) {
      expect(
        await invoke(f.storage.scan, { access: f.access, directory, limit: 1, cursor })
      ).toEqual({ status: 'rescan-required' });
    }
  });

  it('refuses scan limits above the contract bound', async () => {
    const f = await fixture();
    expect(
      (
        await invoke(f.storage.scan, {
          access: f.access,
          directory: { ...f.locator, path: 'docs' },
          limit: STORAGE_LIMITS.scanEntries + 1,
        })
      ).status
    ).not.toBe('ok');
  });
});

describe('LocalStorage staged handoff', () => {
  it('hands off exact sealed multi-chunk bytes while leaving the original unchanged', async () => {
    const f = await fixture('staged-write');
    const bytes = Buffer.from([255, 0, 128, 1, 13, 10, 42]);
    const { handle } = value(
      await invoke(f.storage.beginStage, {
        access: f.access,
        locator: f.locator,
        maxByteLength: bytes.length,
      })
    );
    expect(handle).not.toContain(f.directory);
    expect(
      (await invoke(f.storage.readStage, { access: f.access, handle, offset: 0, length: 1 })).status
    ).not.toBe('ok');
    expect(
      value(
        await invoke(f.storage.writeStage, {
          access: f.access,
          handle,
          data: bytes.subarray(0, 3).toString('base64'),
        })
      )
    ).toEqual({ byteLength: 3 });
    expect(
      value(
        await invoke(f.storage.writeStage, {
          access: f.access,
          handle,
          data: bytes.subarray(3).toString('base64'),
        })
      )
    ).toEqual({ byteLength: 7 });
    const stage = value(await invoke(f.storage.finishStage, { access: f.access, handle }));
    expect(stage.handle).toBe(handle);
    expect(ContentReferenceSchema.parse(stage.content.reference)).toEqual(stage.content.reference);
    expect(stage.content.reference.contentDigest).toBe(digest(bytes));
    expect(stage.content.byteLength).toBe(7);
    const first = value(
      await invoke(f.storage.readStage, { access: f.access, handle, offset: 0, length: 2 })
    );
    const last = value(
      await invoke(f.storage.readStage, { access: f.access, handle, offset: 2, length: 20 })
    );
    expect(first).toEqual({
      data: bytes.subarray(0, 2).toString('base64'),
      offset: 0,
      nextOffset: 2,
    });
    expect(last).toEqual({
      data: bytes.subarray(2).toString('base64'),
      offset: 2,
      nextOffset: null,
    });
    expect(await readFile(join(f.root, f.locator.path))).toEqual(f.bytes);
    expect(
      (await invoke(f.storage.writeStage, { access: f.access, handle, data: 'AA==' })).status
    ).not.toBe('ok');
    expect(value(await invoke(f.storage.discardStage, { access: f.access, handle }))).toBeNull();
    expect(
      (await invoke(f.storage.readStage, { access: f.access, handle, offset: 0, length: 1 })).status
    ).not.toBe('ok');
    expect(
      (await readdir(f.stagingRoot, { recursive: true, withFileTypes: true })).filter((entry) =>
        entry.isFile()
      )
    ).toEqual([]);
  });

  it('enforces the declared stage byte bound without overwriting originals', async () => {
    const f = await fixture('staged-write');
    const { handle } = value(
      await invoke(f.storage.beginStage, { access: f.access, locator: f.locator, maxByteLength: 3 })
    );
    value(
      await invoke(f.storage.writeStage, {
        access: f.access,
        handle,
        data: Buffer.from([1, 2, 3]).toString('base64'),
      })
    );
    expect(await invoke(f.storage.writeStage, { access: f.access, handle, data: 'BA==' })).toEqual({
      status: 'resource-limited',
    });
    expect(await readFile(join(f.root, f.locator.path))).toEqual(f.bytes);
  });

  it('rejects stage size declarations beyond the file bound before allocating bytes', async () => {
    const f = await fixture('staged-write');
    for (const maxByteLength of [-1, STORAGE_LIMITS.contentBytes + 1]) {
      expect(
        (
          await invoke(f.storage.beginStage, {
            access: f.access,
            locator: f.locator,
            maxByteLength,
          })
        ).status
      ).not.toBe('ok');
    }
    expect(await readFile(join(f.root, f.locator.path))).toEqual(f.bytes);
  });

  it('refuses malformed base64 and an unknown stage handle', async () => {
    const f = await fixture('staged-write');
    const { handle } = value(
      await invoke(f.storage.beginStage, { access: f.access, locator: f.locator, maxByteLength: 3 })
    );
    expect(
      (await invoke(f.storage.writeStage, { access: f.access, handle, data: 'not!base64' })).status
    ).not.toBe('ok');
    expect(
      (
        await invoke(f.storage.readStage, {
          access: f.access,
          handle: 'unknown',
          offset: 0,
          length: 1,
        })
      ).status
    ).not.toBe('ok');
  });

  it('checks current access for stage operations and does not extend a handle past its original expiry', async () => {
    const f = await fixture('staged-write');
    const { handle } = value(
      await invoke(f.storage.beginStage, { access: f.access, locator: f.locator, maxByteLength: 3 })
    );
    expect(
      await invoke(f.storage.writeStage, {
        access: { ...f.access, revoked: true },
        handle,
        data: 'AQ==',
      })
    ).toEqual({ status: 'denied' });
    value(await invoke(f.storage.writeStage, { access: f.access, handle, data: 'AQ==' }));
    value(await invoke(f.storage.finishStage, { access: f.access, handle }));
    expect(
      await invoke(f.storage.readStage, {
        access: { ...f.access, pathPrefix: 'elsewhere' },
        handle,
        offset: 0,
        length: 1,
      })
    ).toEqual({ status: 'denied' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(new Date(f.access.expiresAt).getTime() + 1));
    const extendedAccess = { ...f.access, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    expect(
      (await invoke(f.storage.readStage, { access: extendedAccess, handle, offset: 0, length: 1 }))
        .status
    ).not.toBe('ok');
  });

  it('bounds open stages and clears unfinished temporary bytes on close', async () => {
    const f = await fixture('staged-write');
    for (let stage = 0; stage < STORAGE_LIMITS.openStages; stage += 1) {
      const { handle } = value(
        await invoke(f.storage.beginStage, {
          access: f.access,
          locator: f.locator,
          maxByteLength: 1,
        })
      );
      value(await invoke(f.storage.writeStage, { access: f.access, handle, data: 'AQ==' }));
    }
    expect(
      await invoke(f.storage.beginStage, { access: f.access, locator: f.locator, maxByteLength: 1 })
    ).toEqual({ status: 'resource-limited' });
    await f.storage.close();
    expect(
      (await readdir(f.stagingRoot, { recursive: true, withFileTypes: true })).filter((entry) =>
        entry.isFile()
      )
    ).toEqual([]);
    expect(await readFile(join(f.root, f.locator.path))).toEqual(f.bytes);
  });
});

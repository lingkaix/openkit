// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testEntityId } from '../../test-support/entity-ids.js';
import { verifyKnowledgePackageFormat, writeKnowledgePackageFormat } from './format.js';
import type { KnowledgePackageManifest, KnowledgePackageMetadata } from './manifest.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const knowledgeBaseId = testEntityId('kb', 'knowledge-package-format');
const temporaryRoots: string[] = [];
const limits = { maxEntries: 32, maxBytes: 64 * 1024 };

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

/** Returns an isolated parent whose full contents are removed after the test. */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openkit-knowledge-package-format-'));
  temporaryRoots.push(root);
  return root;
}

/** Loads the independent canonical fixture, substituting only its allocated identity. */
async function expectedManifestBytes(): Promise<string> {
  return (await readFile(join(fixtures, 'manifest.expected.json.txt'), 'utf8')).replaceAll(
    '@KNOWLEDGE_BASE_ID@',
    knowledgeBaseId
  );
}

/** Supplies frozen byte identities to the real format writer in deliberately unsorted order. */
async function packageInput(directory: string) {
  const manifest: KnowledgePackageManifest = JSON.parse(await expectedManifestBytes());
  const { contentInventory, schemaVersion, format, ...metadata } = manifest;
  return {
    directory,
    metadata,
    files: contentInventory
      .map((entry) => ({ ...entry, sourcePath: join(fixtures, entry.path) }))
      .reverse(),
    limits,
  };
}

/** Writes a real package without invoking any Source or Notebook publication owner. */
async function writeFixture(metadata?: Partial<KnowledgePackageMetadata>): Promise<string> {
  const directory = join(await temporaryRoot(), 'package');
  const input = await packageInput(directory);
  await writeKnowledgePackageFormat({ ...input, metadata: { ...input.metadata, ...metadata } });
  return directory;
}

/** Changes only the transport manifest, leaving its independently supplied file bytes intact. */
async function rewriteManifest(
  directory: string,
  change: (manifest: KnowledgePackageManifest) => unknown
): Promise<void> {
  const manifest: KnowledgePackageManifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8')
  );
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(change(manifest)));
}

describe('Knowledge package v1 format', () => {
  it('writes deterministic manifest bytes and preserves authored and binary files exactly', async () => {
    const directory = await writeFixture();
    const expected = await expectedManifestBytes();
    expect(await readFile(join(directory, 'manifest.json'), 'utf8')).toBe(expected);
    const verified = await verifyKnowledgePackageFormat({ directory, limits });
    expect(verified).toEqual(JSON.parse(expected));
    for (const entry of verified.contentInventory) {
      const bytes = await readFile(join(directory, entry.path));
      expect(bytes).toEqual(await readFile(join(fixtures, entry.path)));
      expect(bytes.byteLength).toBe(entry.byteLength);
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
        entry.contentDigest
      );
    }
    const second = join(await temporaryRoot(), 'package');
    const input = await packageInput(second);
    await writeKnowledgePackageFormat({ ...input, files: [...input.files].reverse() });
    expect(await readFile(join(second, 'manifest.json'), 'utf8')).toBe(expected);
  });

  it('refuses changed, missing, undeclared and incorrectly sized bytes', async () => {
    for (const fault of ['changed', 'missing', 'undeclared', 'length'] as const) {
      const directory = await writeFixture();
      if (fault === 'changed')
        await writeFile(join(directory, 'raw/original.bin'), Buffer.alloc(12));
      if (fault === 'missing') await rm(join(directory, 'raw/original.bin'));
      if (fault === 'undeclared') await writeFile(join(directory, 'raw/extra.bin'), 'extra');
      if (fault === 'length') {
        await rewriteManifest(directory, (manifest) => ({
          ...manifest,
          contentInventory: manifest.contentInventory.map((entry) => ({
            ...entry,
            byteLength: entry.byteLength + 1,
          })),
        }));
      }
      await expect(verifyKnowledgePackageFormat({ directory, limits })).rejects.toThrow();
    }
  });

  it('ignores descriptive additions but refuses unknown core and required semantics', async () => {
    const directory = await writeFixture();
    await rewriteManifest(directory, (manifest) => ({
      ...manifest,
      description: 'Portable knowledge',
      mounts: manifest.mounts.map((mount) => ({ ...mount, description: 'Captured declaration' })),
    }));
    expect(await verifyKnowledgePackageFormat({ directory, limits })).toEqual(
      JSON.parse(await expectedManifestBytes())
    );
    for (const patch of [
      { format: 'other.package' },
      { knowledgeBaseId: 'kb_unknown' },
      { requiredFeatures: ['unknown.required-semantics.v1'] },
      { ownerScope: { kind: 'unknown' } },
    ]) {
      const invalid = await writeFixture();
      await rewriteManifest(invalid, (manifest) => ({ ...manifest, ...patch }));
      await expect(verifyKnowledgePackageFormat({ directory: invalid, limits })).rejects.toThrow();
    }
  });

  it('checks the shared retained marker before decoding malformed family fields', async () => {
    const directory = await writeFixture();
    for (const schemaVersion of [undefined, 2, '1']) {
      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({ schemaVersion, mounts: 'not a mount declaration' })
      );
      await expect(verifyKnowledgePackageFormat({ directory, limits })).rejects.toThrow(
        'Unsupported retained record format.'
      );
    }
  });

  it('refuses duplicate, traversal, absolute and excluded paths before writing outside the package', async () => {
    for (const path of [
      '../outside.bin',
      join(await temporaryRoot(), 'absolute.bin'),
      'raw/../outside.bin',
      'raw\\outside.bin',
      'notebook.git/HEAD',
      'runtime/state.json',
      'proposals/draft.md',
      'reviews/review.json',
      'grants/lease.json',
    ]) {
      const directory = join(await temporaryRoot(), 'package');
      const input = await packageInput(directory);
      await expect(
        writeKnowledgePackageFormat({ ...input, files: [{ ...input.files[0]!, path }] })
      ).rejects.toThrow();
      expect(existsSync(join(directory, '..', 'outside.bin'))).toBe(false);
    }
    const directory = await writeFixture();
    await rewriteManifest(directory, (manifest) => ({
      ...manifest,
      contentInventory: [...manifest.contentInventory, manifest.contentInventory[0]],
    }));
    await expect(verifyKnowledgePackageFormat({ directory, limits })).rejects.toThrow();
    const duplicate = await packageInput(join(await temporaryRoot(), 'package'));
    await expect(
      writeKnowledgePackageFormat({
        ...duplicate,
        files: [duplicate.files[0]!, duplicate.files[0]!],
      })
    ).rejects.toThrow();
    const nested = await packageInput(join(await temporaryRoot(), 'package'));
    const path = `raw/${Array.from({ length: 5 }, (_, index) => `${index}${'a'.repeat(220)}`).join('/')}/original.bin`;
    const original = nested.files.find((file) => file.path === 'raw/original.bin')!;
    await writeKnowledgePackageFormat({ ...nested, files: [{ ...original, path }] });
    expect(
      (await verifyKnowledgePackageFormat({ directory: nested.directory, limits })).contentInventory
    ).toEqual([{ path, contentDigest: original.contentDigest, byteLength: original.byteLength }]);
  });

  it('refuses linked roots, linked directories and linked included files without changing targets', async () => {
    for (const path of ['manifest.json', 'raw/original.bin', 'raw']) {
      const directory = await writeFixture();
      const external = join(await temporaryRoot(), 'external');
      await cp(join(directory, path), external, { recursive: true });
      await rm(join(directory, path), { recursive: true });
      await symlink(external, join(directory, path));
      await expect(verifyKnowledgePackageFormat({ directory, limits })).rejects.toThrow();
      if (path === 'raw/original.bin') {
        expect(await readFile(external)).toEqual(await readFile(join(fixtures, path)));
      }
    }
    const target = await writeFixture();
    const directory = join(await temporaryRoot(), 'linked-package');
    await symlink(target, directory);
    await expect(verifyKnowledgePackageFormat({ directory, limits })).rejects.toThrow();
    const hardLinked = await writeFixture();
    await link(join(hardLinked, 'raw/original.bin'), join(await temporaryRoot(), 'hard-link'));
    await expect(verifyKnowledgePackageFormat({ directory: hardLinked, limits })).rejects.toThrow();
  });

  it('counts directory entries and all bytes including the manifest at exact small quota boundaries', async () => {
    const directory = await writeFixture();
    const manifestBytes = Buffer.byteLength(await expectedManifestBytes());
    const exact = { maxEntries: 7, maxBytes: 94 + 12 + 61 + manifestBytes };
    await expect(verifyKnowledgePackageFormat({ directory, limits: exact })).resolves.toBeDefined();
    const exactInput = await packageInput(join(await temporaryRoot(), 'package'));
    await expect(
      writeKnowledgePackageFormat({ ...exactInput, limits: exact })
    ).resolves.toBeDefined();
    for (const quota of [
      { ...exact, maxEntries: exact.maxEntries - 1 },
      { ...exact, maxBytes: exact.maxBytes - 1 },
    ]) {
      await expect(verifyKnowledgePackageFormat({ directory, limits: quota })).rejects.toThrow();
      const input = await packageInput(join(await temporaryRoot(), 'package'));
      await expect(writeKnowledgePackageFormat({ ...input, limits: quota })).rejects.toThrow();
      expect(existsSync(input.directory)).toBe(false);
    }
    await rewriteManifest(directory, (manifest) => ({
      ...manifest,
      description: 'x'.repeat(1_048_576),
    }));
    await expect(
      verifyKnowledgePackageFormat({ directory, limits: { maxEntries: 32, maxBytes: 2_000_000 } })
    ).rejects.toThrow();
  });

  it('keeps external mount declarations inert and refuses their packaged bytes and name collisions', async () => {
    const externalRoot = join(await temporaryRoot(), 'not-present');
    const input = await packageInput(join(await temporaryRoot(), 'package'));
    const mounts = [
      ...input.metadata.mounts,
      { name: 'reference', backend: 'local', root: externalRoot, default: false },
    ];
    const directory = await writeFixture({ mounts });
    expect((await verifyKnowledgePackageFormat({ directory, limits })).mounts).toEqual(mounts);
    expect(existsSync(externalRoot)).toBe(false);
    await mkdir(join(directory, 'raw/reference'));
    await expect(verifyKnowledgePackageFormat({ directory, limits })).rejects.toThrow();
    for (const invalidMounts of [
      [...mounts, mounts[1]!],
      mounts.map((mount) => ({ ...mount, default: false })),
      mounts.map((mount) => ({ ...mount, default: true })),
      [{ ...mounts[0]!, root: externalRoot }],
    ]) {
      await expect(writeFixture({ mounts: invalidMounts })).rejects.toThrow();
    }
    await expect(
      writeKnowledgePackageFormat({
        ...input,
        metadata: { ...input.metadata, mounts },
        files: [{ ...input.files[0]!, path: 'raw/reference/file.bin' }],
      })
    ).rejects.toThrow();
  });

  it('cleans failed fresh writes and preserves an existing destination', async () => {
    for (const fault of ['digest', 'length', 'missing', 'linked'] as const) {
      const input = await packageInput(join(await temporaryRoot(), 'package'));
      const file = input.files[0]!;
      const linkedSource = join(await temporaryRoot(), 'source-link');
      if (fault === 'linked') await symlink(file.sourcePath, linkedSource);
      const changed = {
        ...file,
        ...(fault === 'digest' ? { contentDigest: `sha256:${'0'.repeat(64)}` } : {}),
        ...(fault === 'length' ? { byteLength: file.byteLength + 1 } : {}),
        ...(fault === 'missing' ? { sourcePath: join(await temporaryRoot(), 'missing') } : {}),
        ...(fault === 'linked' ? { sourcePath: linkedSource } : {}),
      };
      await expect(writeKnowledgePackageFormat({ ...input, files: [changed] })).rejects.toThrow();
      expect(existsSync(input.directory)).toBe(false);
    }
    const directory = await writeFixture();
    const prior = await readFile(join(directory, 'manifest.json'));
    await expect(writeKnowledgePackageFormat(await packageInput(directory))).rejects.toThrow();
    expect(await readFile(join(directory, 'manifest.json'))).toEqual(prior);
    await expect(verifyKnowledgePackageFormat({ directory, limits })).resolves.toBeDefined();
  });

  it('refuses derivative payloads until derivative export supplies its required semantics', async () => {
    const input = await packageInput(join(await temporaryRoot(), 'package'));
    const derivative = { ...input.files[0]!, path: 'derived/text.md' };
    await expect(writeKnowledgePackageFormat({ ...input, files: [derivative] })).rejects.toThrow();
    expect(existsSync(input.directory)).toBe(false);
    const directory = await writeFixture();
    await mkdir(join(directory, 'derived'));
    await cp(derivative.sourcePath, join(directory, derivative.path));
    await rewriteManifest(directory, (manifest) => ({
      ...manifest,
      contentInventory: [
        ...manifest.contentInventory,
        {
          path: derivative.path,
          contentDigest: derivative.contentDigest,
          byteLength: derivative.byteLength,
        },
      ],
    }));
    await expect(verifyKnowledgePackageFormat({ directory, limits })).rejects.toThrow();
  });
});

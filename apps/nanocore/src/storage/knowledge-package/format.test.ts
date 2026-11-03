// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testEntityId } from '../../test-support/entity-ids.js';
import { verifyKnowledgePackageFormat, writeKnowledgePackageFormat } from './format.js';

// Derive the package shapes from the public operations so this test follows the file that owns them.
type KnowledgePackageManifest = Awaited<ReturnType<typeof verifyKnowledgePackageFormat>>;
type KnowledgePackageMetadata = Parameters<typeof writeKnowledgePackageFormat>[0]['metadata'];

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

/** Computes the canonical content digest for independently measured bytes. */
function contentDigest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Returns the same well-formed digest with one hexadecimal character changed. */
function flipDigest(digest: string): string {
  return `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`;
}

/** Builds inert additional mount declarations whose roots carry an exact padding length. */
function paddedMounts(count: number, rootLength: number, longerPrefix = 0) {
  return Array.from({ length: count }, (_, index) => ({
    name: `pad-${index}`,
    backend: 'local',
    root: 'p'.repeat(rootLength + (index < longerPrefix ? 1 : 0)),
    default: false,
  }));
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

  it('round trips a bounded binary original across multiple copy and verification chunks', async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from(Array.from({ length: 65536 + 29 }, (_, index) => index % 251));
    const sourcePath = join(root, 'large-original.bin');
    await writeFile(sourcePath, bytes);
    const directory = join(root, 'package');
    const input = await packageInput(directory);
    const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const member = {
      path: 'raw/original.bin',
      sourcePath,
      byteLength: bytes.length,
      contentDigest,
    };
    // Keep the original small quota tests intact; this case has its own bounded admission.
    const largeLimits = { maxEntries: 32, maxBytes: 128 * 1024 };
    await writeKnowledgePackageFormat({
      ...input,
      files: input.files.map((file) => (file.path === member.path ? member : file)),
      limits: largeLimits,
    });
    const verified = await verifyKnowledgePackageFormat({ directory, limits: largeLimits });
    expect(verified.contentInventory.find((entry) => entry.path === member.path)).toEqual({
      path: member.path,
      byteLength: bytes.length,
      contentDigest,
    });
    expect(await readFile(join(directory, member.path))).toEqual(bytes);
    expect(await readFile(sourcePath)).toEqual(bytes);
    const second = join(root, 'second-package');
    await writeKnowledgePackageFormat({
      directory: second,
      metadata: input.metadata,
      files: verified.contentInventory.map((entry) => ({
        ...entry,
        sourcePath: join(directory, entry.path),
      })),
      limits: largeLimits,
    });
    expect(await verifyKnowledgePackageFormat({ directory: second, limits: largeLimits })).toEqual(
      verified
    );
    expect(await readFile(join(second, member.path))).toEqual(bytes);
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

  it('checks the shared retained marker before decoding any family field', async () => {
    const directory = await writeFixture();
    const manifest: KnowledgePackageManifest = JSON.parse(await expectedManifestBytes());
    for (const schemaVersion of [undefined, 2, '1', null]) {
      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({
          ...manifest,
          schemaVersion,
          format: 'other.package',
          mounts: 'not a mount declaration',
        })
      );
      await expect(verifyKnowledgePackageFormat({ directory, limits })).rejects.toThrow(
        'Unsupported retained record format.'
      );
    }
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        format: 'other.package',
        mounts: 'not a mount declaration',
      })
    );
    const failure = await verifyKnowledgePackageFormat({ directory, limits }).then(
      () => null,
      (error: unknown) => error as Error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).not.toBe('Unsupported retained record format.');
  });

  it('refuses unsupported and duplicated required feature declarations', async () => {
    const supported = ['openkit.knowledge-git-notebook.v1'];
    const directory = await writeFixture({ requiredFeatures: supported });
    expect((await verifyKnowledgePackageFormat({ directory, limits })).requiredFeatures).toEqual(
      supported
    );
    for (const requiredFeatures of [
      ['openkit.unknown-required-semantics.v1'],
      ['openkit.knowledge-owner-scope.v1', 'openkit.knowledge-owner-scope.v1'],
      [...supported, ...supported],
    ]) {
      const invalid = await writeFixture();
      await rewriteManifest(invalid, (current) => ({ ...current, requiredFeatures }));
      await expect(verifyKnowledgePackageFormat({ directory: invalid, limits })).rejects.toThrow(
        'Unsupported semantics or duplicate Knowledge package member.'
      );
      const input = await packageInput(join(await temporaryRoot(), 'package'));
      await expect(
        writeKnowledgePackageFormat({
          ...input,
          metadata: { ...input.metadata, requiredFeatures },
        })
      ).rejects.toThrow('Unsupported semantics or duplicate Knowledge package member.');
      expect(existsSync(input.directory)).toBe(false);
    }
  });

  it('reproduces independently hand-written canonical manifest bytes exactly', async () => {
    const guide = await readFile(join(fixtures, 'pages/guide.md'));
    const original = await readFile(join(fixtures, 'raw/original.bin'));
    const schema = await readFile(join(fixtures, 'schema/scope-schema.yaml'));
    const canonical = `{
  "contentInventory": [
    {
      "byteLength": ${guide.byteLength},
      "contentDigest": "${contentDigest(guide)}",
      "path": "pages/guide.md"
    },
    {
      "byteLength": ${original.byteLength},
      "contentDigest": "${contentDigest(original)}",
      "path": "raw/original.bin"
    },
    {
      "byteLength": ${schema.byteLength},
      "contentDigest": "${contentDigest(schema)}",
      "path": "schema/scope-schema.yaml"
    }
  ],
  "format": "openkit.knowledge-package",
  "knowledgeBaseId": "${knowledgeBaseId}",
  "mounts": [
    {
      "backend": "local",
      "default": true,
      "name": "local",
      "root": "raw/"
    }
  ],
  "notebookRevision": "0123456789abcdef0123456789abcdef01234567",
  "ownerScope": {
    "kind": "server"
  },
  "requiredFeatures": [],
  "schemaVersion": 1
}
`;
    expect(canonical.endsWith('\n')).toBe(true);
    const directory = await writeFixture();
    expect(await readFile(join(directory, 'manifest.json'), 'utf8')).toBe(canonical);
    await writeFile(join(directory, 'manifest.json'), canonical);
    expect(await verifyKnowledgePackageFormat({ directory, limits })).toEqual(
      JSON.parse(canonical)
    );
  });

  it('accounts for exact manifest, member and digest byte identities', async () => {
    const directory = await writeFixture();
    const manifestBytes = await readFile(join(directory, 'manifest.json'));
    const manifest: KnowledgePackageManifest = JSON.parse(manifestBytes.toString('utf8'));
    for (const entry of manifest.contentInventory) {
      const bytes = await readFile(join(fixtures, entry.path));
      expect(entry.byteLength).toBe(bytes.byteLength);
      expect(entry.contentDigest).toBe(contentDigest(bytes));
    }
    const totalBytes =
      manifestBytes.byteLength +
      manifest.contentInventory.reduce((sum, entry) => sum + entry.byteLength, 0);
    const exactInput = await packageInput(join(await temporaryRoot(), 'package'));
    await expect(
      writeKnowledgePackageFormat({
        ...exactInput,
        limits: { maxEntries: 7, maxBytes: totalBytes },
      })
    ).resolves.toBeDefined();
    const overInput = await packageInput(join(await temporaryRoot(), 'package'));
    await expect(
      writeKnowledgePackageFormat({
        ...overInput,
        limits: { maxEntries: 7, maxBytes: totalBytes - 1 },
      })
    ).rejects.toThrow('Knowledge package resource limit exceeded.');
    expect(existsSync(overInput.directory)).toBe(false);

    await rewriteManifest(directory, (current) => ({
      ...current,
      contentInventory: current.contentInventory.map((entry, index) =>
        index === 0 ? { ...entry, contentDigest: flipDigest(entry.contentDigest) } : entry
      ),
    }));
    await expect(verifyKnowledgePackageFormat({ directory, limits })).rejects.toThrow(
      'Knowledge package member bytes do not match their captured identity.'
    );
    for (const byteLength of [1, -1]) {
      const sized = await writeFixture();
      await rewriteManifest(sized, (current) => ({
        ...current,
        contentInventory: current.contentInventory.map((entry, index) =>
          index === 0 ? { ...entry, byteLength: entry.byteLength + byteLength } : entry
        ),
      }));
      await expect(verifyKnowledgePackageFormat({ directory: sized, limits })).rejects.toThrow(
        'Knowledge package member length does not match.'
      );
    }
    const writeInput = await packageInput(join(await temporaryRoot(), 'package'));
    const member = writeInput.files.find((file) => file.path === 'raw/original.bin')!;
    await expect(
      writeKnowledgePackageFormat({
        ...writeInput,
        files: writeInput.files.map((file) =>
          file.path === member.path
            ? { ...file, contentDigest: flipDigest(file.contentDigest) }
            : file
        ),
      })
    ).rejects.toThrow('Knowledge package member bytes do not match their captured identity.');
    expect(existsSync(writeInput.directory)).toBe(false);
  });

  it('refuses duplicate and path-prefix inventory collisions', async () => {
    const input = await packageInput(join(await temporaryRoot(), 'package'));
    const member = input.files.find((file) => file.path === 'raw/original.bin')!;
    const colliding = [
      { ...member, path: 'raw/folder' },
      { ...member, path: 'raw/folder/nested.bin' },
    ];
    await expect(writeKnowledgePackageFormat({ ...input, files: colliding })).rejects.toThrow(
      'Knowledge package file and directory paths collide.'
    );
    expect(existsSync(input.directory)).toBe(false);
    const duplicateInput = await packageInput(join(await temporaryRoot(), 'package'));
    await expect(
      writeKnowledgePackageFormat({
        ...duplicateInput,
        files: [duplicateInput.files[0]!, duplicateInput.files[0]!],
      })
    ).rejects.toThrow('Unsupported semantics or duplicate Knowledge package member.');
    expect(existsSync(duplicateInput.directory)).toBe(false);

    const directory = await writeFixture();
    await rewriteManifest(directory, (current) => ({
      ...current,
      contentInventory: [...current.contentInventory, ...colliding],
    }));
    await expect(verifyKnowledgePackageFormat({ directory, limits })).rejects.toThrow(
      'Knowledge package file and directory paths collide.'
    );
    const duplicate = await writeFixture();
    await rewriteManifest(duplicate, (current) => ({
      ...current,
      contentInventory: [...current.contentInventory, current.contentInventory[0]!],
    }));
    await expect(verifyKnowledgePackageFormat({ directory: duplicate, limits })).rejects.toThrow(
      'Unsupported semantics or duplicate Knowledge package member.'
    );
  });

  it('refuses bytes and directories reserved by an additional mount namespace', async () => {
    const externalRoot = join(await temporaryRoot(), 'not-present');
    const input = await packageInput(join(await temporaryRoot(), 'package'));
    const mounts = [
      ...input.metadata.mounts,
      { name: 'archive', backend: 'local', root: externalRoot, default: false },
    ];
    const directory = await writeFixture({ mounts });
    expect(
      (await verifyKnowledgePackageFormat({ directory, limits })).mounts.map((mount) => mount.name)
    ).toEqual(['archive', 'local']);
    expect(existsSync(externalRoot)).toBe(false);
    await mkdir(join(directory, 'raw/archive'));
    await expect(verifyKnowledgePackageFormat({ directory, limits })).rejects.toThrow(
      'Knowledge package directory is outside its declared layout.'
    );
    const member = input.files.find((file) => file.path === 'raw/original.bin')!;
    await expect(
      writeKnowledgePackageFormat({
        ...input,
        metadata: { ...input.metadata, mounts },
        files: [{ ...member, path: 'raw/archive/file.bin' }],
      })
    ).rejects.toThrow('Additional mount bytes cannot travel in a Knowledge package.');
    expect(existsSync(input.directory)).toBe(false);
  });

  it('enforces the original 1 MiB manifest cap at read and write boundaries', async () => {
    const cap = 1_048_576;
    const directory = await writeFixture();
    const manifest: KnowledgePackageManifest = JSON.parse(await expectedManifestBytes());
    const textOfSize = (size: number) => {
      const empty = JSON.stringify({ ...manifest, description: '' });
      return JSON.stringify({
        ...manifest,
        description: 'a'.repeat(size - Buffer.byteLength(empty)),
      });
    };
    const capLimits = { maxEntries: 32, maxBytes: 2_097_152 };
    await writeFile(join(directory, 'manifest.json'), textOfSize(cap));
    expect(Buffer.byteLength(textOfSize(cap))).toBe(cap);
    expect(await verifyKnowledgePackageFormat({ directory, limits: capLimits })).toEqual(manifest);
    await writeFile(join(directory, 'manifest.json'), textOfSize(cap + 1));
    await expect(verifyKnowledgePackageFormat({ directory, limits: capLimits })).rejects.toThrow(
      'Knowledge package manifest must be a bounded regular file.'
    );

    const root = await temporaryRoot();
    const input = await packageInput(join(root, 'probe'));
    const paddingCount = 300;
    await writeKnowledgePackageFormat({
      ...input,
      metadata: {
        ...input.metadata,
        mounts: [...input.metadata.mounts, ...paddedMounts(paddingCount, 2500)],
      },
      limits: capLimits,
    });
    const probeBytes = Buffer.byteLength(
      await readFile(join(input.directory, 'manifest.json'), 'utf8')
    );
    expect(probeBytes).toBeLessThan(cap);
    const growth = Math.floor((cap - probeBytes) / paddingCount);
    const longer = cap - probeBytes - growth * paddingCount;
    const exactMounts = [
      ...input.metadata.mounts,
      ...paddedMounts(paddingCount, 2500 + growth, longer),
    ];
    const exactDirectory = join(root, 'exact');
    await writeKnowledgePackageFormat({
      directory: exactDirectory,
      metadata: { ...input.metadata, mounts: exactMounts },
      files: input.files,
      limits: capLimits,
    });
    const exactBytes = await readFile(join(exactDirectory, 'manifest.json'), 'utf8');
    expect(Buffer.byteLength(exactBytes)).toBe(cap);
    expect(
      await verifyKnowledgePackageFormat({ directory: exactDirectory, limits: capLimits })
    ).toEqual(JSON.parse(exactBytes));
    const overMounts = exactMounts.map((mount, index) =>
      index === 1 ? { ...mount, root: `${mount.root}p` } : mount
    );
    const overDirectory = join(root, 'over');
    await expect(
      writeKnowledgePackageFormat({
        directory: overDirectory,
        metadata: { ...input.metadata, mounts: overMounts },
        files: input.files,
        limits: capLimits,
      })
    ).rejects.toThrow('Knowledge package manifest is too large.');
    expect(existsSync(overDirectory)).toBe(false);
  });

  it('removes every partially written path when a fresh write fails', async () => {
    const parent = await temporaryRoot();
    const directory = join(parent, 'package');
    const input = await packageInput(directory);
    const member = input.files.find((file) => file.path === 'raw/original.bin')!;
    await expect(
      writeKnowledgePackageFormat({
        ...input,
        files: input.files.map((file) =>
          file.path === member.path
            ? {
                ...file,
                path: 'raw/deep/member.bin',
                contentDigest: flipDigest(file.contentDigest),
              }
            : file
        ),
      })
    ).rejects.toThrow('Knowledge package member bytes do not match their captured identity.');
    expect(existsSync(directory)).toBe(false);
    expect(await readdir(parent)).toEqual([]);
    await writeKnowledgePackageFormat(input);
    await expect(verifyKnowledgePackageFormat({ directory, limits })).resolves.toBeDefined();
    expect(await readdir(parent)).toEqual(['package']);
  });
});

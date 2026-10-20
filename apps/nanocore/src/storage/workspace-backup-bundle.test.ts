// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  parseWorkspaceBackupManifest,
  parseWorkspaceBackupSeal,
  type VerifiedWorkspaceBackupBundle,
  WORKSPACE_BACKUP_MANIFEST_FILE,
  WORKSPACE_BACKUP_SEAL_FILE,
  type WorkspaceBackupManifest,
  type WorkspaceBackupSeal,
  type WorkspaceBackupVerificationInput,
  withVerifiedWorkspaceBackupBundle,
  workspaceBackupInventoryDigest,
} from './workspace-backup-bundle.js';

/**
 * Independent L1 oracles for 20260704-workspace_backup_export_import.md.
 * Bundle means "Workspace Bundle And Authority"; Restore-1 means "Same-Deployment Restore", step 1.
 * The coordinator's 2026-10-20 13:40Z ruling makes inventory entries exact and hashes their original JSON array bytes.
 * These tests were authored against the published interface without inspecting the implementation.
 */
const BACKUP_ID = 'wsbak_0199ed5a-0000-7000-8000-000000000001';
const OTHER_BACKUP_ID = 'wsbak_0199ed5a-0000-7000-8000-000000000002';
const WORKSPACE_ID = 'ws_0199ed5a-0000-7000-8000-000000000003';
const DEPLOYMENT_ID = 'dep_0199ed5a-0000-7000-8000-000000000004';
const KNOWLEDGE_BASE_ID = 'kb_0199ed5a-0000-7000-8000-000000000005';
const OWNER_ID = 'usr_0199ed5a-0000-7000-8000-000000000006';
const RELEASE = { version: '0.1.0-rc.11', buildId: '1234567890abcdef1234567890abcdef12345678' };
const DATABASE_FORMATS = { workspace: 1 };
const PAYLOADS = [
  // Deliberately opaque: structural verification must not claim SQLite integrity.
  { path: 'snapshots/workspace.sqlite', bytes: Buffer.from([0, 255, 128, 13, 10]), mode: 0o600 },
  { path: 'content/tool.sh', bytes: Buffer.from('#!/bin/sh\nexit 93\n'), mode: 0o700 },
];
const ownedRoots: string[] = [];

/** Fixture hashes are independent of the parser and digest helper under test. */
function digest(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Supplies all specified manifest facts without reading any live storage layout. */
function manifestFor(purpose: 'backup' | 'move' = 'backup'): WorkspaceBackupManifest {
  const inventory = PAYLOADS.map((file) => ({
    path: file.path,
    bytes: file.bytes.length,
    sha256: digest(file.bytes),
    mode: file.mode,
  }));
  return {
    format: 'openkit-workspace-backup',
    version: 1,
    purpose,
    backupId: BACKUP_ID,
    workspaceId: WORKSPACE_ID,
    sourceDeploymentId: DEPLOYMENT_ID,
    knowledgeBaseIds: [KNOWLEDGE_BASE_ID],
    capturedRevision: 7,
    priorMoves: [],
    release: { ...RELEASE },
    databaseFormats: [{ path: PAYLOADS[0]!.path, markers: { ...DATABASE_FORMATS } }],
    requiredFeatures: [],
    capture: {
      startedAt: '2026-10-20T12:00:00.000Z',
      completedAt: '2026-10-20T12:00:01.000Z',
      consistency: purpose === 'move' ? 'quiescent' : 'workspace-consistent',
    },
    inventory,
    inventoryDigest: digest(JSON.stringify(inventory)),
    coverage: {
      includedAuthorities: ['workspace-control', 'workspace-content'],
      snapshotRoots: [PAYLOADS[0]!.path, 'content'],
      omittedProjections: ['search-index'],
      omittedVolumes: ['worker-volume-not-captured'],
      externalDependencies: [
        { kind: 'external-source', reference: 'source-fixture', availability: 'unavailable' },
      ],
    },
    accounts: { ownerId: OWNER_ID, memberIds: [OWNER_ID], privateAudienceRefs: [OWNER_ID] },
  };
}

/** Binds a seal to the exact serialized manifest, independently of production helpers. */
function sealFor(
  manifestBytes: Uint8Array,
  purpose: 'backup' | 'move' = 'backup'
): WorkspaceBackupSeal {
  return {
    format: 'openkit-workspace-backup-seal',
    version: 1,
    backupId: BACKUP_ID,
    purpose,
    manifestDigest: digest(manifestBytes),
  };
}

/** Keeps mutable fixture metadata separate from the production reader's readonly result. */
interface BundleFixture {
  root: string;
  bundleRoot: string;
  stagingParent: string;
  manifest: WorkspaceBackupManifest;
  manifestBytes: Buffer;
  seal: WorkspaceBackupSeal;
  input: WorkspaceBackupVerificationInput;
}

/** Writes metadata with the supplied inventory spelling and seals those exact bytes. */
async function writeMetadata(
  fixture: BundleFixture,
  manifest: WorkspaceBackupManifest = fixture.manifest,
  inventoryJson = JSON.stringify(manifest.inventory)
): Promise<void> {
  // Inventory is last only to make its exact byte boundary explicit in the independent fixture.
  const { inventory: _inventory, ...facts } = manifest;
  fixture.manifest = manifest;
  fixture.manifestBytes = Buffer.from(
    `${JSON.stringify(facts).slice(0, -1)},"inventory":${inventoryJson}}\n`
  );
  fixture.seal = sealFor(fixture.manifestBytes, manifest.purpose);
  await writeFile(path.join(fixture.bundleRoot, 'manifest.json'), fixture.manifestBytes, {
    mode: 0o600,
  });
  await writeFile(path.join(fixture.bundleRoot, 'seal.json'), JSON.stringify(fixture.seal), {
    mode: 0o600,
  });
}

/** Creates real confined files and real capacity admission in a test-owned POSIX directory. */
async function bundleFixture(purpose: 'backup' | 'move' = 'backup'): Promise<BundleFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-backup-bundle-test-'));
  ownedRoots.push(root);
  const bundleRoot = path.join(root, 'bundle');
  const stagingParent = path.join(root, 'staging');
  await mkdir(bundleRoot, { mode: 0o700 });
  await mkdir(stagingParent, { mode: 0o700 });
  for (const file of PAYLOADS) {
    const target = path.join(bundleRoot, file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.bytes, { mode: file.mode });
    await chmod(target, file.mode);
  }
  const manifest = manifestFor(purpose);
  const fixture: BundleFixture = {
    root,
    bundleRoot,
    stagingParent,
    manifest,
    manifestBytes: Buffer.alloc(0),
    seal: sealFor(Buffer.alloc(0), purpose),
    input: {
      bundleRoot,
      stagingParent,
      admission: new FileStorageAdmission(
        root,
        () => 0n,
        () => 1_000_000_000_000n
      ),
      expectedRelease: { ...RELEASE },
      supportedDatabaseFormats: { ...DATABASE_FORMATS },
    },
  };
  await writeMetadata(fixture);
  return fixture;
}

/** Collects the public byte stream without reopening its source path. */
async function consumeBytes(
  bundle: VerifiedWorkspaceBackupBundle,
  relativePath: string
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of bundle.readFile(relativePath)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Rejection must occur before any caller can consume the purportedly verified bundle. */
async function expectRefusal(input: WorkspaceBackupVerificationInput): Promise<void> {
  const consume = vi.fn(async () => 'must not consume');
  await expect(withVerifiedWorkspaceBackupBundle(input, consume)).rejects.toThrow();
  expect(consume).not.toHaveBeenCalled();
}

afterEach(async () => {
  for (const root of ownedRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Workspace backup bundle: specification-derived structural verification', () => {
  it.each([
    'backup',
    'move',
  ] as const)('Bundle: "format version 1 ... purpose backup or move" — accepts %s and preserves exact bytes', async (purpose) => {
    const fixture = await bundleFixture(purpose);
    expect(WORKSPACE_BACKUP_MANIFEST_FILE).toBe('manifest.json');
    expect(WORKSPACE_BACKUP_SEAL_FILE).toBe('seal.json');
    expect(parseWorkspaceBackupManifest(fixture.manifest)).toEqual(fixture.manifest);
    expect(parseWorkspaceBackupSeal(fixture.seal)).toEqual(fixture.seal);
    const result = await withVerifiedWorkspaceBackupBundle(fixture.input, async (bundle) => {
      expect(bundle.verification).toBe('structural-only');
      expect(bundle.manifest).toEqual(fixture.manifest);
      expect(bundle.seal).toEqual(fixture.seal);
      expect(bundle.manifestDigest).toBe(digest(fixture.manifestBytes));
      expect(bundle.fileCount).toBe(PAYLOADS.length);
      expect(bundle.totalBytes).toBe(PAYLOADS.reduce((sum, file) => sum + file.bytes.length, 0));
      for (const file of PAYLOADS) {
        expect(await consumeBytes(bundle, file.path)).toEqual(file.bytes);
      }
      return 'consumed';
    });
    expect(result).toBe('consumed');
    expect(await readdir(fixture.stagingParent)).toEqual([]);
    for (const file of PAYLOADS) {
      expect(await readFile(path.join(fixture.bundleRoot, file.path))).toEqual(file.bytes);
    }
  });

  it.each([
    ['analytical format', { format: 'openkit-workspace-export' }],
    ['export version', { version: 3 }],
    ['string version', { version: '1' }],
    ['missing version', { version: undefined }],
    ['unknown purpose', { purpose: 'copy' }],
    ['wrong backup kind', { backupId: BACKUP_ID.replace('wsbak_', 'drb_') }],
    ['malformed backup ID', { backupId: 'wsbak_not-a-uuid' }],
    ['missing Knowledge Base identities', { knowledgeBaseIds: undefined }],
    ['wrong Knowledge Base kind', { knowledgeBaseIds: [WORKSPACE_ID] }],
    ['missing captured revision', { capturedRevision: undefined }],
    ['missing database markers', { databaseFormats: undefined }],
    ['missing feature list', { requiredFeatures: undefined }],
    ['missing release', { release: undefined }],
  ] as const)('Bundle: "unknown core values ... refuse admission" and required manifest facts — rejects %s', (_name, change) => {
    expect(() => parseWorkspaceBackupManifest({ ...manifestFor(), ...change })).toThrow();
  });

  it('Bundle: "quiescent for a move" — refuses a move with a hot-capture class', () => {
    const manifest = manifestFor('move');
    expect(() =>
      parseWorkspaceBackupManifest({
        ...manifest,
        capture: { ...manifest.capture, consistency: 'workspace-consistent' },
      })
    ).toThrow();
  });

  it('Bundle: "unknown core values ... refuse admission" — refuses an unknown external availability', () => {
    const manifest = manifestFor();
    expect(() =>
      parseWorkspaceBackupManifest({
        ...manifest,
        coverage: {
          ...manifest.coverage,
          externalDependencies: [
            { kind: 'external-source', reference: 'source-fixture', availability: 'assumed' },
          ],
        },
      })
    ).toThrow();
  });

  it('Bundle: "Unknown descriptive additions are ignored" — accepts but never forwards top-level additions', async () => {
    const fixture = await bundleFixture();
    const annotation = { description: 'Untrusted descriptive text: [ ] { } "inventory": []' };
    expect(parseWorkspaceBackupManifest({ ...fixture.manifest, ...annotation })).toEqual(
      fixture.manifest
    );
    expect(parseWorkspaceBackupSeal({ ...fixture.seal, ...annotation })).toEqual(fixture.seal);
    const annotatedBytes = Buffer.from(
      JSON.stringify({ ...annotation, ...fixture.manifest, extraDescription: 'after inventory' })
    );
    const seal = sealFor(annotatedBytes);
    await writeFile(path.join(fixture.bundleRoot, 'manifest.json'), annotatedBytes);
    await writeFile(
      path.join(fixture.bundleRoot, 'seal.json'),
      JSON.stringify({ ...seal, ...annotation })
    );
    await withVerifiedWorkspaceBackupBundle(fixture.input, async (bundle) => {
      expect(bundle.manifest).toEqual(fixture.manifest);
      expect(bundle.seal).toEqual(seal);
      expect(bundle.manifestDigest).toBe(digest(annotatedBytes));
      await expect(consumeBytes(bundle, 'manifest.json')).rejects.toThrow();
      await expect(consumeBytes(bundle, 'seal.json')).rejects.toThrow();
    });
  });

  it('Bundle: "SHA-256 over the exact serialized inventory" — preserves received whitespace and field order', async () => {
    const fixture = await bundleFixture();
    const entries = fixture.manifest.inventory.map(({ mode, sha256, bytes, path: filePath }) => ({
      mode,
      sha256,
      bytes,
      path: filePath,
    }));
    const inventoryJson = `[\n ${entries.map((entry) => JSON.stringify(entry)).join(',\n ')}\n]`;
    const inventoryBytes = Buffer.from(inventoryJson);
    expect(digest(inventoryBytes)).not.toBe(digest(JSON.stringify(entries)));
    expect(workspaceBackupInventoryDigest(inventoryBytes)).toBe(digest(inventoryBytes));
    const manifest = {
      ...fixture.manifest,
      inventory: entries,
      inventoryDigest: digest(inventoryBytes),
    };
    await writeMetadata(fixture, manifest, inventoryJson);
    await withVerifiedWorkspaceBackupBundle(fixture.input, async (bundle) => {
      expect(bundle.manifest.inventory).toEqual(entries);
      expect(await consumeBytes(bundle, PAYLOADS[0]!.path)).toEqual(PAYLOADS[0]!.bytes);
    });
    // Only inventory serialization changes; every file and the refreshed outer seal are valid.
    await writeMetadata(fixture, manifest, JSON.stringify(entries));
    await expectRefusal(fixture.input);
  });

  it.each([
    'description',
    'sourcePath',
  ])('Bundle closed inventory; Core "authority ... MUST refuse unknown fields" — rejects inventory key %s', async (field) => {
    const fixture = await bundleFixture();
    const inventory = fixture.manifest.inventory.map((entry, index) =>
      index === 0 ? { ...entry, [field]: 'unused-addition' } : entry
    );
    const inventoryJson = JSON.stringify(inventory);
    const manifest = {
      ...fixture.manifest,
      inventory,
      inventoryDigest: digest(inventoryJson),
    };
    expect(() => workspaceBackupInventoryDigest(Buffer.from(inventoryJson))).toThrow();
    expect(() => parseWorkspaceBackupManifest(manifest)).toThrow();
    await writeMetadata(fixture, manifest, inventoryJson);
    await expectRefusal(fixture.input);
  });

  it.each([
    ['negative length', { bytes: -1 }],
    ['fractional length', { bytes: 0.5 }],
    ['invalid digest', { sha256: 'sha256:xyz' }],
    ['NUL in path', { path: 'bad\u0000name' }],
    ['missing mode', { mode: undefined }],
    ['negative mode', { mode: -1 }],
  ] as const)('Bundle inventory: "byte length, raw SHA-256, and file modes" — rejects %s', (_name, change) => {
    const inventory = [{ ...manifestFor().inventory[0], ...change }];
    expect(() => workspaceBackupInventoryDigest(Buffer.from(JSON.stringify(inventory)))).toThrow();
  });

  it('Bundle: "verify this digest independently of individual file digests" — rejects a wrong inventory digest', async () => {
    const fixture = await bundleFixture();
    await writeMetadata(fixture, {
      ...fixture.manifest,
      inventoryDigest: digest('wrong inventory'),
    });
    await expectRefusal(fixture.input);
  });

  it('Bundle: "all required features" — admits supported requirements and refuses unsupported authority semantics', async () => {
    const fixture = await bundleFixture();
    const feature = 'workspace.backup.fixture-authority';
    await writeMetadata(fixture, { ...fixture.manifest, requiredFeatures: [feature] });
    await expectRefusal(fixture.input);
    await withVerifiedWorkspaceBackupBundle(
      { ...fixture.input, supportedRequiredFeatures: [feature] },
      async (bundle) => {
        expect(bundle.manifest.requiredFeatures).toEqual([feature]);
        expect(await consumeBytes(bundle, PAYLOADS[0]!.path)).toEqual(PAYLOADS[0]!.bytes);
      }
    );
  });

  it.each([
    ['version', { ...RELEASE, version: '0.1.0-rc.12' }],
    ['build', { ...RELEASE, buildId: 'abcdef1234567890abcdef1234567890abcdef12' }],
  ] as const)('Bundle: "same exact release" — rejects a target %s mismatch', async (_name, expectedRelease) => {
    const fixture = await bundleFixture();
    await expectRefusal({ ...fixture.input, expectedRelease });
  });

  it.each([
    ['unknown marker', {}],
    ['unsupported marker version', { workspace: 2 }],
  ] as const)('Bundle: "database format markers ... unsupported required semantics refuse" — rejects %s', async (_name, supportedDatabaseFormats) => {
    const fixture = await bundleFixture();
    await expectRefusal({ ...fixture.input, supportedDatabaseFormats });
  });

  it.each([
    ['version', { version: 2 }],
    ['backup identity', { backupId: OTHER_BACKUP_ID }],
    ['purpose', { purpose: 'move' }],
    ['manifest digest', { manifestDigest: digest('different manifest') }],
  ] as const)('Bundle: "A versioned seal binds the backup identity, purpose, and exact manifest digest" — rejects %s mismatch', async (_name, change) => {
    const fixture = await bundleFixture();
    await writeFile(
      path.join(fixture.bundleRoot, 'seal.json'),
      JSON.stringify({ ...fixture.seal, ...change })
    );
    await expectRefusal(fixture.input);
  });

  it('Bundle: "without a valid seal is incomplete" — refuses a missing seal', async () => {
    const fixture = await bundleFixture();
    await rm(path.join(fixture.bundleRoot, 'seal.json'));
    await expectRefusal(fixture.input);
  });

  it('Bundle: "exact manifest digest" — refuses a stale seal after a whitespace-only manifest change', async () => {
    const fixture = await bundleFixture();
    await writeFile(
      path.join(fixture.bundleRoot, 'manifest.json'),
      Buffer.concat([fixture.manifestBytes, Buffer.from('\n')])
    );
    await expectRefusal(fixture.input);
  });

  it.each([
    'manifest',
    'seal',
  ] as const)('Bundle closed core and exact binding — refuses ambiguous duplicate JSON keys in %s', async (metadata) => {
    const fixture = await bundleFixture();
    if (metadata === 'manifest') {
      const bytes = Buffer.from(
        fixture.manifestBytes.toString().replace('"version":1', '"version":2,"version":1')
      );
      await writeFile(path.join(fixture.bundleRoot, 'manifest.json'), bytes);
      await writeFile(path.join(fixture.bundleRoot, 'seal.json'), JSON.stringify(sealFor(bytes)));
    } else {
      await writeFile(
        path.join(fixture.bundleRoot, 'seal.json'),
        JSON.stringify(fixture.seal).replace('"version":1', '"version":2,"version":1')
      );
    }
    await expectRefusal(fixture.input);
  });

  it('Bundle: "Every admitted snapshot/content file exactly once" — rejects a duplicate with valid digests', async () => {
    const fixture = await bundleFixture();
    const inventory = [...fixture.manifest.inventory, fixture.manifest.inventory[0]!];
    await writeMetadata(fixture, {
      ...fixture.manifest,
      inventory,
      inventoryDigest: digest(JSON.stringify(inventory)),
    });
    await expectRefusal(fixture.input);
  });

  it.each([
    'missing',
    'unlisted',
    'corrupt',
    'length',
    'mode',
  ] as const)('Restore-1: "Reject ... missing, unlisted" and Bundle exact bytes/modes — rejects %s file', async (fault) => {
    const fixture = await bundleFixture();
    const file = PAYLOADS[0]!;
    const target = path.join(fixture.bundleRoot, file.path);
    if (fault === 'missing') await rm(target);
    if (fault === 'unlisted') {
      await writeFile(path.join(fixture.bundleRoot, 'unexpected.bin'), Buffer.from([42]));
    }
    if (fault === 'corrupt') {
      const bytes = Buffer.from(file.bytes);
      bytes[0] = 123;
      await writeFile(target, bytes);
    }
    if (fault === 'length') {
      // Keep the actual bytes and their hash valid so only the length oracle can refuse.
      const inventory = fixture.manifest.inventory.map((entry, index) =>
        index === 0 ? { ...entry, bytes: entry.bytes + 1 } : entry
      );
      await writeMetadata(fixture, {
        ...fixture.manifest,
        inventory,
        inventoryDigest: digest(JSON.stringify(inventory)),
      });
    }
    if (fault === 'mode') await chmod(target, 0o700);
    await expectRefusal(fixture.input);
  });

  it.each([
    'manifest.json',
    'seal.json',
  ])('Bundle: "exclude the root manifest and completion seal to avoid a digest cycle" — rejects listed %s', async (relativePath) => {
    const fixture = await bundleFixture();
    const bytes = await readFile(path.join(fixture.bundleRoot, relativePath));
    const inventory = [
      ...fixture.manifest.inventory,
      { path: relativePath, bytes: bytes.length, sha256: digest(bytes), mode: 0o600 },
    ];
    expect(() =>
      parseWorkspaceBackupManifest({
        ...fixture.manifest,
        inventory,
        inventoryDigest: digest(JSON.stringify(inventory)),
      })
    ).toThrow();
  });

  it.each([
    'absolute',
    'parent',
    'nested-parent',
    'backslash',
  ] as const)('Bundle: "confined relative path"; Restore-1: "unsafe entries" — rejects %s', async (form) => {
    const fixture = await bundleFixture();
    const outside = path.join(fixture.root, 'outside.bin');
    const paths = {
      absolute: outside,
      parent: '../outside.bin',
      'nested-parent': 'content/../../outside.bin',
      backslash: 'content\\escape.bin',
    };
    const unsafePath = paths[form];
    // A permissive reader can find matching bytes, with no unrelated extra-file failure.
    const target = form === 'backslash' ? path.join(fixture.bundleRoot, unsafePath) : outside;
    await rm(path.join(fixture.bundleRoot, PAYLOADS[0]!.path));
    await writeFile(target, PAYLOADS[0]!.bytes, { mode: PAYLOADS[0]!.mode });
    await chmod(target, PAYLOADS[0]!.mode);
    const inventory = [
      { ...fixture.manifest.inventory[0]!, path: unsafePath },
      fixture.manifest.inventory[1]!,
    ];
    expect(() => workspaceBackupInventoryDigest(Buffer.from(JSON.stringify(inventory)))).toThrow();
    await writeMetadata(fixture, {
      ...fixture.manifest,
      inventory,
      inventoryDigest: digest(JSON.stringify(inventory)),
      databaseFormats: [{ path: unsafePath, markers: { ...DATABASE_FORMATS } }],
    });
    await expectRefusal(fixture.input);
    expect(await readFile(target)).toEqual(PAYLOADS[0]!.bytes);
  });

  it.each([
    ['payload symlink', 'symlink', 'snapshots/workspace.sqlite'],
    ['manifest symlink', 'symlink', 'manifest.json'],
    ['seal symlink', 'symlink', 'seal.json'],
    ['payload hard link', 'hardlink', 'snapshots/workspace.sqlite'],
    ['manifest hard link', 'hardlink', 'manifest.json'],
    ['seal hard link', 'hardlink', 'seal.json'],
  ] as const)('Restore-1: "Reject ... linked ... entries" — rejects %s even when bytes match', async (_name, kind, relativePath) => {
    const fixture = await bundleFixture();
    const target = path.join(fixture.bundleRoot, relativePath);
    const outside = path.join(fixture.root, 'outside-but-test-owned');
    const before = await readFile(target);
    await rename(target, outside);
    if (kind === 'symlink') await symlink(outside, target);
    else await link(outside, target);
    await expectRefusal(fixture.input);
    expect(await readFile(outside)).toEqual(before);
  });

  it.each([
    'bundle',
    'content',
  ] as const)('Bundle: "confined regular-file paths"; Restore-1: "linked" — rejects a symlinked %s directory', async (directory) => {
    const fixture = await bundleFixture();
    const target =
      directory === 'bundle' ? fixture.bundleRoot : path.join(fixture.bundleRoot, 'content');
    const outside = path.join(fixture.root, 'outside-directory');
    await rename(target, outside);
    await symlink(outside, target, 'dir');
    await expectRefusal(fixture.input);
    const preserved = path.join(outside, directory === 'bundle' ? PAYLOADS[1]!.path : 'tool.sh');
    expect(await readFile(preserved)).toEqual(PAYLOADS[1]!.bytes);
  });

  it('Bundle: "regular-file paths" — rejects a directory in place of a listed file', async () => {
    const fixture = await bundleFixture();
    const target = path.join(fixture.bundleRoot, PAYLOADS[0]!.path);
    await rm(target);
    await mkdir(target);
    await expectRefusal(fixture.input);
  });

  it('Restore-1: "Parse or copy only verified bytes" — consumes copies after source overwrite and replacement', async () => {
    const fixture = await bundleFixture();
    await withVerifiedWorkspaceBackupBundle(fixture.input, async (bundle) => {
      await writeFile(path.join(fixture.bundleRoot, PAYLOADS[0]!.path), Buffer.from('overwritten'));
      const second = path.join(fixture.bundleRoot, PAYLOADS[1]!.path);
      await rename(second, path.join(fixture.root, 'original-tool'));
      await writeFile(second, Buffer.from('replacement'));
      await writeFile(path.join(fixture.bundleRoot, 'manifest.json'), '{}');
      await writeFile(path.join(fixture.bundleRoot, 'seal.json'), '{}');
      for (const file of PAYLOADS) {
        expect(await consumeBytes(bundle, file.path)).toEqual(file.bytes);
      }
      expect(bundle.manifest).toEqual(fixture.manifest);
      expect(bundle.manifestDigest).toBe(digest(fixture.manifestBytes));
      await expect(consumeBytes(bundle, '../original-tool')).rejects.toThrow();
      await expect(consumeBytes(bundle, 'not-in-inventory')).rejects.toThrow();
    });
  });

  it.each([
    'success',
    'failure',
  ] as const)('Bundle: "Use private staging"; Restore-1: "only verified bytes" — closes consumption after callback %s', async (outcome) => {
    const fixture = await bundleFixture();
    let retained: VerifiedWorkspaceBackupBundle | undefined;
    const callbackError = new Error('fixture consumer failed');
    const operation = withVerifiedWorkspaceBackupBundle(fixture.input, async (bundle) => {
      retained = bundle;
      expect(await consumeBytes(bundle, PAYLOADS[0]!.path)).toEqual(PAYLOADS[0]!.bytes);
      if (outcome === 'failure') throw callbackError;
      return 'ok';
    });
    if (outcome === 'failure') await expect(operation).rejects.toBe(callbackError);
    else await expect(operation).resolves.toBe('ok');
    expect(retained).toBeDefined();
    await expect(consumeBytes(retained!, PAYLOADS[0]!.path)).rejects.toThrow();
    expect(await readdir(fixture.stagingParent)).toEqual([]);
    expect(await readFile(path.join(fixture.bundleRoot, PAYLOADS[0]!.path))).toEqual(
      PAYLOADS[0]!.bytes
    );
  });

  it('Bundle: "existing capacity limits" — refuses unavailable staging capacity before consumption', async () => {
    const fixture = await bundleFixture();
    await expectRefusal({
      ...fixture.input,
      admission: new FileStorageAdmission(
        fixture.root,
        () => 1n,
        () => 0n
      ),
    });
    expect(await readdir(fixture.stagingParent)).toEqual([]);
    expect(await readFile(path.join(fixture.bundleRoot, PAYLOADS[0]!.path))).toEqual(
      PAYLOADS[0]!.bytes
    );
  });
});

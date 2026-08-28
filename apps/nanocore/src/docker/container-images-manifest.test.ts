import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const manifestPath = join(repoRoot, 'containers', 'images.json');

/** Repository-owned container image catalog used by local Docker helpers and release CI. */
interface ContainerImageManifest {
  /** Manifest schema version. */
  readonly schemaVersion: number;
  /** Container registry hostname. */
  readonly registry: string;
  /** Declared image entries. */
  readonly images: readonly ContainerImageEntry[];
}

/** One buildable container image entry. */
interface ContainerImageEntry {
  /** Stable image identifier for scripts and CI. */
  readonly id: string;
  /** Repository name below the registry owner. */
  readonly repository: string;
  /** Dockerfile path relative to the repository root. */
  readonly dockerfile: string;
  /** Docker build context path relative to the repository root. */
  readonly context: string;
  /** Product role for the image. */
  readonly kind: 'app' | 'worker' | 'test';
  /** Whether version-tag releases publish this image. */
  readonly release: boolean;
  /** Target build platforms. */
  readonly platforms: readonly string[];
  /** Smoke script path relative to the repository root. */
  readonly smoke: string;
  /** In-container smoke command installed by the Dockerfile. */
  readonly smokeCommand: string;
  /** Local development image tag used by helper scripts. */
  readonly localTag: string;
  /** Singular catalog runtime for the current declared set; omit when that set is empty. */
  readonly runtime?: string;
  /** Upstream base image for worker and CI review. */
  readonly baseImage?: string;
  /** Worker execution contract implemented by the image. */
  readonly workerContract?: string;
  /** Docker build target for a shared multi-target Dockerfile. */
  readonly target?: string;
}

describe('container image manifest', () => {
  it('declares the live image catalog with existing Dockerfiles and smoke scripts', () => {
    const manifest = readManifest();

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.registry).toBe('ghcr.io');
    expect(manifest.images.map((image) => image.id)).toEqual(
      expect.arrayContaining([
        'app',
        'worker-common',
        ...currentWorkerLeaves.map((leaf) => leaf.id),
        'test-env',
      ])
    );

    for (const image of manifest.images) {
      expect(image.repository).toMatch(/^openkit-/);
      expect(image.context).toBe('.');
      expect(image.platforms.length).toBeGreaterThan(0);
      expect(image.localTag).toMatch(/^openkit\//);
      expect(image.smokeCommand).toMatch(/^openkit-/);
      expect(image.dockerfile).not.toMatch(/^\//);
      expect(image.smoke).not.toMatch(/^\//);
      expect(image.context).not.toMatch(/^\//);
      expect(existsSync(join(repoRoot, image.dockerfile))).toBe(true);
      expect(existsSync(join(repoRoot, image.smoke))).toBe(true);
    }
  });

  it('publishes worker-common as a releaseable empty declared runtime set', () => {
    const manifest = readManifest();
    const workers = manifest.images.filter((image) => image.kind === 'worker');
    const base = workers.find((image) => image.id === 'worker-common');

    expect(base).toEqual(
      expect.objectContaining({
        dockerfile: 'containers/workers/Dockerfile',
        kind: 'worker',
        release: true,
        smoke: 'containers/workers/openkit-worker-common-base-smoke.sh',
        target: 'worker-common',
      })
    );
    expect(base).not.toHaveProperty('runtime');
    expect(base).not.toHaveProperty('workerContract');
    expect(base?.baseImage).toBeTruthy();

    for (const leaf of currentWorkerLeaves) {
      const worker = workers.find((image) => image.id === leaf.id);

      expect(worker).toMatchObject({
        dockerfile: 'containers/workers/Dockerfile',
        kind: 'worker',
        release: true,
        runtime: leaf.runtime,
        target: leaf.id,
        workerContract: 'openkit-worker-v1',
      });
      expect(worker?.baseImage).toBeTruthy();
    }
    expect(new Set(workers.map((image) => image.target)).size).toBe(workers.length);
  });

  it('pins release worker base images by digest', () => {
    const manifest = readManifest();
    const releaseWorkers = manifest.images.filter(
      (image) => image.kind === 'worker' && image.release
    );

    expect(releaseWorkers.map((image) => image.id)).toEqual(
      expect.arrayContaining(['worker-common', ...currentWorkerLeaves.map((leaf) => leaf.id)])
    );
    for (const image of releaseWorkers) {
      expect(image.baseImage).toMatch(/@sha256:[a-f0-9]{64}$/);
    }
  });

  it('does not publish the test execution image on release tags', () => {
    const manifest = readManifest();
    const testEnv = manifest.images.find((image) => image.id === 'test-env');

    expect(testEnv).toMatchObject({
      kind: 'test',
      release: false,
    });
  });
});

/** Current OpenKit worker leaves and their singular catalog-declared runtimes. */
const currentWorkerLeaves = [
  { id: 'worker-codex', runtime: 'codex' },
  { id: 'worker-opencode', runtime: 'opencode' },
  { id: 'worker-pi', runtime: 'pi' },
] as const;

/**
 * Reads the repository image manifest.
 *
 * @returns Parsed image manifest.
 */
function readManifest(): ContainerImageManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as ContainerImageManifest;
}

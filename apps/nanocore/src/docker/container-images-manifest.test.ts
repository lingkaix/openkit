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
  /** Worker runtime name when kind is worker. */
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
    expect(manifest.images.map((image) => image.id)).toEqual([
      'app',
      'worker-codex',
      'worker-opencode',
      'worker-pi',
      'test-env',
    ]);

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

  it('keeps every manifest-selected worker image explicit and releaseable', () => {
    const manifest = readManifest();
    const workers = manifest.images.filter((image) => image.kind === 'worker');

    expect(workers.map((image) => image.runtime)).toEqual(['codex', 'opencode', 'pi']);
    expect(workers.map((image) => image.dockerfile)).toEqual([
      'containers/workers/Dockerfile',
      'containers/workers/Dockerfile',
      'containers/workers/Dockerfile',
    ]);
    expect(workers.map((image) => image.target)).toEqual([
      'worker-codex',
      'worker-opencode',
      'worker-pi',
    ]);
    expect(new Set(workers.map((image) => image.target)).size).toBe(workers.length);
    for (const worker of workers) {
      expect(worker).toMatchObject({
        kind: 'worker',
        release: true,
        target: worker.id,
        workerContract: 'openkit-worker-v1',
      });
      expect(worker.baseImage).toBeTruthy();
    }
  });

  it('pins release worker base images by digest', () => {
    const manifest = readManifest();
    const releaseWorkers = manifest.images.filter(
      (image) => image.kind === 'worker' && image.release
    );

    expect(releaseWorkers.length).toBeGreaterThan(0);
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

/**
 * Reads the repository image manifest.
 *
 * @returns Parsed image manifest.
 */
function readManifest(): ContainerImageManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as ContainerImageManifest;
}

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const appDockerfile = join(repoRoot, 'containers', 'app', 'Dockerfile');
const imageManifest = join(repoRoot, 'containers', 'images.json');

describe('app Dockerfile', () => {
  it('delegates workspace dependency order to pnpm', () => {
    const dockerfile = readFileSync(appDockerfile, 'utf8');

    expect(dockerfile).toContain(
      'RUN pnpm --filter @openkit/nanocore... --filter @openkit/web... build'
    );
  });

  it('does not bundle worker runtimes into the app image', () => {
    const dockerfile = readFileSync(appDockerfile, 'utf8');

    expect(dockerfile).not.toContain('@openai/codex');
    expect(dockerfile).not.toContain('opencode');
    expect(dockerfile).not.toContain('/opt/codex');
  });

  it('keeps Git available to the NanoCore runtime', () => {
    const dockerfile = readFileSync(appDockerfile, 'utf8');
    const runtimeStage = dockerfile.split(' AS runtime')[1] ?? '';

    expect(runtimeStage).toContain('    git \\\n');
  });

  it('uses the cataloged digest-pinned base in both stages', () => {
    const dockerfile = readFileSync(appDockerfile, 'utf8');
    const manifest = JSON.parse(readFileSync(imageManifest, 'utf8'));
    const app = manifest.images.find((image: { id: string }) => image.id === 'app');

    expect(app.baseImage).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(dockerfile.split(`FROM ${app.baseImage}`).length - 1).toBe(2);
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const openShellWorkerDockerfile = join(repoRoot, 'containers', 'worker-codex', 'Dockerfile');
const imageManifestPath = join(repoRoot, 'containers', 'images.json');

describe('Codex worker Dockerfile', () => {
  it('uses digest-pinned Node base images for release builds', () => {
    const manifest = JSON.parse(readFileSync(imageManifestPath, 'utf8')) as {
      images: Array<{ baseImage?: string; id: string }>;
    };
    const baseImage = manifest.images.find((image) => image.id === 'worker-codex')?.baseImage;
    const dockerfile = readFileSync(openShellWorkerDockerfile, 'utf8');

    expect(baseImage).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(dockerfile).toContain(`FROM ${baseImage} AS builder`);
    expect(dockerfile).toContain(`FROM ${baseImage} AS runtime`);
  });

  it('builds and installs the worker shim package into the sandbox image', () => {
    const dockerfile = readFileSync(openShellWorkerDockerfile, 'utf8');

    expect(dockerfile).toContain('COPY packages/worker-protocol/package.json');
    expect(dockerfile).toContain('COPY packages/worker-protocol packages/worker-protocol');
    expect(dockerfile).toContain('pnpm --filter @openkit/worker-protocol build');
    expect(dockerfile).toContain('pnpm --filter @openkit/worker-shim build');
    expect(dockerfile).toContain('pnpm --filter @openkit/worker-shim deploy --prod --legacy');
    expect(dockerfile).toContain('/usr/local/lib/openkit/worker-shim');
    expect(dockerfile).toContain('/usr/local/bin/openkit-codex-shim');
    expect(dockerfile).toContain('/usr/local/bin/openkit-worker-sidecar');
    expect(dockerfile).toContain("printf '%s\\n'");
    expect(dockerfile).not.toContain("<<'EOF'");
  });

  it('installs the native Codex payload and prepares OpenKit session directories', () => {
    const dockerfile = readFileSync(openShellWorkerDockerfile, 'utf8');

    expect(dockerfile).toContain('ARG TARGETARCH');
    expect(dockerfile).toContain(
      '@openai/codex-linux-$' +
        '{codex_npm_arch}@npm:@openai/codex@$' +
        '{CODEX_CLI_VERSION}-$' +
        '{codex_npm_tag}'
    );
    expect(dockerfile).toContain('/usr/local/lib/codex/codex/codex');
    expect(dockerfile).toContain('/openkit/session');
    expect(dockerfile).toContain('/openkit/artifacts');
    expect(dockerfile).toContain('/openkit/config');
    expect(dockerfile).not.toContain('npm install --global "@openai/codex');
  });

  it('maps the OpenKit runtime root into the OpenShell writable sandbox directory', () => {
    const dockerfile = readFileSync(openShellWorkerDockerfile, 'utf8');

    expect(dockerfile).toContain('mkdir -p /sandbox/openkit/session');
    expect(dockerfile).toContain('ln -s /sandbox/openkit /openkit');
  });

  it('installs OpenShell supervisor runtime prerequisites', () => {
    const dockerfile = readFileSync(openShellWorkerDockerfile, 'utf8');

    expect(dockerfile).toContain('iproute2');
  });

  it('declares the sandbox user required by the real OpenShell supervisor', () => {
    const dockerfile = readFileSync(openShellWorkerDockerfile, 'utf8');

    expect(dockerfile).toContain('groupadd --system sandbox');
    expect(dockerfile).toContain('useradd --system');
    expect(dockerfile).toContain('--home-dir /sandbox');
    expect(dockerfile).toContain('ENV HOME="/sandbox"');
    expect(dockerfile).toContain('chown -R sandbox:sandbox /sandbox /workspace');
  });
});

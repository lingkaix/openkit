import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const openShellWorkerDockerfile = join(repoRoot, 'containers', 'worker-codex', 'Dockerfile');
const imageManifestPath = join(repoRoot, 'containers', 'images.json');
const codexSchemaMetadataPath = join(
  repoRoot,
  'packages',
  'codex-app-server-schema',
  'metadata.json'
);

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
    expect(dockerfile).not.toContain('/usr/local/bin/openkit-worker-sidecar');
    expect(dockerfile).not.toContain('openkit-worker-sidecar.js');
    expect(dockerfile).toContain(`exec 3<<<"\${OPENKIT_CONTROL_TOKEN:-}"`);
    expect(dockerfile).toContain('exec env -i');
    expect(dockerfile).toContain('OPENKIT_CONTROL_TOKEN_FD=3');
    expect(dockerfile).toContain("printf '%s\\n'");
    expect(dockerfile).not.toContain("<<'EOF'");
  });

  it('preserves OpenShell proxy variables without exposing the control token', () => {
    const dockerfile = readFileSync(openShellWorkerDockerfile, 'utf8');

    for (const key of ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      expect(dockerfile).toContain(`${key}="\${${key}:-}"`);
    }
    expect(dockerfile).toContain('NODE_USE_ENV_PROXY=1');
    expect(dockerfile).not.toContain("'  OPENKIT_CONTROL_TOKEN=");
  });

  it('preserves inherited no-proxy entries without bypassing worker-control policy', () => {
    const dockerfile = readFileSync(openShellWorkerDockerfile, 'utf8');
    const launcherLines = [...dockerfile.matchAll(/^\s*'(.*)' \\\s*$/gm)].map(
      (match) => match[1] ?? ''
    );
    launcherLines[launcherLines.length - 1] = '  /usr/bin/env';
    const launcher = launcherLines.join('\n');

    const inherited = {
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: 'localhost,127.0.0.1',
    };
    const output = execFileSync('/bin/bash', ['-c', launcher], {
      encoding: 'utf8',
      env: {
        HOME: '/sandbox',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        ...inherited,
      },
    });
    const environment = Object.fromEntries(
      output
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );

    expect(environment.NO_PROXY).toBe(inherited.NO_PROXY);
    expect(environment.no_proxy).toBe(inherited.no_proxy);
    expect(environment).not.toHaveProperty('OPENKIT_CONTROL_TOKEN');
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
    expect(dockerfile).toContain('/usr/local/lib/codex/bin/codex');
    expect(dockerfile).toContain('/openkit/session');
    expect(dockerfile).toContain('/openkit/artifacts');
    expect(dockerfile).toContain('/openkit/config');
    expect(dockerfile).not.toContain('npm install --global "@openai/codex');
  });

  it('keeps the worker Codex version aligned with the vendored app-server schema', () => {
    const dockerfile = readFileSync(openShellWorkerDockerfile, 'utf8');
    const metadata = JSON.parse(readFileSync(codexSchemaMetadataPath, 'utf8')) as {
      sourcePackage: string;
    };
    const imageVersion = /^ARG CODEX_CLI_VERSION="([^"]+)"$/m.exec(dockerfile)?.[1];
    const schemaVersion = /^@openai\/codex@(.+)$/.exec(metadata.sourcePackage)?.[1];

    expect(imageVersion).toBe(schemaVersion);
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

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const appDockerfile = join(repoRoot, 'containers', 'app', 'Dockerfile');
const devE2eDockerfile = join(repoRoot, 'containers', 'dev-e2e', 'Dockerfile');

describe('app Dockerfile', () => {
  it('builds workspace dependencies before dependent apps', () => {
    const dockerfile = readFileSync(appDockerfile, 'utf8');
    const appApiSchemasBuild = dockerfile.indexOf('pnpm --filter @openkit/app-api-schemas build');
    const coreClientBuild = dockerfile.indexOf('pnpm --filter @openkit/core-client build');
    const configSchemaBuild = dockerfile.indexOf('pnpm --filter @openkit/config-schema build');
    const nanoCoreBuild = dockerfile.indexOf('pnpm --filter @openkit/nanocore build');

    expect(appApiSchemasBuild).toBeGreaterThanOrEqual(0);
    expect(coreClientBuild).toBeGreaterThanOrEqual(0);
    expect(configSchemaBuild).toBeGreaterThanOrEqual(0);
    expect(nanoCoreBuild).toBeGreaterThanOrEqual(0);
    expect(appApiSchemasBuild).toBeLessThan(coreClientBuild);
    expect(appApiSchemasBuild).toBeLessThan(nanoCoreBuild);
    expect(configSchemaBuild).toBeLessThan(nanoCoreBuild);
  });

  it('does not bundle worker runtimes into the app image', () => {
    const dockerfile = readFileSync(appDockerfile, 'utf8');

    expect(dockerfile).not.toContain('@openai/codex');
    expect(dockerfile).not.toContain('opencode');
    expect(dockerfile).not.toContain('/opt/codex');
  });
});

describe('dev-e2e Dockerfile', () => {
  it('installs Codex from the platform-native payload instead of the npm wrapper', () => {
    const dockerfile = readFileSync(devE2eDockerfile, 'utf8');

    expect(dockerfile).toContain('ARG TARGETARCH');
    expect(dockerfile).toContain(
      '@openai/codex-linux-$' +
        '{codex_npm_arch}@npm:@openai/codex@$' +
        '{CODEX_CLI_VERSION}-$' +
        '{codex_npm_tag}'
    );
    expect(dockerfile).toContain('/opt/codex/bin/codex');
    expect(dockerfile).not.toContain('npm install --global @openai/codex');
  });
});

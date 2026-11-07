import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { seedSimulatorInferenceConfig } from '../../../e2e/_lib/simulator-inference';

const nanoCoreDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../nanocore/dist');

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('local simulator fixture', () => {
  it('admits the Assistant on the seeded reasoning model', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-web-simulator-'));
    roots.push(dataRoot);
    await seedSimulatorInferenceConfig(dataRoot);
    const gatewayConfig = JSON.parse(
      await readFile(join(dataRoot, 'config', 'gateway.jsonc'), 'utf8')
    );
    const profilesConfig = JSON.parse(
      await readFile(join(dataRoot, 'config', 'internal-role-profiles.jsonc'), 'utf8')
    );
    const load = (name: string) => import(pathToFileURL(resolve(nanoCoreDist, name)).href);
    const [{ loadProviderProfiles }, { ProviderRegistry }, { resolveInternalRoleProfile }] =
      await Promise.all([
        load('config/providers-loader.js'),
        load('providers/registry.js'),
        load('internal-agents/profile-resolver.js'),
      ]);
    const resolved = resolveInternalRoleProfile({
      roleId: 'assistant',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      gatewayConfig,
      profilesConfig,
      providerRegistry: new ProviderRegistry(loadProviderProfiles(dataRoot).profiles),
    });

    expect(resolved?.logicalModel.id).toBe('reasoning');
    expect(profilesConfig.defaultLogicalModelId).not.toBe('smart');
  }, 30_000);
});

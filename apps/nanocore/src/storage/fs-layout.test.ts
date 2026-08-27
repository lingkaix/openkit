import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openCoreDb } from './db.js';
import {
  coreDbPath,
  ensureConfigTemplateSurface,
  ensureLayout,
  ensureUserLayout,
  ensureWorkspaceLayout,
  readDataRootLayoutMarker,
  recordDataRootDeploymentMove,
  resolveDataRootPath,
} from './fs-layout.js';

const DEPLOYMENT_ID_PATTERN =
  /^dep_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Asserts that a path exists and is a directory.
 *
 * @param path Directory path to inspect.
 */
function expectDirectory(path: string): void {
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).isDirectory()).toBe(true);
}

/**
 * Lists all directories below a root in stable relative order.
 *
 * @param root Directory root to inspect.
 * @returns Relative directory paths including nested directories.
 */
function listDirectories(root: string): string[] {
  const directories: string[] = [];

  /**
   * Visits one directory and records its child directories.
   *
   * @param directory Directory to visit.
   */
  function visit(directory: string): void {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);

      if (statSync(path).isDirectory()) {
        directories.push(relative(root, path));
        visit(path);
      }
    }
  }

  visit(root);
  return directories;
}

describe('ensureLayout', () => {
  it('creates v0.0.3 runtime directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    ensureLayout(root);

    for (const path of [
      join(root, 'config'),
      join(root, 'config', 'providers'),
      join(root, 'local'),
      join(root, 'server'),
      join(root, 'logs'),
    ]) {
      expectDirectory(path);
    }
  });

  it('creates the v2 owner-independent workspace root without an owner-nested workspace tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    ensureLayout(root);

    for (const path of [join(root, 'config', 'agents'), join(root, 'workspaces')]) {
      expectDirectory(path);
    }
    expect(existsSync(join(root, 'users', 'user_local', 'workspaces'))).toBe(false);
  });

  it('is idempotent across repeated calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    const first = ensureLayout(root);
    const firstDirectories = listDirectories(root);
    const second = ensureLayout(root);

    expect(first).toEqual(second);
    expect(firstDirectories).toEqual(listDirectories(root));
    expect(existsSync(root)).toBe(true);
    expect(firstDirectories).toEqual([
      'config',
      'config/agents',
      'config/providers',
      'local',
      'logs',
      'server',
      'server/db',
      'server/evidence',
      'server/exports',
      'server/files',
      'server/logs',
      'server/migrations',
      'server/runtime',
      'server/runtime/agents',
      'server/runtime/config',
      'server/runtime/sessions',
      'server/vault',
      'server/vendor',
      'server/vendor/models.dev',
      'users',
      'users/user_local',
      'users/user_local/config',
      'users/user_local/data',
      'users/user_local/db',
      'users/user_local/files',
      'users/user_local/logs',
      'workspaces',
    ]);
  });

  it('preserves managed Codex runtime scratch across repeated layout checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-codex-scratch-'));
    const codexHome = join(
      root,
      'server',
      'files',
      'oauth',
      'openai-codex',
      'accounts',
      'default',
      'codex-home'
    );
    const sentinelPath = join(codexHome, 'tmp', 'sentinel.txt');

    mkdirSync(join(codexHome, 'tmp'), { recursive: true });
    writeFileSync(sentinelPath, 'preserve managed Codex runtime scratch\n');

    ensureLayout(root);
    ensureLayout(root);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('preserve managed Codex runtime scratch\n');
  });

  it('creates stable distinct deployment identities for fresh data roots', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    ensureLayout(firstRoot);
    ensureLayout(secondRoot);
    const firstMarker = readDataRootLayoutMarker(firstRoot);
    const secondMarker = readDataRootLayoutMarker(secondRoot);

    expect(firstMarker.deploymentId).toMatch(DEPLOYMENT_ID_PATTERN);
    expect(secondMarker.deploymentId).toMatch(DEPLOYMENT_ID_PATTERN);
    expect(secondMarker.deploymentId).not.toBe(firstMarker.deploymentId);
    ensureLayout(firstRoot);
    expect(readDataRootLayoutMarker(firstRoot)).toEqual(firstMarker);
    expect(readFileSync(join(firstRoot, 'server', 'layout.json'), 'utf8')).toContain(
      '"layoutVersion": 2'
    );
  });

  it('records deployment id changes with predecessor lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    ensureLayout(root);
    const originalDeploymentId = readDataRootLayoutMarker(root).deploymentId;
    const marker = recordDataRootDeploymentMove(root, 'dep_moved');

    expect(marker).toEqual({
      schemaVersion: 1,
      layoutVersion: 2,
      deploymentId: 'dep_moved',
      predecessorDeploymentId: originalDeploymentId,
    });
    expect(readDataRootLayoutMarker(root)).toEqual(marker);
  });

  it('normalizes layout markers that predate deployment lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(
      join(root, 'server', 'layout.json'),
      `${JSON.stringify({ schemaVersion: 1, layoutVersion: 2 }, null, 2)}\n`
    );

    ensureLayout(root);

    const marker = readDataRootLayoutMarker(root);

    expect(marker.deploymentId).toMatch(DEPLOYMENT_ID_PATTERN);
    ensureLayout(root);
    expect(readDataRootLayoutMarker(root)).toEqual(marker);
  });

  it('fails closed on an incompatible data-root layout marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    ensureLayout(root);
    writeFileSync(
      join(root, 'server', 'layout.json'),
      `${JSON.stringify({ schemaVersion: 1, layoutVersion: 999 }, null, 2)}\n`
    );

    expect(() => ensureLayout(root)).toThrow(/Unsupported DATA_ROOT layout version/);
  });

  it('rejects a v1 marker before creating the v2 Workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(
      join(root, 'server', 'layout.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        layoutVersion: 1,
        deploymentId: 'dep_predecessor',
      })}\n`
    );

    expect(() => ensureLayout(root)).toThrow(/Unsupported DATA_ROOT layout version/);
    expect(existsSync(join(root, 'workspaces'))).toBe(false);
  });

  it('fails closed when the legacy root core database exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    writeFileSync(join(root, 'core.sqlite'), '');

    expect(() => ensureLayout(root)).toThrow(/legacy root core database/);
  });

  it('fails closed when a legacy workspace memory directory exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    mkdirSync(join(root, 'users', 'user_1', 'workspaces', 'ws_1', 'memory'), {
      recursive: true,
    });

    expect(() => ensureLayout(root)).toThrow(/legacy workspace memory directory/);
  });

  it('fails closed when a legacy workspace store snapshot exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const storePath = join(root, 'users', 'user_1', 'workspaces', 'ws_1', 'store.json');
    const legacySnapshot = '{"legacy":true}\n';

    mkdirSync(join(root, 'users', 'user_1', 'workspaces', 'ws_1'), { recursive: true });
    writeFileSync(storePath, legacySnapshot);

    expect(() => ensureLayout(root)).toThrow(/Unsupported legacy workspace store snapshot/);
    expect(readFileSync(storePath, 'utf8')).toBe(legacySnapshot);
  });

  it('fails closed when canonical database filenames appear under the wrong owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    mkdirSync(join(root, 'workspaces', 'ws_1', 'db'), { recursive: true });
    writeFileSync(join(root, 'workspaces', 'ws_1', 'db', 'core.sqlite'), '');

    expect(() => ensureLayout(root)).toThrow(/database ownership violation/);
  });

  it('allows canonical database filenames under their owning scopes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    mkdirSync(join(root, 'server', 'db'), { recursive: true });
    mkdirSync(join(root, 'users', 'user_1', 'db'), { recursive: true });
    mkdirSync(join(root, 'workspaces', 'ws_1', 'db'), { recursive: true });
    writeFileSync(join(root, 'server', 'db', 'core.sqlite'), '');
    writeFileSync(join(root, 'users', 'user_1', 'db', 'user.sqlite'), '');
    writeFileSync(join(root, 'workspaces', 'ws_1', 'db', 'workspace.sqlite'), '');

    expect(() => ensureLayout(root)).not.toThrow();
  });

  it('fails closed when a canonical record envelope names an unknown family', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    mkdirSync(join(root, 'workspaces', 'ws_1', 'evidence'), { recursive: true });
    writeFileSync(
      join(root, 'workspaces', 'ws_1', 'evidence', 'future.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        recordType: 'future-canonical-family',
        id: 'future_1',
        ownerScope: 'workspace',
        lineage: { workspaceId: 'ws_1' },
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
        contentDigest: 'sha256:future',
        redactionLevel: 'none',
        sensitivity: 'internal',
        requiredFeatures: [],
      })}\n`
    );

    expect(() => ensureLayout(root)).toThrow(/unsupported canonical record family/);
  });

  it('fails closed when a canonical record envelope requires unsupported features', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    mkdirSync(join(root, 'server', 'exports'), { recursive: true });
    writeFileSync(
      join(root, 'server', 'exports', 'workspace-export.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        recordType: 'workspace-export',
        id: 'export_1',
        ownerScope: 'workspace',
        lineage: { workspaceId: 'ws_1' },
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
        contentDigest: 'sha256:export',
        redactionLevel: 'none',
        sensitivity: 'internal',
        requiredFeatures: ['workspace.mount.fuse'],
      })}\n`
    );

    expect(() => ensureLayout(root)).toThrow(/unsupported requiredFeatures/);
  });

  it('fails closed when text records embed absolute data-root paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    mkdirSync(join(root, 'workspaces', 'ws_1', 'threads'), { recursive: true });
    writeFileSync(
      join(root, 'workspaces', 'ws_1', 'threads', 'thread.json'),
      `${JSON.stringify({ leakedPath: join(root, 'server', 'db', 'core.sqlite') })}\n`
    );

    expect(() => ensureLayout(root)).toThrow(/absolute DATA_ROOT path/);
  });

  it('does not scan SQLite databases for absolute data-root path text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    mkdirSync(join(root, 'server', 'db'), { recursive: true });
    writeFileSync(join(root, 'server', 'db', 'core.sqlite'), join(root, 'server'));

    expect(() => ensureLayout(root)).not.toThrow(/absolute DATA_ROOT path/);
  });

  it('creates the target server-owned runtime tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const paths = ensureLayout(root);

    for (const path of [
      paths.serverFiles,
      paths.serverDb,
      paths.serverEvidence,
      paths.serverExports,
      paths.serverLogs,
      paths.serverRuntime,
      paths.serverRuntimeConfig,
      paths.serverRuntimeAgents,
      paths.serverRuntimeSessions,
      paths.serverVault,
      paths.serverMigrations,
      paths.serverVendor,
      paths.serverModelsDev,
    ]) {
      expectDirectory(path);
    }
  });

  it('creates the server vault directory with owner-only permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const paths = ensureLayout(root);

    expect(statSync(paths.serverVault).mode & 0o777).toBe(0o700);
  });

  it('repairs an empty broad-permission server vault directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const serverVault = join(root, 'server', 'vault');
    mkdirSync(serverVault, { recursive: true });
    chmodSync(serverVault, 0o755);

    ensureLayout(root);

    expect(statSync(serverVault).mode & 0o777).toBe(0o700);
  });

  it('fails closed when a non-empty server vault directory has broad permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const serverVault = join(root, 'server', 'vault');
    mkdirSync(serverVault, { recursive: true });
    writeFileSync(join(serverVault, 'header.json'), '{}\n');
    chmodSync(serverVault, 0o755);

    expect(() => ensureLayout(root)).toThrow(/Vault store directory must use 0700 permissions/);
  });

  it('creates user and owner-independent workspace skeletons without overwriting files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const userPaths = ensureUserLayout(root, 'user_1');
    const workspacePaths = ensureWorkspaceLayout(root, 'ws_1');
    const operatorFile = join(workspacePaths.data, 'operator.txt');

    writeFileSync(operatorFile, 'operator-data\n');
    ensureUserLayout(root, 'user_1');
    ensureWorkspaceLayout(root, 'ws_1');

    for (const path of [
      userPaths.files,
      userPaths.data,
      userPaths.logs,
      userPaths.config,
      userPaths.db,
      workspacePaths.db,
      workspacePaths.logs,
      workspacePaths.artifacts,
      workspacePaths.knowledge,
      workspacePaths.sources,
      workspacePaths.reviews,
      workspacePaths.reviewsWorkspace,
      workspacePaths.evidence,
      workspacePaths.evidenceBundles,
      workspacePaths.evidenceBackend,
      workspacePaths.indexes,
      workspacePaths.threads,
      workspacePaths.runtime,
      workspacePaths.runtimeAgentSessions,
      workspacePaths.logsNanocore,
      workspacePaths.logsWorker,
    ]) {
      expectDirectory(path);
    }
    expect(workspacePaths.root).toBe(join(root, 'workspaces', 'ws_1'));
    expect(existsSync(join(root, 'users', 'user_1', 'workspaces', 'ws_1'))).toBe(false);
    expect(readFileSync(operatorFile, 'utf8')).toBe('operator-data\n');
  });

  it('creates ownership-scoped db directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    ensureLayout(root);

    expectDirectory(join(root, 'server', 'db'));
    expectDirectory(join(root, 'users', 'user_local', 'db'));
  });

  it('keeps core.sqlite under the server ownership scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    ensureLayout(root);

    const core = openCoreDb(root);

    try {
      expect(existsSync(coreDbPath(root))).toBe(true);
      expect(existsSync(join(root, 'core.sqlite'))).toBe(false);
    } finally {
      core.sqlite.close();
    }
  });

  it('copies provider templates without overwriting existing profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const profilePath = join(root, 'config', 'providers', 'openai-default.provider.jsonc');

    ensureLayout(root);

    expect(existsSync(profilePath)).toBe(true);

    writeFileSync(profilePath, '{ "id": "custom" }\n');
    ensureLayout(root);

    expect(readFileSync(profilePath, 'utf8')).toBe('{ "id": "custom" }\n');
  });

  it('prepares config templates before storage layout verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    ensureConfigTemplateSurface(root);

    expect(existsSync(join(root, 'config', 'server.jsonc'))).toBe(true);
    expect(existsSync(join(root, 'config', 'providers', 'openai-default.provider.jsonc'))).toBe(
      true
    );
    expect(existsSync(join(root, 'config', 'agents', 'codex.agent.jsonc'))).toBe(true);
    expect(readFileSync(join(root, 'config', 'agents', 'codex.agent.jsonc'), 'utf8')).toContain(
      '"kind": "reference"'
    );
    expect(existsSync(join(root, 'server', 'layout.json'))).toBe(false);
  });

  it('copies missing provider templates without overwriting operator profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const providersRoot = join(root, 'config', 'providers');
    const operatorPath = join(providersRoot, 'operator.provider.jsonc');

    ensureLayout(root);
    writeFileSync(operatorPath, '{ "id": "operator" }\n');
    rmSync(join(providersRoot, 'openrouter-default.provider.jsonc'));
    ensureLayout(root);

    expect(readFileSync(operatorPath, 'utf8')).toBe('{ "id": "operator" }\n');
    expect(existsSync(join(providersRoot, 'openrouter-default.provider.jsonc'))).toBe(true);
    expect(existsSync(join(providersRoot, 'README.md'))).toBe(false);
  });

  it('copies the root config template without overwriting local config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const configPath = join(root, 'config', 'server.jsonc');

    ensureLayout(root);

    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toContain('coreProviderId');
    expect(readFileSync(configPath, 'utf8')).toContain('no default provider');

    writeFileSync(configPath, '{ "mode": "server" }\n');
    ensureLayout(root);

    expect(readFileSync(configPath, 'utf8')).toBe('{ "mode": "server" }\n');
  });

  it('copies agent templates without overwriting existing manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const codexPath = join(root, 'config', 'agents', 'codex.agent.jsonc');
    const opencodePath = join(root, 'config', 'agents', 'opencode-server.agent.jsonc');

    ensureLayout(root);

    expect(existsSync(codexPath)).toBe(true);
    expect(existsSync(opencodePath)).toBe(true);

    writeFileSync(codexPath, '{ "id": "custom" }\n');
    ensureLayout(root);

    expect(readFileSync(codexPath, 'utf8')).toBe('{ "id": "custom" }\n');
  });

  it('does not restore deleted templates once a config directory is populated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));
    const codexPath = join(root, 'config', 'agents', 'codex.agent.jsonc');
    const opencodePath = join(root, 'config', 'agents', 'opencode-server.agent.jsonc');

    ensureLayout(root);

    rmSync(opencodePath);
    ensureLayout(root);

    expect(existsSync(opencodePath)).toBe(false);
    expect(existsSync(codexPath)).toBe(true);
  });
});

describe('resolveDataRootPath', () => {
  it('resolves relative paths below DATA_ROOT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    expect(resolveDataRootPath(root, 'users', 'user_local')).toBe(
      join(root, 'users', 'user_local')
    );
  });

  it('rejects absolute path input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    expect(() => resolveDataRootPath(root, '/etc/passwd')).toThrow(/absolute/);
  });

  it('rejects parent-directory escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkit-layout-'));

    expect(() => resolveDataRootPath(root, 'users', '..', 'outside')).toThrow(/parent/);
    expect(() => resolveDataRootPath(root, 'users/../outside')).toThrow(/parent/);
  });
});

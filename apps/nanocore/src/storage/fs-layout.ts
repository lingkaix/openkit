import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRecordEnvelope } from '@openkit/config-schema';

import { ensureEncryptedFileVaultStoreDirectory } from '../vault/vault-store-directory.js';

const CONFIG_TEMPLATE_SUFFIXES = {
  providers: '.provider.jsonc',
  agents: '.agent.jsonc',
} as const;
const DATA_ROOT_LAYOUT_VERSION = 1;
const DEFAULT_DATA_ROOT_DEPLOYMENT_ID = 'dep_local';
const DATA_ROOT_TEXT_RECORD_EXTENSIONS = new Set([
  '.json',
  '.jsonc',
  '.jsonl',
  '.md',
  '.txt',
  '.yaml',
  '.yml',
]);
const DATA_ROOT_SUPPORTED_CANONICAL_RECORD_TYPES = new Set([
  'data-root-backup',
  'workspace-export',
]);

/**
 * Deterministic local-mode user id for v0.0.2.
 */
export const LOCAL_USER_ID = 'user_local';

/**
 * Paths created by ensureLayout.
 */
export interface FsLayoutPaths {
  /** Data root directory. */
  root: string;
  /** Config directory. */
  config: string;
  /** Provider profile directory. */
  providers: string;
  /** Agent manifest directory. */
  agents: string;
  /** Users root directory. */
  users: string;
  /** Implicit local user directory. */
  localUser: string;
  /** Workspace root for the implicit local user. */
  localUserWorkspaces: string;
  /** Local-mode runtime data directory. */
  local: string;
  /** Server-mode runtime data directory. */
  server: string;
  /** Server-owned file storage directory. */
  serverFiles: string;
  /** Server-owned SQLite directory. */
  serverDb: string;
  /** Server-owned logs directory. */
  serverLogs: string;
  /** Server-owned evidence directory. */
  serverEvidence: string;
  /** Server-owned export directory. */
  serverExports: string;
  /** Server-owned runtime output directory. */
  serverRuntime: string;
  /** Server-owned resolved config snapshot directory. */
  serverRuntimeConfig: string;
  /** Server-owned agent runtime output directory. */
  serverRuntimeAgents: string;
  /** Server-owned runtime session directory. */
  serverRuntimeSessions: string;
  /** Server-owned secret vault directory. */
  serverVault: string;
  /** Server-owned migration artifact directory. */
  serverMigrations: string;
  /** Server-owned vendored metadata directory. */
  serverVendor: string;
  /** Versioned models.dev metadata directory. */
  serverModelsDev: string;
  /** Runtime logs directory. */
  logs: string;
}

/** Version marker stored in the server-owned data-root layout file. */
export interface DataRootLayoutMarker {
  /** Marker schema version. */
  schemaVersion: 1;
  /** DATA_ROOT layout version supported by this build. */
  layoutVersion: 1;
  /** Deployment id used for export and backup lineage. */
  deploymentId: string;
  /** Previous deployment id when this data root was moved to a new deployment. */
  predecessorDeploymentId?: string;
}

/**
 * Paths created for one user subtree.
 */
export interface UserLayoutPaths {
  /** User root directory. */
  root: string;
  /** User-owned file directory. */
  files: string;
  /** User-owned durable data directory. */
  data: string;
  /** User-owned SQLite directory. */
  db: string;
  /** User-owned log directory. */
  logs: string;
  /** User-scoped config directory. */
  config: string;
  /** User workspaces directory. */
  workspaces: string;
}

/**
 * Paths created for one workspace subtree.
 */
export interface WorkspaceLayoutPaths {
  /** Workspace root directory. */
  root: string;
  /** Workspace-owned file directory. */
  files: string;
  /** Workspace-owned durable data directory. */
  data: string;
  /** Workspace-owned SQLite directory. */
  db: string;
  /** Workspace-owned log directory. */
  logs: string;
  /** Workspace NanoCore log directory. */
  logsNanocore: string;
  /** Workspace worker log directory. */
  logsWorker: string;
  /** Workspace-scoped config directory. */
  config: string;
  /** Workspace artifacts directory. */
  artifacts: string;
  /** Workspace knowledge directory. */
  knowledge: string;
  /** Workspace source evidence directory. */
  sources: string;
  /** Workspace threads directory. */
  threads: string;
  /** Workspace runtime output directory. */
  runtime: string;
  /** Workspace agent-session runtime directory. */
  runtimeAgentSessions: string;
  /** Workspace review directory. */
  reviews: string;
  /** Workspace change-review directory. */
  reviewsWorkspace: string;
  /** Workspace artifact-review directory. */
  reviewsArtifacts: string;
  /** Workspace evidence directory. */
  evidence: string;
  /** Workspace evidence bundle directory. */
  evidenceBundles: string;
  /** Workspace backend evidence directory. */
  evidenceBackend: string;
  /** Workspace derived indexes directory. */
  indexes: string;
}

/**
 * Creates the target ownership-scoped data-root directory skeleton.
 *
 * The layout guarantees `config/`, `config/providers/`, `config/agents/`,
 * server-owned runtime directories, target server database ownership, the
 * implicit local user skeleton, `local/`, and `logs/`.
 *
 * @param root Data root directory to initialize.
 * @returns Absolute or relative paths for the created layout.
 */
export function ensureLayout(root: string): FsLayoutPaths {
  const serverRoot = resolveDataRootPath(root, 'server');
  const paths: FsLayoutPaths = {
    root,
    config: resolveDataRootPath(root, 'config'),
    providers: resolveDataRootPath(root, 'config', 'providers'),
    agents: resolveDataRootPath(root, 'config', 'agents'),
    users: resolveDataRootPath(root, 'users'),
    localUser: resolveDataRootPath(root, 'users', LOCAL_USER_ID),
    localUserWorkspaces: resolveDataRootPath(root, 'users', LOCAL_USER_ID, 'workspaces'),
    local: resolveDataRootPath(root, 'local'),
    server: serverRoot,
    serverFiles: join(serverRoot, 'files'),
    serverDb: join(serverRoot, 'db'),
    serverLogs: join(serverRoot, 'logs'),
    serverEvidence: join(serverRoot, 'evidence'),
    serverExports: join(serverRoot, 'exports'),
    serverRuntime: join(serverRoot, 'runtime'),
    serverRuntimeConfig: join(serverRoot, 'runtime', 'config'),
    serverRuntimeAgents: join(serverRoot, 'runtime', 'agents'),
    serverRuntimeSessions: join(serverRoot, 'runtime', 'sessions'),
    serverVault: join(serverRoot, 'vault'),
    serverMigrations: join(serverRoot, 'migrations'),
    serverVendor: join(serverRoot, 'vendor'),
    serverModelsDev: join(serverRoot, 'vendor', 'models.dev'),
    logs: resolveDataRootPath(root, 'logs'),
  };

  ensureLayoutDirectory(paths.root, true);
  for (const path of Object.values(paths).filter(
    (path) => path !== paths.root && path !== paths.serverVault
  )) {
    ensureLayoutDirectory(path);
  }
  ensureEncryptedFileVaultStoreDirectory({ storeDir: paths.serverVault });

  ensureDataRootLayoutMarker(root);
  verifyNoLegacyOwnershipViolations(root);
  verifyCanonicalDatabaseOwnership(root);
  verifyCanonicalRecordEnvelopeSupport(root);
  verifyNoEmbeddedDataRootPaths(root);
  ensureUserLayout(root, LOCAL_USER_ID);
  ensureConfigTemplateSurface(root);

  return paths;
}

/**
 * Creates only the operator-authored config surface and committed templates.
 *
 * @param root Data root directory to prepare for config loading.
 */
export function ensureConfigTemplateSurface(root: string): void {
  const configRoot = resolveDataRootPath(root, 'config');
  const providersRoot = join(configRoot, 'providers');
  const agentsRoot = join(configRoot, 'agents');

  for (const path of [configRoot, providersRoot, agentsRoot]) {
    mkdirSync(path, { recursive: true });
  }

  copyRootConfigTemplate(configRoot);
  copyConfigTemplates(providersRoot, 'providers', true);
  copyConfigTemplates(agentsRoot, 'agents', false);
}

/**
 * Reads the data-root layout marker.
 *
 * @param root Data root directory.
 * @returns Parsed layout marker.
 * @throws Error when the marker is missing, malformed, or unsupported.
 */
export function readDataRootLayoutMarker(root: string): DataRootLayoutMarker {
  const markerPath = dataRootLayoutMarkerPath(root);
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;

  if (
    typeof marker === 'object' &&
    marker !== null &&
    'schemaVersion' in marker &&
    marker.schemaVersion === 1 &&
    'layoutVersion' in marker &&
    marker.layoutVersion === DATA_ROOT_LAYOUT_VERSION &&
    'deploymentId' in marker &&
    typeof marker.deploymentId === 'string' &&
    marker.deploymentId.length > 0 &&
    (!('predecessorDeploymentId' in marker) || typeof marker.predecessorDeploymentId === 'string')
  ) {
    return marker as DataRootLayoutMarker;
  }

  throw new Error(`Unsupported DATA_ROOT layout version in ${markerPath}.`);
}

/**
 * Records a data-root move to a new deployment id.
 *
 * @param root Data root directory.
 * @param deploymentId New deployment id.
 * @returns Updated layout marker.
 * @throws Error when the deployment id is empty or matches the predecessor.
 */
export function recordDataRootDeploymentMove(
  root: string,
  deploymentId: string
): DataRootLayoutMarker {
  if (!deploymentId) {
    throw new Error('DATA_ROOT deployment id must not be empty.');
  }

  const current = readDataRootLayoutMarker(root);
  const predecessorDeploymentId =
    current.deploymentId === deploymentId ? current.predecessorDeploymentId : current.deploymentId;

  if (predecessorDeploymentId === deploymentId) {
    throw new Error('DATA_ROOT predecessor deployment id must differ from deployment id.');
  }

  const marker: DataRootLayoutMarker = {
    schemaVersion: 1,
    layoutVersion: DATA_ROOT_LAYOUT_VERSION,
    deploymentId,
    ...(predecessorDeploymentId ? { predecessorDeploymentId } : {}),
  };

  writeJson(dataRootLayoutMarkerPath(root), marker);
  return marker;
}

/**
 * Creates the canonical subtree for one user.
 *
 * @param root Data root directory.
 * @param userId User id whose subtree should exist.
 * @returns Paths created for the user subtree.
 */
export function ensureUserLayout(root: string, userId: string): UserLayoutPaths {
  const userRoot = resolveDataRootPath(root, 'users', userId);
  const paths: UserLayoutPaths = {
    root: userRoot,
    files: join(userRoot, 'files'),
    data: join(userRoot, 'data'),
    db: join(userRoot, 'db'),
    logs: join(userRoot, 'logs'),
    config: join(userRoot, 'config'),
    workspaces: join(userRoot, 'workspaces'),
  };

  ensureLayoutDirectory(root, true);
  ensureLayoutDirectory(resolveDataRootPath(root, 'users'));
  for (const path of Object.values(paths)) {
    ensureLayoutDirectory(path);
  }

  return paths;
}

/**
 * Creates the canonical subtree for one workspace.
 *
 * @param root Data root directory.
 * @param userId User id that owns the workspace.
 * @param workspaceId Workspace id whose subtree should exist.
 * @returns Paths created for the workspace subtree.
 */
export function ensureWorkspaceLayout(
  root: string,
  userId: string,
  workspaceId: string
): WorkspaceLayoutPaths {
  ensureUserLayout(root, userId);
  return ensureWorkspaceLayoutRoot(
    resolveDataRootPath(root, 'users', userId, 'workspaces', workspaceId)
  );
}

/**
 * Creates the canonical subtree under an already resolved workspace root.
 *
 * @param workspaceRoot Workspace root directory.
 * @returns Paths created for the workspace subtree.
 */
export function ensureWorkspaceLayoutRoot(workspaceRoot: string): WorkspaceLayoutPaths {
  const paths: WorkspaceLayoutPaths = {
    root: workspaceRoot,
    files: join(workspaceRoot, 'files'),
    data: join(workspaceRoot, 'data'),
    db: join(workspaceRoot, 'db'),
    logs: join(workspaceRoot, 'logs'),
    logsNanocore: join(workspaceRoot, 'logs', 'nanocore'),
    logsWorker: join(workspaceRoot, 'logs', 'worker'),
    config: join(workspaceRoot, 'config'),
    artifacts: join(workspaceRoot, 'artifacts'),
    knowledge: join(workspaceRoot, 'knowledge'),
    sources: join(workspaceRoot, 'sources'),
    threads: join(workspaceRoot, 'threads'),
    runtime: join(workspaceRoot, 'runtime'),
    runtimeAgentSessions: join(workspaceRoot, 'runtime', 'agent-sessions'),
    reviews: join(workspaceRoot, 'reviews'),
    reviewsWorkspace: join(workspaceRoot, 'reviews', 'workspace'),
    reviewsArtifacts: join(workspaceRoot, 'reviews', 'artifacts'),
    evidence: join(workspaceRoot, 'evidence'),
    evidenceBundles: join(workspaceRoot, 'evidence', 'bundles'),
    evidenceBackend: join(workspaceRoot, 'evidence', 'backend'),
    indexes: join(workspaceRoot, 'indexes'),
  };

  ensureLayoutDirectory(paths.root, true);
  for (const path of Object.values(paths).slice(1)) {
    ensureLayoutDirectory(path);
  }

  return paths;
}

/**
 * Resolves the server-scope Core SQLite file path.
 *
 * @param root Data root directory.
 * @returns Absolute path to the server-owned Core SQLite file.
 */
export function coreDbPath(root: string): string {
  return join(resolveDataRootPath(root, 'server', 'db'), 'core.sqlite');
}

/**
 * Resolves one user-scope SQLite file path.
 *
 * @param root Data root directory.
 * @param userId User id that owns the database.
 * @returns Absolute path to the user-owned SQLite file.
 */
export function userDbPath(root: string, userId: string): string {
  return join(resolveDataRootPath(root, 'users', userId, 'db'), 'user.sqlite');
}

/**
 * Resolves one workspace-scope SQLite file path.
 *
 * @param root Data root directory.
 * @param userId User id that owns the workspace.
 * @param workspaceId Workspace id that owns the database.
 * @returns Absolute path to the workspace-owned SQLite file.
 */
export function workspaceDbPath(root: string, userId: string, workspaceId: string): string {
  return join(
    resolveDataRootPath(root, 'users', userId, 'workspaces', workspaceId, 'db'),
    'workspace.sqlite'
  );
}

/**
 * Returns the server-owned data-root layout marker path.
 *
 * @param root Data root directory.
 * @returns Marker file path.
 */
function dataRootLayoutMarkerPath(root: string): string {
  return join(resolveDataRootPath(root, 'server'), 'layout.json');
}

/**
 * Creates or verifies the data-root layout marker.
 *
 * @param root Data root directory.
 */
function ensureDataRootLayoutMarker(root: string): void {
  const markerPath = dataRootLayoutMarkerPath(root);

  if (!existsSync(markerPath)) {
    writeJson(markerPath, {
      schemaVersion: 1,
      layoutVersion: DATA_ROOT_LAYOUT_VERSION,
      deploymentId: DEFAULT_DATA_ROOT_DEPLOYMENT_ID,
    });
    return;
  }

  const rawMarker = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;

  if (
    typeof rawMarker === 'object' &&
    rawMarker !== null &&
    'schemaVersion' in rawMarker &&
    rawMarker.schemaVersion === 1 &&
    'layoutVersion' in rawMarker &&
    rawMarker.layoutVersion === DATA_ROOT_LAYOUT_VERSION &&
    !('deploymentId' in rawMarker)
  ) {
    writeJson(markerPath, {
      schemaVersion: 1,
      layoutVersion: DATA_ROOT_LAYOUT_VERSION,
      deploymentId: DEFAULT_DATA_ROOT_DEPLOYMENT_ID,
    });
    return;
  }

  readDataRootLayoutMarker(root);
}

/**
 * Writes one JSON file with a trailing newline.
 *
 * @param path Target file path.
 * @param value JSON-serializable value.
 */
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Fails closed on legacy paths that violate the ownership-scoped baseline.
 *
 * @param root Data root directory.
 * @throws Error when a known legacy ownership path is present.
 */
function verifyNoLegacyOwnershipViolations(root: string): void {
  const rootCoreDb = resolveDataRootPath(root, 'core.sqlite');

  if (existsSync(rootCoreDb)) {
    throw new Error(`Unsupported legacy root core database: ${rootCoreDb}`);
  }

  const usersRoot = resolveDataRootPath(root, 'users');
  if (!existsSync(usersRoot)) {
    return;
  }

  for (const userId of listChildDirectories(usersRoot)) {
    const workspacesRoot = resolveDataRootPath(root, 'users', userId, 'workspaces');

    for (const workspaceId of listChildDirectories(workspacesRoot)) {
      const legacyStoreSnapshot = join(workspacesRoot, workspaceId, 'store.json');

      if (existsSync(legacyStoreSnapshot)) {
        throw new Error(`Unsupported legacy workspace store snapshot: ${legacyStoreSnapshot}`);
      }

      const legacyMemory = resolveDataRootPath(
        root,
        'users',
        userId,
        'workspaces',
        workspaceId,
        'memory'
      );

      if (existsSync(legacyMemory)) {
        throw new Error(`Unsupported legacy workspace memory directory: ${legacyMemory}`);
      }
    }
  }
}

/**
 * Fails closed when canonical SQLite filenames appear outside their owner scope.
 *
 * @param root Data root directory.
 * @throws Error when a canonical database file is found in the wrong scope.
 */
function verifyCanonicalDatabaseOwnership(root: string): void {
  for (const path of listDescendantFiles(root)) {
    const reportPath = toDataRootReportPath(root, path);

    if (path.endsWith(`${sep}core.sqlite`) && reportPath !== 'server/db/core.sqlite') {
      throw new Error(`DATA_ROOT database ownership violation: ${reportPath}`);
    }

    if (
      path.endsWith(`${sep}user.sqlite`) &&
      !/^users\/[^/]+\/db\/user\.sqlite$/.test(reportPath)
    ) {
      throw new Error(`DATA_ROOT database ownership violation: ${reportPath}`);
    }

    if (
      path.endsWith(`${sep}workspace.sqlite`) &&
      !/^users\/[^/]+\/workspaces\/[^/]+\/db\/workspace\.sqlite$/.test(reportPath)
    ) {
      throw new Error(`DATA_ROOT database ownership violation: ${reportPath}`);
    }
  }
}

/**
 * Fails closed when canonical record envelopes require unsupported reader behavior.
 *
 * @param root Data root directory.
 * @throws Error when a canonical envelope uses an unknown family or unsupported feature.
 */
function verifyCanonicalRecordEnvelopeSupport(root: string): void {
  for (const path of listDescendantFiles(root)) {
    const reportPath = toDataRootReportPath(root, path);

    if (!reportPath.endsWith('.json')) {
      continue;
    }

    const record = readJsonRecord(path);
    if (!isRecordEnvelopeCandidate(record)) {
      continue;
    }

    let envelope: ReturnType<typeof parseRecordEnvelope>;
    try {
      envelope = parseRecordEnvelope(record);
    } catch (error) {
      throw new Error(
        `DATA_ROOT unsupported requiredFeatures in ${reportPath}: ${errorMessage(error)}`
      );
    }

    if (!DATA_ROOT_SUPPORTED_CANONICAL_RECORD_TYPES.has(envelope.recordType)) {
      throw new Error(
        `DATA_ROOT unsupported canonical record family in ${reportPath}: ${envelope.recordType}`
      );
    }
  }
}

/**
 * Reads a JSON record from disk.
 *
 * @param path JSON file path.
 * @returns Parsed JSON value, or null when the file is not valid JSON.
 */
function readJsonRecord(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Checks whether a parsed JSON value has the common canonical envelope shape.
 *
 * @param value Parsed JSON value.
 * @returns True when the value should be handled as a canonical record envelope.
 */
function isRecordEnvelopeCandidate(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    'recordType' in value &&
    'id' in value &&
    'ownerScope' in value &&
    'lineage' in value &&
    'requiredFeatures' in value
  );
}

/**
 * Returns a readable error message.
 *
 * @param error Unknown thrown value.
 * @returns Error message string.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fails closed when file-backed text records embed the current absolute DATA_ROOT path.
 *
 * @param root Data root directory.
 * @throws Error when a text record contains an absolute DATA_ROOT path.
 */
function verifyNoEmbeddedDataRootPaths(root: string): void {
  const dataRoot = resolve(root);

  for (const path of listDescendantFiles(root)) {
    const reportPath = toDataRootReportPath(root, path);

    if (!isTextRecordPath(reportPath)) {
      continue;
    }

    if (readFileSync(path, 'utf8').includes(dataRoot)) {
      throw new Error(`DATA_ROOT text record embeds absolute DATA_ROOT path: ${reportPath}`);
    }
  }
}

/**
 * Returns whether a data-root report path is a text record checked during migration validation.
 *
 * @param path Slash-separated path relative to DATA_ROOT.
 * @returns True when the path is a text record.
 */
function isTextRecordPath(path: string): boolean {
  const fileName = path.split('/').at(-1) ?? '';
  const extensionStart = fileName.lastIndexOf('.');

  if (extensionStart < 0) {
    return false;
  }

  return DATA_ROOT_TEXT_RECORD_EXTENSIONS.has(fileName.slice(extensionStart));
}

/**
 * Creates one layout directory without following an existing link.
 *
 * @param path Directory path to create or verify.
 * @param recursive Whether missing ancestors may be created for the boundary root.
 * @throws Error when the existing path is a symbolic link or non-directory.
 */
function ensureLayoutDirectory(path: string, recursive: boolean = false): void {
  const metadata = lstatSync(path, { throwIfNoEntry: false });

  if (!metadata) {
    mkdirSync(path, { recursive });
    assertLayoutDirectory(path);
    return;
  }

  assertLayoutDirectory(path);
}

/**
 * Verifies one existing layout directory without following links.
 *
 * @param path Directory path to verify.
 * @throws Error when the path is missing, a symbolic link, or a non-directory.
 */
function assertLayoutDirectory(path: string): void {
  const metadata = lstatSync(path, { throwIfNoEntry: false });

  if (!metadata) {
    throw new Error(`DATA_ROOT layout directory is missing: ${path}`);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`DATA_ROOT layout directory must not be a symbolic link: ${path}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`DATA_ROOT layout path must be a directory: ${path}`);
  }
}

/**
 * Reads one layout directory without following a linked parent.
 *
 * @param path Directory path to read.
 * @returns Direct child entries, or an empty list when the path is absent.
 * @throws Error when the existing path is a symbolic link or non-directory.
 */
function readLayoutDirectory(path: string) {
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    return [];
  }

  assertLayoutDirectory(path);
  return readdirSync(path, { withFileTypes: true });
}

/**
 * Lists direct child directory names in stable order.
 *
 * @param path Parent path.
 * @returns Child directory names.
 */
function listChildDirectories(path: string): string[] {
  const directories: string[] = [];

  for (const entry of readLayoutDirectory(path)) {
    const entryPath = join(path, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`DATA_ROOT layout must not contain a symbolic link: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      directories.push(entry.name);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`DATA_ROOT layout contains an unsupported entry: ${entryPath}`);
    }
  }

  return directories.sort();
}

/**
 * Lists descendant file paths in stable order.
 *
 * @param path Root path to scan.
 * @returns Descendant file paths.
 */
function listDescendantFiles(path: string): string[] {
  const files: string[] = [];

  for (const entry of readLayoutDirectory(path).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const childPath = join(path, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`DATA_ROOT layout must not contain a symbolic link: ${childPath}`);
    }
    if (entry.isDirectory()) {
      files.push(...listDescendantFiles(childPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(childPath);
      continue;
    }

    throw new Error(`DATA_ROOT layout contains an unsupported entry: ${childPath}`);
  }

  return files;
}

/**
 * Converts a DATA_ROOT path to a stable slash-separated report path.
 *
 * @param root Data root directory.
 * @param path Path below DATA_ROOT.
 * @returns Slash-separated relative path.
 */
function toDataRootReportPath(root: string, path: string): string {
  return relative(resolve(root), path).split(sep).join('/');
}

/**
 * Resolves a path under DATA_ROOT and rejects path escapes.
 *
 * @param root Data root directory.
 * @param segments Relative path segments to resolve under DATA_ROOT.
 * @returns Absolute resolved path below DATA_ROOT.
 * @throws Error when a segment is absolute or contains a parent-directory escape.
 */
export function resolveDataRootPath(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (isAbsolute(segment)) {
      throw new Error(`DATA_ROOT path segment must be relative, not absolute: ${segment}`);
    }

    if (segment.split(/[\\/]+/).includes('..')) {
      throw new Error(
        `DATA_ROOT path segment must not contain parent-directory escapes: ${segment}`
      );
    }
  }

  const dataRoot = resolve(root);
  const resolved = resolve(dataRoot, ...segments);
  const relativePath = relative(dataRoot, resolved);

  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return resolved;
  }

  throw new Error(`Resolved path escapes DATA_ROOT: ${segments.join('/')}`);
}

/**
 * Copies the root server.jsonc template into the data root when missing.
 *
 * @param configRoot Config directory under the data root.
 */
function copyRootConfigTemplate(configRoot: string): void {
  const sourcePath = findConfigTemplateFile('server.jsonc');
  const targetPath = join(configRoot, 'server.jsonc');

  if (!sourcePath || existsSync(targetPath)) {
    return;
  }

  copyFileSync(sourcePath, targetPath);
}

/**
 * Copies committed config templates into the data root when missing.
 *
 * @param targetRoot Config directory under the data root.
 * @param templateKind Config template kind.
 * @param copyMissingTemplates Whether to copy missing templates into populated directories.
 */
function copyConfigTemplates(
  targetRoot: string,
  templateKind: 'providers' | 'agents',
  copyMissingTemplates: boolean
): void {
  const templateRoot = findConfigTemplateRoot(templateKind);

  if (!templateRoot || (!copyMissingTemplates && readdirSync(targetRoot).length > 0)) {
    return;
  }

  for (const fileName of readdirSync(templateRoot).sort()) {
    if (!fileName.endsWith(CONFIG_TEMPLATE_SUFFIXES[templateKind])) {
      continue;
    }

    const sourcePath = join(templateRoot, fileName);
    const targetPath = join(targetRoot, fileName);

    if (!statSync(sourcePath).isFile() || existsSync(targetPath)) {
      continue;
    }

    copyFileSync(sourcePath, targetPath);
  }
}

/**
 * Finds a committed config template directory from source or built runtime paths.
 *
 * @param templateKind Config template kind.
 * @returns Template directory path when found.
 */
function findConfigTemplateRoot(templateKind: 'providers' | 'agents'): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'apps', 'nanocore', 'data-templates', 'config', templateKind),
    join(process.cwd(), 'data-templates', 'config', templateKind),
    join(here, '..', '..', 'data-templates', 'config', templateKind),
    join(here, '..', 'data-templates', 'config', templateKind),
  ];

  return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * Finds a committed config template file from source or built runtime paths.
 *
 * @param fileName Config template file name.
 * @returns Template file path when found.
 */
function findConfigTemplateFile(fileName: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'apps', 'nanocore', 'data-templates', 'config', fileName),
    join(process.cwd(), 'data-templates', 'config', fileName),
    join(here, '..', '..', 'data-templates', 'config', fileName),
    join(here, '..', 'data-templates', 'config', fileName),
  ];

  return candidates.find((path) => existsSync(path)) ?? null;
}

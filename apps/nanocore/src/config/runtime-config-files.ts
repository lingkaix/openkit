import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  type RuntimeConfigFileDiagnostic,
  type RuntimeConfigFileKind,
  type RuntimeConfigFileListResponse,
  RuntimeConfigFileListResponseSchema,
  type RuntimeConfigFileReadResponse,
  RuntimeConfigFileReadResponseSchema,
  type RuntimeConfigFileSummary,
  type RuntimeConfigFileWriteResponse,
  RuntimeConfigFileWriteResponseSchema,
  type RuntimeConfigReloadPlan,
  RuntimeConfigReloadPlanSchema,
  type RuntimeConfigSchemaCatalogResponse,
  RuntimeConfigSchemaCatalogResponseSchema,
  type RuntimeConfigStatus,
  type RuntimeConfigValidationRequest,
  type RuntimeConfigValidationResponse,
  RuntimeConfigValidationResponseSchema,
} from '@openkit/app-api-schemas';
import {
  GatewayConfigSchema,
  getConfigSchemaCatalog,
  InternalRoleProfilesConfigSchema,
  OpenKitConfigSchema,
  ProviderProfileSchema,
  UserConfigSchema,
  WorkspaceConfigSchema,
  type WorkspaceDataSource,
  type WorkspaceDataSourceCatalog,
  WorkspaceDataSourceCatalogSchema,
  type WorkspaceMcpServer,
  type WorkspaceMcpServerCatalog,
  WorkspaceMcpServerCatalogSchema,
} from '@openkit/config-schema';
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import { z } from 'zod';
import { AuthoredAgentConfigSchema } from '../agents/manifest.js';
import {
  diffRuntimeConfig,
  loadRuntimeConfig,
  type RuntimeConfigManager,
} from './runtime-config.js';

const CONFIG_ROOT = 'config';
const VALID_FILE_NAME = /^[A-Za-z0-9._-]+$/;
const DATA_SOURCE_AUTHORITY_FIELDS = ['kind', 'access', 'sensitivity', 'vaultGrantRef'] as const;
const MCP_SERVER_AUTHORITY_FIELDS = [
  'enabled',
  'transport',
  'credentialBindings',
  'allowedTools',
  'deniedTools',
  'approvalRequiredTools',
  'timeoutMs',
  'schemaPolicy',
  'pinnedSchemaSnapshotId',
] as const;

/** Authority-bearing data source catalog change emitted after a successful file write. */
export interface RuntimeConfigDataSourceAuthorityChange {
  /** Workspace that owns the catalog file. */
  workspaceId: string;
  /** Source id whose authority fields changed. */
  sourceId: string;
  /** Authority-bearing fields that changed. */
  fields: string[];
}

/** Authority-bearing MCP server catalog change emitted after a successful file write. */
export interface RuntimeConfigMcpServerAuthorityChange {
  /** Workspace that owns the catalog file. */
  workspaceId: string;
  /** MCP server id whose authority fields changed. */
  serverId: string;
  /** Authority-bearing fields that changed. */
  fields: string[];
}

/**
 * Runtime config file service construction input.
 */
export interface RuntimeConfigFileServiceOptions {
  /** Data root that owns DATA_ROOT/config. */
  dataRoot: string | null;
  /** Workspace ids authorized for the current request. */
  workspaceIds: string[];
  /** User id that owns the personal preference file exposed by this service. */
  userId: string;
  /** Runtime config manager used for current snapshot and status reads. */
  runtimeConfigManager: RuntimeConfigManager;
  /** Reads stale-session-aware runtime config status for API responses. */
  readRuntimeConfigStatus: () => RuntimeConfigStatus;
  /** Optional hook for durable audit of authority-bearing catalog edits. */
  onDataSourceAuthorityChange?: (change: RuntimeConfigDataSourceAuthorityChange) => void;
  /** Optional hook for durable audit of authority-bearing MCP catalog edits. */
  onMcpServerAuthorityChange?: (change: RuntimeConfigMcpServerAuthorityChange) => void;
}

/**
 * Runtime config file write input used by routes and tests.
 */
export interface RuntimeConfigFileWriteInput {
  /** Runtime config file id, such as server.jsonc. */
  id: string;
  /** Runtime config file kind. */
  kind: RuntimeConfigFileKind;
  /** New source content, or omitted to create from a template. */
  content?: string | undefined;
  /** Current revision expected by the caller. */
  expectedRevision?: string | null | undefined;
}

/**
 * Runtime config API error with an HTTP status code.
 */
export class RuntimeConfigFileServiceError extends Error {
  /** Stable API error code. */
  public readonly code: string;
  /** HTTP status to return. */
  public readonly status: number;

  /**
   * Creates a service error.
   *
   * @param code Stable API error code.
   * @param message Human-readable message.
   * @param status HTTP status.
   */
  public constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Service for safe runtime config file reads, writes, validation, and schema catalog access.
 */
export class RuntimeConfigFileService {
  private readonly dataRoot: string;
  private readonly workspaceIds: string[];
  private readonly userId: string;
  private readonly runtimeConfigManager: RuntimeConfigManager;
  private readonly readRuntimeConfigStatus: () => RuntimeConfigStatus;
  private readonly onDataSourceAuthorityChange:
    | ((change: RuntimeConfigDataSourceAuthorityChange) => void)
    | undefined;
  private readonly onMcpServerAuthorityChange:
    | ((change: RuntimeConfigMcpServerAuthorityChange) => void)
    | undefined;

  /**
   * Creates a runtime config file service.
   *
   * @param options Service dependencies.
   */
  public constructor(options: RuntimeConfigFileServiceOptions) {
    if (!options.dataRoot) {
      throw new RuntimeConfigFileServiceError(
        'config_data_root_required',
        'Runtime config file management requires a data root.',
        400
      );
    }

    this.dataRoot = options.dataRoot;
    this.workspaceIds = options.workspaceIds;
    this.userId = options.userId;
    this.runtimeConfigManager = options.runtimeConfigManager;
    this.readRuntimeConfigStatus = options.readRuntimeConfigStatus;
    this.onDataSourceAuthorityChange = options.onDataSourceAuthorityChange;
    this.onMcpServerAuthorityChange = options.onMcpServerAuthorityChange;
  }

  /**
   * Lists supported runtime config files that exist on disk.
   *
   * @returns Runtime config file list response.
   */
  public listFiles(): RuntimeConfigFileListResponse {
    const files = [
      this.summaryForSpec(this.resolveFileSpec('server.jsonc')),
      this.summaryForSpec(this.resolveFileSpec('gateway.jsonc')),
      this.summaryForSpec(this.resolveFileSpec('internal-role-profiles.jsonc')),
      ...this.listDirectoryFiles('providers', '.provider.jsonc', 'provider'),
      ...this.listDirectoryFiles('agents', '.agent.jsonc', 'agent'),
      this.summaryForSpec(this.resolveFileSpec(`users/${this.userId}/user.jsonc`)),
      ...this.listWorkspaceFiles(),
    ].filter((file) => file.exists);

    return RuntimeConfigFileListResponseSchema.parse({ files });
  }

  /**
   * Reads one supported runtime config file.
   *
   * @param id Runtime config file id.
   * @returns Runtime config file content response.
   */
  public readFile(id: string): RuntimeConfigFileReadResponse {
    const spec = this.resolveFileSpec(id);

    if (!existsSync(spec.absolutePath)) {
      throw new RuntimeConfigFileServiceError('config_file_not_found', `${id} was not found.`, 404);
    }

    if (isWorkspaceScopedKind(spec.kind)) {
      this.assertInsideWorkspaceConfigRoot(spec.workspaceId ?? '', spec.absolutePath);
    } else if (spec.kind === 'user') {
      this.assertInsideUserConfigRoot(spec.userId ?? '', spec.absolutePath);
    } else {
      this.assertInsideConfigRoot(spec.absolutePath);
    }

    return RuntimeConfigFileReadResponseSchema.parse({
      file: this.summaryForSpec(spec),
      content: readFileSync(spec.absolutePath, 'utf8'),
    });
  }

  /**
   * Creates one supported runtime config file.
   *
   * @param input Create request.
   * @returns Write response with the created file summary.
   */
  public createFile(input: RuntimeConfigFileWriteInput): RuntimeConfigFileWriteResponse {
    const spec = this.resolveFileSpec(input.id, input.kind);

    if (spec.kind === 'server') {
      throw new RuntimeConfigFileServiceError(
        'config_file_create_unsupported',
        'server.jsonc cannot be created through this endpoint.',
        400
      );
    }

    if (isWorkspaceScopedKind(spec.kind) && !this.workspaceIds.includes(spec.workspaceId ?? '')) {
      throw new RuntimeConfigFileServiceError(
        'config_file_create_unsupported',
        `${input.id} is not an addressable workspace config file.`,
        400
      );
    }

    if (existsSync(spec.absolutePath)) {
      throw new RuntimeConfigFileServiceError(
        'config_file_exists',
        `${input.id} already exists.`,
        409
      );
    }

    const content = input.content ?? this.templateForSpec(spec);
    const diagnostics = this.validateSingleFile(spec, content);

    if (hasBlockingDiagnostics(diagnostics)) {
      throw invalidConfigContentError(diagnostics);
    }

    this.writeFileAtomically(spec, content);
    this.auditCatalogAuthorityChanges(spec, null, content);

    return RuntimeConfigFileWriteResponseSchema.parse({
      file: this.summaryForSpec(spec),
      diagnostics,
    });
  }

  /**
   * Updates one supported runtime config file using optimistic revision checking.
   *
   * @param input Update request.
   * @returns Write response with the updated file summary.
   */
  public updateFile(input: RuntimeConfigFileWriteInput): RuntimeConfigFileWriteResponse {
    if (input.content === undefined) {
      throw new RuntimeConfigFileServiceError(
        'config_file_content_required',
        'Runtime config file updates require content.',
        400
      );
    }

    const spec = this.resolveFileSpec(input.id, input.kind);
    const diagnostics = this.validateSingleFile(spec, input.content);

    if (hasBlockingDiagnostics(diagnostics)) {
      throw invalidConfigContentError(diagnostics);
    }

    const currentRevision = existsSync(spec.absolutePath)
      ? this.summaryForSpec(spec).revision
      : null;

    if (input.expectedRevision !== currentRevision) {
      throw new RuntimeConfigFileServiceError(
        'config_revision_conflict',
        `Runtime config file ${input.id} changed on disk.`,
        409
      );
    }

    const currentContent = existsSync(spec.absolutePath)
      ? readFileSync(spec.absolutePath, 'utf8')
      : null;

    this.writeFileAtomically(spec, input.content);
    this.auditCatalogAuthorityChanges(spec, currentContent, input.content);

    return RuntimeConfigFileWriteResponseSchema.parse({
      file: this.summaryForSpec(spec),
      diagnostics,
    });
  }

  /**
   * Validates runtime config draft files without mutating the real data root.
   *
   * @param input Validation request.
   * @returns Validation response with diagnostics and dry-run plan.
   */
  public validate(input: RuntimeConfigValidationRequest): RuntimeConfigValidationResponse {
    const singleFileDiagnostics = input.files.flatMap((file) => {
      const spec = this.resolveFileSpec(file.id);
      return this.validateSingleFile(spec, file.content);
    });

    if (hasBlockingDiagnostics(singleFileDiagnostics)) {
      return RuntimeConfigValidationResponseSchema.parse({
        valid: false,
        diagnostics: singleFileDiagnostics,
        runtimeConfig: this.readRuntimeConfigStatus(),
        plan: emptyValidationPlan(this.runtimeConfigManager.current().version),
      });
    }

    const tempRoot = this.createOverlayDataRoot(input);

    try {
      const next = loadRuntimeConfig(tempRoot, {
        version: this.runtimeConfigManager.current().version + 1,
      });
      const plan = diffRuntimeConfig(this.runtimeConfigManager.current(), next);
      const runtimeDiagnostics = next.diagnostics.map((diagnostic) =>
        runtimeDiagnosticToFileDiagnostic(diagnostic)
      );

      return RuntimeConfigValidationResponseSchema.parse({
        valid: !hasBlockingDiagnostics(runtimeDiagnostics),
        diagnostics: [...singleFileDiagnostics, ...runtimeDiagnostics],
        runtimeConfig: this.readRuntimeConfigStatus(),
        plan,
      });
    } catch (error) {
      return RuntimeConfigValidationResponseSchema.parse({
        valid: false,
        diagnostics: [
          ...singleFileDiagnostics,
          {
            fileId: 'server.jsonc',
            severity: 'error',
            code: 'runtime_config.invalid',
            message: (error as Error).message,
            source: 'server.jsonc',
            jsonPath: null,
            range: null,
          },
        ],
        runtimeConfig: this.readRuntimeConfigStatus(),
        plan: rejectedValidationPlan(this.runtimeConfigManager.current().version, error),
      });
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  }

  /**
   * Returns JSON Schema catalog entries for editor assistance.
   *
   * @returns Runtime config schema catalog.
   */
  public schemaCatalog(): RuntimeConfigSchemaCatalogResponse {
    return RuntimeConfigSchemaCatalogResponseSchema.parse({
      schemas: [
        ...getConfigSchemaCatalog().filter((entry) =>
          [
            'server',
            'gateway',
            'internal-role',
            'provider',
            'agent',
            'workspace',
            'data-source',
            'mcp-server',
            'user',
          ].includes(entry.kind)
        ),
      ],
    });
  }

  /**
   * Lists workspace-scoped config files addressable by the current user.
   *
   * @returns Existing workspace config file summaries.
   */
  private listWorkspaceFiles(): RuntimeConfigFileSummary[] {
    return this.workspaceIds
      .flatMap((workspaceId) => [
        this.summaryForSpec(this.resolveFileSpec(`workspaces/${workspaceId}/workspace.jsonc`)),
        this.summaryForSpec(this.resolveFileSpec(`workspaces/${workspaceId}/data-sources.jsonc`)),
        this.summaryForSpec(this.resolveFileSpec(`workspaces/${workspaceId}/mcp-servers.jsonc`)),
      ])
      .filter((file) => file.exists);
  }

  /**
   * Lists config files in one supported subdirectory.
   *
   * @param directory Directory below DATA_ROOT/config.
   * @param suffix Required file suffix.
   * @param kind Runtime config file kind.
   * @returns Existing file summaries.
   */
  private listDirectoryFiles(
    directory: 'providers' | 'agents',
    suffix: string,
    kind: RuntimeConfigFileKind
  ): RuntimeConfigFileSummary[] {
    const absoluteDirectory = join(this.configRoot(), directory);

    if (!existsSync(absoluteDirectory)) {
      return [];
    }

    return readdirSync(absoluteDirectory)
      .filter((fileName) => fileName.endsWith(suffix))
      .sort()
      .map((fileName) =>
        this.summaryForSpec(this.resolveFileSpec(`${directory}/${fileName}`, kind))
      );
  }

  /**
   * Resolves and validates one config file id.
   *
   * @param id Runtime config file id.
   * @param expectedKind Optional expected kind.
   * @returns Resolved file spec.
   */
  private resolveFileSpec(id: string, expectedKind?: RuntimeConfigFileKind): RuntimeConfigFileSpec {
    const spec = parseFileId(id);

    if (expectedKind && spec.kind !== expectedKind) {
      throw new RuntimeConfigFileServiceError(
        'config_file_kind_mismatch',
        `${id} is not a ${expectedKind} config file.`,
        400
      );
    }

    const absolutePath = isWorkspaceScopedKind(spec.kind)
      ? this.workspaceConfigPath(spec.workspaceId ?? '', spec.kind)
      : spec.kind === 'user'
        ? this.userConfigPath(spec.userId ?? '')
        : resolve(this.configRoot(), spec.relativePath);

    if (isWorkspaceScopedKind(spec.kind)) {
      if (!this.workspaceIds.includes(spec.workspaceId ?? '')) {
        throw invalidPathError(id);
      }
      this.assertInsideWorkspaceConfigRoot(spec.workspaceId ?? '', absolutePath, true);
    } else if (spec.kind === 'user') {
      if (spec.userId !== this.userId) {
        throw invalidPathError(id);
      }
      this.assertInsideUserConfigRoot(spec.userId ?? '', absolutePath, true);
    } else {
      this.assertInsideConfigRoot(absolutePath, true);
    }

    return {
      ...spec,
      absolutePath,
    };
  }

  /**
   * Returns a summary for one resolved file spec.
   *
   * @param spec Resolved file spec.
   * @returns Runtime config file summary.
   */
  private summaryForSpec(spec: RuntimeConfigFileSpec): RuntimeConfigFileSummary {
    const exists = existsSync(spec.absolutePath);
    const stat = exists ? statSync(spec.absolutePath) : null;

    return {
      id: spec.relativePath,
      kind: spec.kind,
      path: spec.relativePath,
      exists,
      revision: exists ? contentRevision(readFileSync(spec.absolutePath, 'utf8')) : null,
      updatedAt: stat ? stat.mtime.toISOString() : null,
    };
  }

  /**
   * Validates one JSONC source document against the schema for its file kind.
   *
   * @param spec Resolved file spec.
   * @param content Source content.
   * @returns File diagnostics.
   */
  private validateSingleFile(
    spec: RuntimeConfigFileSpec,
    content: string
  ): RuntimeConfigFileDiagnostic[] {
    const errors: ParseError[] = [];
    const parsed = parse(content, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    }) as unknown;

    if (errors.length > 0) {
      return errors.map((error) => parseErrorDiagnostic(spec, content, error));
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [
        {
          fileId: spec.relativePath,
          severity: 'error',
          code: 'invalid_jsonc_object',
          message: 'Runtime config files must contain a JSON object.',
          source: spec.relativePath,
          jsonPath: '$',
          range: null,
        },
      ];
    }

    const schema = schemaForKind(spec.kind);
    const result = schema.safeParse(parsed);

    if (result.success) {
      return [];
    }

    return [
      {
        fileId: spec.relativePath,
        severity: 'error',
        code: `invalid_${spec.kind}_config`,
        message: z.prettifyError(result.error),
        source: spec.relativePath,
        jsonPath: '$',
        range: null,
      },
    ];
  }

  /**
   * Creates a temporary data root containing current config files plus draft overlays.
   *
   * @param input Validation request.
   * @returns Temporary data root path.
   */
  private createOverlayDataRoot(input: RuntimeConfigValidationRequest): string {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openkit-config-overlay-'));
    const sourceConfigRoot = this.configRoot();
    const tempConfigRoot = join(tempRoot, CONFIG_ROOT);

    if (existsSync(sourceConfigRoot)) {
      cpSync(sourceConfigRoot, tempConfigRoot, { recursive: true });
    } else {
      mkdirSync(tempConfigRoot, { recursive: true });
    }

    for (const workspaceId of this.workspaceIds) {
      const sourcePath = this.workspaceConfigPath(workspaceId, 'workspace');

      if (existsSync(sourcePath)) {
        const targetPath = join(tempRoot, 'workspaces', workspaceId, 'config', 'workspace.jsonc');
        mkdirSync(dirname(targetPath), { recursive: true });
        cpSync(sourcePath, targetPath);
      }

      const catalogSourcePath = this.workspaceConfigPath(workspaceId, 'data-source');

      if (existsSync(catalogSourcePath)) {
        const targetPath = join(
          tempRoot,
          'workspaces',
          workspaceId,
          'config',
          'data-sources.jsonc'
        );
        mkdirSync(dirname(targetPath), { recursive: true });
        cpSync(catalogSourcePath, targetPath);
      }

      const mcpCatalogSourcePath = this.workspaceConfigPath(workspaceId, 'mcp-server');

      if (existsSync(mcpCatalogSourcePath)) {
        const targetPath = join(tempRoot, 'workspaces', workspaceId, 'config', 'mcp-servers.jsonc');
        mkdirSync(dirname(targetPath), { recursive: true });
        cpSync(mcpCatalogSourcePath, targetPath);
      }
    }

    const sourceUserConfigPath = this.userConfigPath(this.userId);
    if (existsSync(sourceUserConfigPath)) {
      const targetPath = join(tempRoot, 'users', this.userId, 'config', 'user.jsonc');
      mkdirSync(dirname(targetPath), { recursive: true });
      cpSync(sourceUserConfigPath, targetPath);
    }

    for (const file of input.files) {
      const spec = parseFileId(file.id);
      const targetPath = isWorkspaceScopedKind(spec.kind)
        ? join(
            tempRoot,
            'workspaces',
            spec.workspaceId ?? '',
            'config',
            spec.kind === 'data-source'
              ? 'data-sources.jsonc'
              : spec.kind === 'mcp-server'
                ? 'mcp-servers.jsonc'
                : 'workspace.jsonc'
          )
        : spec.kind === 'user'
          ? join(tempRoot, 'users', spec.userId ?? '', 'config', 'user.jsonc')
          : join(tempConfigRoot, spec.relativePath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, file.content);
    }

    return tempRoot;
  }

  /**
   * Writes content to a file through a same-directory temporary file.
   *
   * Existing regular targets keep `mode & 0o777` on the replacement; nonexistent targets keep the writer default.
   *
   * @param spec Resolved file spec.
   * @param content Source content to write.
   */
  private writeFileAtomically(spec: RuntimeConfigFileSpec, content: string): void {
    mkdirSync(dirname(spec.absolutePath), { recursive: true });
    if (isWorkspaceScopedKind(spec.kind)) {
      this.assertInsideWorkspaceConfigRoot(
        spec.workspaceId ?? '',
        dirname(spec.absolutePath),
        true
      );
    } else if (spec.kind === 'user') {
      this.assertInsideUserConfigRoot(spec.userId ?? '', dirname(spec.absolutePath), true);
    } else {
      this.assertInsideConfigRoot(dirname(spec.absolutePath), true);
    }
    let preservedMode: number | undefined;
    if (existsSync(spec.absolutePath)) {
      const current = lstatSync(spec.absolutePath);
      if (current.isFile()) {
        preservedMode = current.mode & 0o777;
      }
    }
    const tempPath = join(
      dirname(spec.absolutePath),
      `.${basename(spec.absolutePath)}.${Date.now()}.tmp`
    );
    writeFileSync(tempPath, content);
    if (preservedMode !== undefined) {
      chmodSync(tempPath, preservedMode);
    }
    renameSync(tempPath, spec.absolutePath);
  }

  /**
   * Emits audit hooks for authority-bearing data source catalog edits.
   *
   * @param spec Written runtime config file spec.
   * @param previousContent Previous file content, or null when creating.
   * @param nextContent Written file content.
   */
  private auditCatalogAuthorityChanges(
    spec: RuntimeConfigFileSpec,
    previousContent: string | null,
    nextContent: string
  ): void {
    if (!spec.workspaceId) {
      return;
    }
    if (spec.kind === 'data-source' && this.onDataSourceAuthorityChange) {
      for (const change of dataSourceAuthorityChanges(
        spec.workspaceId,
        previousContent,
        nextContent
      )) {
        this.onDataSourceAuthorityChange(change);
      }
    }
    if (spec.kind === 'mcp-server' && this.onMcpServerAuthorityChange) {
      for (const change of mcpServerAuthorityChanges(
        spec.workspaceId,
        previousContent,
        nextContent
      )) {
        this.onMcpServerAuthorityChange(change);
      }
    }
  }

  /**
   * Returns a server-owned template for a new provider, agent, or workspace config file.
   *
   * @param spec Resolved file spec.
   * @returns JSONC template content.
   */
  private templateForSpec(spec: RuntimeConfigFileSpec): string {
    const id =
      spec.kind === 'provider'
        ? basename(spec.relativePath, '.provider.jsonc')
        : basename(spec.relativePath, '.agent.jsonc');

    if (spec.kind === 'workspace') {
      return `{
  "schemaVersion": 1,
  "workspace": {
    "name": "${titleFromId(spec.workspaceId ?? 'workspace')}",
    "roots": []
  },
  "extensions": {}
}
`;
    }

    if (spec.kind === 'data-source') {
      return `{
  "schemaVersion": 1,
  "sources": [],
  "extensions": {}
}
`;
    }

    if (spec.kind === 'mcp-server') {
      return `{
  "schemaVersion": 1,
  "servers": []
}
`;
    }

    if (spec.kind === 'gateway') {
      return `{
  "schemaVersion": 1,
  "enabled": true,
  "logicalModels": []
}
`;
    }

    if (spec.kind === 'internal-role') {
      return `{
  "schemaVersion": 1,
  "profiles": []
}
`;
    }

    if (spec.kind === 'user') {
      return `{
  "schemaVersion": 1,
  "workspaces": []
}
`;
    }

    if (spec.kind === 'provider') {
      return `{
  "id": "${id}",
  "displayName": "${titleFromId(id)}",
  "kind": "custom",
  "baseUrl": "https://openrouter.ai/api/v1",
  "models": ["openai/gpt-5.1"],
  "defaultModel": "openai/gpt-5.1",
  "secretRef": "vault://provider_${id}"
}
`;
    }

    return `{
  "schemaVersion": 1,
  "id": "${id}",
  "displayName": "${titleFromId(id)}",
  "requiredFeatures": [],
  "runtime": {
    "kind": "codex",
    "adapter": "codex",
    "version": "0.144.1",
    "image": {
      "kind": "reference",
      "ref": "openkit/worker-codex:dev",
      "pullPolicy": "if-not-present"
    },
    "binaries": [
      { "id": "openkit-worker-shim", "path": "/usr/local/bin/openkit-worker-shim" },
      { "id": "node", "path": "/usr/local/bin/node" },
      { "id": "npm", "path": "/usr/local/bin/npm" },
      { "id": "npx", "path": "/usr/local/bin/npx" },
      { "id": "pnpm", "path": "/usr/local/bin/pnpm" },
      { "id": "pnpx", "path": "/usr/local/bin/pnpx" },
      { "id": "git", "path": "/usr/bin/git" },
      { "id": "gh", "path": "/usr/local/bin/gh" },
      { "id": "uv", "path": "/usr/local/bin/uv" },
      { "id": "python", "path": "/sandbox/.venv/bin/python" },
      { "id": "python3", "path": "/sandbox/.venv/bin/python3" },
      { "id": "pip", "path": "/sandbox/.venv/bin/pip" },
      { "id": "pip3", "path": "/sandbox/.venv/bin/pip3" },
      { "id": "codex", "path": "/usr/local/bin/codex" },
      { "id": "codex-native", "path": "/usr/local/lib/codex/bin/codex" }
    ]
  },
  "models": {
    "preferredLogicalModelId": "reasoning",
    "allowedLogicalModelIds": "all"
  },
  "profiles": [{ "id": "default" }],
  "defaultProfileId": "default",
  "skills": [],
  "mcp": [],
  "workspace": { "root": "." },
  "sandbox": {
    "filesystem": [],
    "network": [
      {
        "id": "github-git-read",
        "host": "github.com",
        "port": 443,
        "protocol": "rest",
        "rules": [
          { "method": "GET", "path": "/**/info/refs*" },
          { "method": "POST", "path": "/**/git-upload-pack" }
        ],
        "purpose": "Clone and fetch GitHub repositories without push authority.",
        "binaries": ["/usr/bin/git"]
      },
      {
        "id": "github-rest-read",
        "host": "api.github.com",
        "port": 443,
        "protocol": "rest",
        "access": "read-only",
        "purpose": "Read public GitHub REST resources through GitHub CLI.",
        "binaries": ["/usr/local/bin/gh"]
      },
      {
        "id": "npm-registry-read",
        "host": "registry.npmjs.org",
        "port": 443,
        "protocol": "rest",
        "access": "read-only",
        "purpose": "Download Node.js package metadata and archives.",
        "binaries": [
          "/usr/local/bin/node",
          "/usr/local/bin/npm",
          "/usr/local/bin/npx",
          "/usr/local/bin/pnpm",
          "/usr/local/bin/pnpx"
        ]
      },
      {
        "id": "pypi-index-read",
        "host": "pypi.org",
        "port": 443,
        "protocol": "rest",
        "access": "read-only",
        "purpose": "Read Python package index metadata.",
        "binaries": [
          "/usr/local/bin/uv",
          "/sandbox/.venv/bin/python",
          "/sandbox/.venv/bin/python3",
          "/sandbox/.venv/bin/pip",
          "/sandbox/.venv/bin/pip3"
        ]
      },
      {
        "id": "pypi-files-read",
        "host": "files.pythonhosted.org",
        "port": 443,
        "protocol": "rest",
        "access": "read-only",
        "purpose": "Download Python package archives.",
        "binaries": [
          "/usr/local/bin/uv",
          "/sandbox/.venv/bin/python",
          "/sandbox/.venv/bin/python3",
          "/sandbox/.venv/bin/pip",
          "/sandbox/.venv/bin/pip3"
        ]
      }
    ],
    "credentialDeclarations": [],
    "backend": {
      "allowedKinds": ["openshell"],
      "preferred": "openshell",
      "requiredCapabilities": ["trusted-worker-inference-relay"]
    }
  },
  "readiness": {
    "status": "unknown",
    "message": "Agent availability has not been probed yet."
  },
  "extensions": {}
}
`;
  }

  /**
   * Returns DATA_ROOT/config for this service.
   *
   * @returns Config root path.
   */
  private configRoot(): string {
    return join(this.dataRoot, CONFIG_ROOT);
  }

  /**
   * Returns the canonical workspace config path.
   *
   * @param workspaceId Workspace id to resolve.
   * @returns Workspace config path.
   */
  private workspaceConfigPath(
    workspaceId: string,
    kind: 'workspace' | 'data-source' | 'mcp-server'
  ): string {
    return join(
      this.dataRoot,
      'workspaces',
      workspaceId,
      'config',
      kind === 'data-source'
        ? 'data-sources.jsonc'
        : kind === 'mcp-server'
          ? 'mcp-servers.jsonc'
          : 'workspace.jsonc'
    );
  }

  /**
   * Returns the canonical workspace config root.
   *
   * @param workspaceId Workspace id to resolve.
   * @returns Workspace config directory path.
   */
  private workspaceConfigRoot(workspaceId: string): string {
    return join(this.dataRoot, 'workspaces', workspaceId, 'config');
  }

  /** Returns the canonical personal User config path. */
  private userConfigPath(userId: string): string {
    return join(this.dataRoot, 'users', userId, 'config', 'user.jsonc');
  }

  /** Ensures one path remains inside its canonical personal User config root. */
  private assertInsideUserConfigRoot(userId: string, path: string, allowMissing = false): void {
    const root = join(this.dataRoot, 'users', userId, 'config');
    const resolvedRoot = existsSync(root) ? realpathSync(root) : resolve(root);
    const realPath = existsSync(path)
      ? realpathSync(path)
      : allowMissing
        ? resolve(resolvedRoot, relative(resolve(root), resolve(path)))
        : path;
    const relativePath = relative(resolvedRoot, realPath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw invalidPathError(`users/${userId}/user.jsonc`);
    }
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new RuntimeConfigFileServiceError(
        'config_symlink_not_allowed',
        'User config files cannot be symlinks.',
        400
      );
    }
  }

  /**
   * Resolves the real config root path, optionally allowing a missing root before first create.
   *
   * @param allowMissing Whether DATA_ROOT/config may not exist yet.
   * @returns Real or resolved config root path.
   */
  private configRootPath(allowMissing: boolean): string {
    if (existsSync(this.configRoot())) {
      return realpathSync(this.configRoot());
    }

    if (allowMissing) {
      return resolve(this.configRoot());
    }

    throw new RuntimeConfigFileServiceError(
      'config_root_not_found',
      'DATA_ROOT/config does not exist.',
      404
    );
  }

  /**
   * Ensures one path is inside DATA_ROOT/config and not a symlink escape.
   *
   * @param path Path to validate.
   * @param allowMissing Whether the path may not exist yet.
   */
  private assertInsideConfigRoot(path: string, allowMissing = false): void {
    const root = this.configRootPath(allowMissing);
    const realPath = existsSync(path)
      ? realpathSync(path)
      : allowMissing
        ? resolve(root, relative(resolve(this.configRoot()), resolve(path)))
        : path;
    const relativePath = relative(root, realPath);

    if (
      relativePath.startsWith('..') ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`)
    ) {
      throw new RuntimeConfigFileServiceError(
        'config_path_not_allowed',
        'Runtime config paths must stay inside DATA_ROOT/config.',
        400
      );
    }

    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new RuntimeConfigFileServiceError(
        'config_symlink_not_allowed',
        'Runtime config files cannot be symlinks.',
        400
      );
    }
  }

  /**
   * Ensures one path is inside a canonical workspace config root.
   *
   * @param workspaceId Workspace id whose config root owns the path.
   * @param path Path to validate.
   * @param allowMissing Whether the path may not exist yet.
   */
  private assertInsideWorkspaceConfigRoot(
    workspaceId: string,
    path: string,
    allowMissing = false
  ): void {
    const root = existsSync(this.workspaceConfigRoot(workspaceId))
      ? realpathSync(this.workspaceConfigRoot(workspaceId))
      : resolve(this.workspaceConfigRoot(workspaceId));
    const realPath = existsSync(path)
      ? realpathSync(path)
      : allowMissing
        ? resolve(root, relative(resolve(this.workspaceConfigRoot(workspaceId)), resolve(path)))
        : path;
    const relativePath = relative(root, realPath);

    if (
      relativePath.startsWith('..') ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`)
    ) {
      throw new RuntimeConfigFileServiceError(
        'config_path_not_allowed',
        'Workspace config paths must stay inside the workspace config root.',
        400
      );
    }

    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new RuntimeConfigFileServiceError(
        'config_symlink_not_allowed',
        'Workspace config files cannot be symlinks.',
        400
      );
    }
  }
}

interface RuntimeConfigFileSpec {
  kind: RuntimeConfigFileKind;
  relativePath: string;
  absolutePath: string;
  workspaceId?: string;
  userId?: string;
}

/**
 * Parses one runtime config file id into a file spec without absolute path.
 *
 * @param id Runtime config file id.
 * @returns Partial file spec.
 */
function parseFileId(id: string): Omit<RuntimeConfigFileSpec, 'absolutePath'> {
  if (id === 'server.jsonc') {
    return { kind: 'server', relativePath: id };
  }
  if (id === 'gateway.jsonc') {
    return { kind: 'gateway', relativePath: id };
  }
  if (id === 'internal-role-profiles.jsonc') {
    return { kind: 'internal-role', relativePath: id };
  }

  const parts = id.split('/');

  if (
    parts.length === 3 &&
    parts[0] === 'workspaces' &&
    (parts[2] === 'workspace.jsonc' ||
      parts[2] === 'data-sources.jsonc' ||
      parts[2] === 'mcp-servers.jsonc') &&
    parts[1] &&
    VALID_FILE_NAME.test(parts[1]) &&
    !parts[1].includes('..')
  ) {
    return {
      kind:
        parts[2] === 'data-sources.jsonc'
          ? 'data-source'
          : parts[2] === 'mcp-servers.jsonc'
            ? 'mcp-server'
            : 'workspace',
      relativePath: id,
      workspaceId: parts[1],
    };
  }

  if (
    parts.length === 3 &&
    parts[0] === 'users' &&
    parts[2] === 'user.jsonc' &&
    parts[1] &&
    VALID_FILE_NAME.test(parts[1]) &&
    !parts[1].includes('..')
  ) {
    return { kind: 'user', relativePath: id, userId: parts[1] };
  }

  if (parts.length !== 2) {
    throw invalidPathError(id);
  }

  const [directory, fileName] = parts;

  if (!fileName || !VALID_FILE_NAME.test(fileName) || fileName.includes('..')) {
    throw invalidPathError(id);
  }

  if (directory === 'providers' && fileName.endsWith('.provider.jsonc')) {
    return { kind: 'provider', relativePath: id };
  }

  if (directory === 'agents' && fileName.endsWith('.agent.jsonc')) {
    return { kind: 'agent', relativePath: id };
  }

  throw invalidPathError(id);
}

/**
 * Creates one invalid path service error.
 *
 * @param id Rejected file id.
 * @returns Runtime config file service error.
 */
function invalidPathError(id: string): RuntimeConfigFileServiceError {
  return new RuntimeConfigFileServiceError(
    'config_path_not_allowed',
    `Runtime config file id is not allowed: ${id}.`,
    400
  );
}

/**
 * Computes one stable content revision.
 *
 * @param content File content.
 * @returns sha256-prefixed content revision.
 */
function contentRevision(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Selects the Zod schema for one runtime config file kind.
 *
 * @param kind Runtime config file kind.
 * @returns Zod schema.
 */
function schemaForKind(kind: RuntimeConfigFileKind): z.ZodType {
  if (kind === 'server') {
    return OpenKitConfigSchema;
  }

  if (kind === 'provider') {
    return ProviderProfileSchema;
  }

  if (kind === 'gateway') {
    return GatewayConfigSchema;
  }

  if (kind === 'internal-role') {
    return InternalRoleProfilesConfigSchema;
  }

  if (kind === 'user') {
    return UserConfigSchema;
  }

  if (kind === 'agent') {
    return AuthoredAgentConfigSchema;
  }

  if (kind === 'data-source') {
    return WorkspaceDataSourceCatalogSchema;
  }

  if (kind === 'mcp-server') {
    return WorkspaceMcpServerCatalogSchema;
  }

  return WorkspaceConfigSchema;
}

/**
 * Checks whether one runtime config kind is scoped to the current user's workspace config root.
 *
 * @param kind Runtime config file kind.
 * @returns True when the kind is workspace-scoped.
 */
function isWorkspaceScopedKind(
  kind: RuntimeConfigFileKind
): kind is 'workspace' | 'data-source' | 'mcp-server' {
  return kind === 'workspace' || kind === 'data-source' || kind === 'mcp-server';
}

/**
 * Lists authority-bearing field changes between two data source catalogs.
 *
 * @param workspaceId Workspace that owns the catalog.
 * @param previousContent Previous JSONC content, or null when creating.
 * @param nextContent Written JSONC content.
 * @returns Source-level authority changes.
 */
function dataSourceAuthorityChanges(
  workspaceId: string,
  previousContent: string | null,
  nextContent: string
): RuntimeConfigDataSourceAuthorityChange[] {
  const previous = parseWorkspaceDataSourceCatalogForAudit(previousContent);
  const next = parseWorkspaceDataSourceCatalogForAudit(nextContent);

  if (!next) {
    return [];
  }

  const previousSources = sourceMap(previous);
  const nextSources = sourceMap(next);
  const sourceIds = [...new Set([...previousSources.keys(), ...nextSources.keys()])].sort();

  return sourceIds.flatMap((sourceId) => {
    const previousSource = previousSources.get(sourceId) ?? null;
    const nextSource = nextSources.get(sourceId) ?? null;
    const fields = DATA_SOURCE_AUTHORITY_FIELDS.filter(
      (field) => (previousSource?.[field] ?? null) !== (nextSource?.[field] ?? null)
    );

    return fields.length > 0 ? [{ workspaceId, sourceId, fields: [...fields] }] : [];
  });
}

/**
 * Parses a data source catalog for audit diffing.
 *
 * @param content JSONC catalog content.
 * @returns Parsed catalog, or null when no previous valid catalog exists.
 */
function parseWorkspaceDataSourceCatalogForAudit(
  content: string | null
): WorkspaceDataSourceCatalog | null {
  if (!content) {
    return null;
  }

  const errors: ParseError[] = [];
  const parsed = parse(content, errors, { allowTrailingComma: true, disallowComments: false });

  if (errors.length > 0) {
    return null;
  }

  const result = WorkspaceDataSourceCatalogSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Indexes catalog sources by id.
 *
 * @param catalog Parsed data source catalog.
 * @returns Source map.
 */
function sourceMap(catalog: WorkspaceDataSourceCatalog | null): Map<string, WorkspaceDataSource> {
  return new Map(catalog?.sources.map((source) => [source.id, source]) ?? []);
}

/** Lists authority-bearing field changes between two MCP server catalogs. */
function mcpServerAuthorityChanges(
  workspaceId: string,
  previousContent: string | null,
  nextContent: string
): RuntimeConfigMcpServerAuthorityChange[] {
  const previous = parseWorkspaceMcpServerCatalogForAudit(previousContent);
  const next = parseWorkspaceMcpServerCatalogForAudit(nextContent);
  if (!next) return [];
  const previousServers = mcpServerMap(previous);
  const nextServers = mcpServerMap(next);
  const serverIds = [...new Set([...previousServers.keys(), ...nextServers.keys()])].sort();

  return serverIds.flatMap((serverId) => {
    const previousServer = previousServers.get(serverId) ?? null;
    const nextServer = nextServers.get(serverId) ?? null;
    const fields = MCP_SERVER_AUTHORITY_FIELDS.filter(
      (field) =>
        JSON.stringify(previousServer?.[field] ?? null) !==
        JSON.stringify(nextServer?.[field] ?? null)
    );
    return fields.length > 0 ? [{ fields: [...fields], serverId, workspaceId }] : [];
  });
}

/** Parses one MCP server catalog for audit diffing. */
function parseWorkspaceMcpServerCatalogForAudit(
  content: string | null
): WorkspaceMcpServerCatalog | null {
  if (!content) return null;
  const errors: ParseError[] = [];
  const parsed = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) return null;
  const result = WorkspaceMcpServerCatalogSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Indexes MCP catalog entries by id. */
function mcpServerMap(catalog: WorkspaceMcpServerCatalog | null): Map<string, WorkspaceMcpServer> {
  return new Map(catalog?.servers.map((server) => [server.id, server]) ?? []);
}

/**
 * Checks whether diagnostics contain at least one blocking error.
 *
 * @param diagnostics Diagnostics to inspect.
 * @returns True when an error is present.
 */
function hasBlockingDiagnostics(diagnostics: RuntimeConfigFileDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

/**
 * Creates an invalid content service error.
 *
 * @param diagnostics Diagnostics that blocked the write.
 * @returns Runtime config file service error.
 */
function invalidConfigContentError(
  diagnostics: RuntimeConfigFileDiagnostic[]
): RuntimeConfigFileServiceError {
  return new RuntimeConfigFileServiceError(
    'config_file_invalid',
    diagnostics[0]?.message ?? 'Runtime config file content is invalid.',
    400
  );
}

/**
 * Converts a JSONC parse error into an editor diagnostic.
 *
 * @param spec Runtime config file spec.
 * @param content Source content.
 * @param error Parse error.
 * @returns Runtime config file diagnostic.
 */
function parseErrorDiagnostic(
  spec: RuntimeConfigFileSpec,
  content: string,
  error: ParseError
): RuntimeConfigFileDiagnostic {
  const range = offsetRange(content, error.offset, Math.max(error.length, 1));

  return {
    fileId: spec.relativePath,
    severity: 'error',
    code: 'invalid_jsonc',
    message: `${printParseErrorCode(error.error)} at offset ${error.offset}.`,
    source: spec.relativePath,
    jsonPath: null,
    range,
  };
}

/**
 * Converts a source offset and length to one-based line and column range.
 *
 * @param content Source content.
 * @param offset Zero-based source offset.
 * @param length Source range length.
 * @returns One-based line and column range.
 */
function offsetRange(
  content: string,
  offset: number,
  length: number
): NonNullable<RuntimeConfigFileDiagnostic['range']> {
  const start = offsetPosition(content, offset);
  const end = offsetPosition(content, offset + length);

  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

/**
 * Converts a source offset to one-based line and column.
 *
 * @param content Source content.
 * @param offset Zero-based source offset.
 * @returns One-based position.
 */
function offsetPosition(content: string, offset: number): { line: number; column: number } {
  const slice = content.slice(0, Math.max(0, offset));
  const lines = slice.split('\n');

  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

/**
 * Creates an empty validation plan for invalid draft parsing.
 *
 * @param currentVersion Active runtime config version.
 * @returns Empty reload plan.
 */
function emptyValidationPlan(currentVersion: number): RuntimeConfigReloadPlan {
  return RuntimeConfigReloadPlanSchema.parse({
    previousVersion: currentVersion,
    nextVersion: currentVersion + 1,
    applied: [],
    deferred: [],
    requiresRestart: [],
    rejected: [],
    warnings: [],
  });
}

/**
 * Creates a rejected validation plan when candidate loading fails.
 *
 * @param currentVersion Active runtime config version.
 * @param error Failure reason.
 * @returns Rejected reload plan.
 */
function rejectedValidationPlan(currentVersion: number, error: unknown): RuntimeConfigReloadPlan {
  return RuntimeConfigReloadPlanSchema.parse({
    previousVersion: currentVersion,
    nextVersion: currentVersion + 1,
    applied: [],
    deferred: [],
    requiresRestart: [],
    rejected: [
      {
        path: 'config',
        category: 'rejected',
        action: 'rejected',
        summary: (error as Error).message,
      },
    ],
    warnings: [],
  });
}

/**
 * Converts runtime loader diagnostics into file diagnostics for the editor.
 *
 * @param diagnostic Runtime loader diagnostic.
 * @returns Runtime config file diagnostic.
 */
function runtimeDiagnosticToFileDiagnostic(diagnostic: {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  source: string;
}): RuntimeConfigFileDiagnostic {
  return {
    fileId: sourceToFileId(diagnostic.source),
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    source: diagnostic.source,
    jsonPath: null,
    range: null,
  };
}

/**
 * Maps a redacted runtime diagnostic source to the nearest config file id.
 *
 * @param source Runtime diagnostic source.
 * @returns Runtime config file id.
 */
function sourceToFileId(source: string): string {
  const marker = 'config/';
  const markerIndex = source.indexOf(marker);

  if (markerIndex >= 0) {
    return source.slice(markerIndex + marker.length);
  }

  if (source.includes('provider')) {
    return 'providers';
  }

  if (source.includes('agent')) {
    return 'agents';
  }

  return 'server.jsonc';
}

/**
 * Converts one config id into a human-readable display name.
 *
 * @param id Config id.
 * @returns Display label.
 */
function titleFromId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

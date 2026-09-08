import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CatalogMutationResponseSchema,
  CreateMcpConfigRequestSchema,
  CreateMcpConfigResponseSchema,
  DecideSkillCandidateRequestSchema,
  GetWorkspaceCatalogResponseSchema,
  ImportPluginRequestSchema,
  ImportPluginResponseSchema,
  ImportSkillRequestSchema,
  ImportSkillResponseSchema,
  ListMcpCatalogResponseSchema,
  ListPluginCatalogResponseSchema,
  ListSkillCatalogResponseSchema,
  SelectMcpVersionRequestSchema,
  SelectSkillVersionRequestSchema,
  SkillCandidateResponseSchema,
  SubmitSkillCandidateRequestSchema,
  UpdateMcpBindingRequestSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { asApiError, asCommandError, asInvalidRequestError } from '../api-errors.js';
import { isDeploymentAdminActor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { registerAppApiRoute } from '../openapi.js';
import {
  CatalogConflictError,
  CatalogForbiddenError,
  CatalogIntegrityError,
  CatalogNotFoundError,
  type CatalogTreeFile,
  createWorkspaceMcpConfig,
  decideWorkspaceSkillCandidate,
  importWorkspacePlugin,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  materializeCatalogTree,
  selectWorkspaceMcpVersion,
  selectWorkspaceSkillDefault,
  setWorkspaceSkillPin,
  submitWorkspaceSkillCandidate,
  updateWorkspaceMcpBinding,
} from './resource-catalog.js';

/**
 * Registers Workspace Skill, MCP, and Agent Plugin catalog routes.
 *
 * @param dependencies Hono app and data-root resolver.
 */
export function registerResourceCatalogRoutes({
  app,
  afterMutation,
  dataRoot,
}: {
  readonly afterMutation?: (workspaceId: string) => void;
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly dataRoot: (context: Context<{ Variables: AuthVariables }>) => string;
}): void {
  registerAppApiRoute(app, 'getWorkspaceCatalog', (c) => {
    try {
      return c.json(summarizeCatalog(loadCatalog(c, dataRoot)));
    } catch (error) {
      return catalogError(error, 'catalog_read_failed');
    }
  });

  registerAppApiRoute(app, 'listSkillCatalog', (c) => {
    try {
      return c.json(
        ListSkillCatalogResponseSchema.parse({ items: loadCatalog(c, dataRoot).skills.entries })
      );
    } catch (error) {
      return catalogError(error, 'skill_catalog_list_failed');
    }
  });

  registerAppApiRoute(app, 'importSkill', async (c) => {
    const parsed = ImportSkillRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return asInvalidRequestError('Invalid Skill import request.');
    }
    try {
      const result = importWorkspaceSkill({
        activate: parsed.data.activate,
        createdAt: new Date().toISOString(),
        dataRoot: dataRoot(c),
        displayName: parsed.data.displayName,
        expectedRevision: parsed.data.expectedRevision,
        ...(parsed.data.id ? { id: parsed.data.id } : {}),
        producer: { id: c.get('actor').userId, kind: 'user' },
        tree: catalogTree(parsed.data.tree),
        workspaceId: workspaceIdParam(c),
      });
      const entry = result.catalog.skills.entries.find(
        (item) => item.id === result.version.entryId
      );
      afterMutation?.(c.req.param('workspaceId'));
      return c.json(
        ImportSkillResponseSchema.parse({
          entry,
          revision: result.catalog.revision,
          version: publicSkillVersion(result.version),
        }),
        201
      );
    } catch (error) {
      return catalogError(error, 'skill_import_failed');
    }
  });

  registerAppApiRoute(app, 'submitSkillCandidate', async (c) => {
    const parsed = SubmitSkillCandidateRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return asInvalidRequestError('Invalid Skill candidate request.');
    }
    try {
      const result = submitWorkspaceSkillCandidate({
        baseDigest: parsed.data.baseDigest,
        createdAt: new Date().toISOString(),
        dataRoot: dataRoot(c),
        entryId: c.req.param('skillId'),
        expectedRevision: parsed.data.expectedRevision,
        producer: { id: c.get('actor').userId, kind: 'user' },
        summary: parsed.data.summary,
        tree: catalogTree(parsed.data.tree),
        workspaceId: workspaceIdParam(c),
      });
      afterMutation?.(c.req.param('workspaceId'));
      return c.json(
        SkillCandidateResponseSchema.parse({
          candidate: publicSkillCandidate(result.candidate),
          revision: result.catalog.revision,
        }),
        201
      );
    } catch (error) {
      return catalogError(error, 'skill_candidate_failed');
    }
  });

  registerAppApiRoute(app, 'decideSkillCandidate', async (c) => {
    const parsed = DecideSkillCandidateRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return asInvalidRequestError('Invalid Skill candidate decision.');
    }
    try {
      const catalog = decideWorkspaceSkillCandidate({
        candidateId: c.req.param('candidateId'),
        dataRoot: dataRoot(c),
        decision: parsed.data.decision,
        expectedRevision: parsed.data.expectedRevision,
        workspaceId: c.req.param('workspaceId'),
      });
      afterMutation?.(c.req.param('workspaceId'));
      return c.json(CatalogMutationResponseSchema.parse({ revision: catalog.revision }));
    } catch (error) {
      return catalogError(error, 'skill_candidate_decision_failed');
    }
  });

  registerAppApiRoute(app, 'selectSkillDefault', async (c) => {
    const parsed = SelectSkillVersionRequestSchema.safeParse(await c.req.json());
    if (!parsed.success || parsed.data.digest === null) {
      return asInvalidRequestError('Invalid Skill selection request.');
    }
    try {
      const catalog = selectWorkspaceSkillDefault({
        dataRoot: dataRoot(c),
        digest: parsed.data.digest,
        entryId: c.req.param('skillId'),
        expectedRevision: parsed.data.expectedRevision,
        workspaceId: c.req.param('workspaceId'),
      });
      afterMutation?.(c.req.param('workspaceId'));
      return c.json(CatalogMutationResponseSchema.parse({ revision: catalog.revision }));
    } catch (error) {
      return catalogError(error, 'skill_select_failed');
    }
  });

  registerAppApiRoute(app, 'setSkillPin', async (c) => {
    const parsed = SelectSkillVersionRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return asInvalidRequestError('Invalid Skill pin request.');
    }
    try {
      const catalog = setWorkspaceSkillPin({
        dataRoot: dataRoot(c),
        digest: parsed.data.digest,
        entryId: c.req.param('skillId'),
        expectedRevision: parsed.data.expectedRevision,
        workspaceId: c.req.param('workspaceId'),
      });
      afterMutation?.(c.req.param('workspaceId'));
      return c.json(CatalogMutationResponseSchema.parse({ revision: catalog.revision }));
    } catch (error) {
      return catalogError(error, 'skill_pin_failed');
    }
  });

  registerAppApiRoute(app, 'listMcpCatalog', (c) => {
    try {
      return c.json(
        ListMcpCatalogResponseSchema.parse({ items: mcpEntries(loadCatalog(c, dataRoot)) })
      );
    } catch (error) {
      return catalogError(error, 'mcp_catalog_list_failed');
    }
  });

  registerAppApiRoute(app, 'createMcpConfig', async (c) => {
    const parsed = CreateMcpConfigRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return asInvalidRequestError('Invalid MCP configuration request.');
    }
    try {
      const result = createWorkspaceMcpConfig({
        allowedTools: parsed.data.allowedTools,
        createdAt: new Date().toISOString(),
        dataRoot: dataRoot(c),
        declaration: parsed.data.declaration,
        displayName: parsed.data.displayName,
        expectedRevision: parsed.data.expectedRevision,
        ...(parsed.data.id ? { id: parsed.data.id } : {}),
        selectCurrent: true,
        stdioHostAuthorized: isDeploymentAdminActor(c.get('actor')),
        workspaceId: workspaceIdParam(c),
      });
      afterMutation?.(c.req.param('workspaceId'));
      return c.json(
        CreateMcpConfigResponseSchema.parse({
          entry: mcpEntries(result.catalog).find((item) => item.id === result.version.entryId),
          revision: result.catalog.revision,
          versionDigest: result.version.digest,
        }),
        201
      );
    } catch (error) {
      return catalogError(error, 'mcp_create_failed');
    }
  });

  registerAppApiRoute(app, 'selectMcpVersion', async (c) => {
    const parsed = SelectMcpVersionRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return asInvalidRequestError('Invalid MCP version selection.');
    }
    try {
      const catalog = selectWorkspaceMcpVersion({
        dataRoot: dataRoot(c),
        digest: parsed.data.digest,
        entryId: c.req.param('mcpId'),
        expectedRevision: parsed.data.expectedRevision,
        stdioHostAuthorized: isDeploymentAdminActor(c.get('actor')),
        workspaceId: workspaceIdParam(c),
      });
      afterMutation?.(c.req.param('workspaceId'));
      return c.json(CatalogMutationResponseSchema.parse({ revision: catalog.revision }));
    } catch (error) {
      return catalogError(error, 'mcp_select_failed');
    }
  });

  registerAppApiRoute(app, 'updateMcpBinding', async (c) => {
    const parsed = UpdateMcpBindingRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return asInvalidRequestError('Invalid MCP binding request.');
    }
    try {
      const catalog = loadCatalog(c, dataRoot);
      const entryId = c.req.param('mcpId');
      const existingBinding = catalog.mcp.bindings.find((item) => item.entryId === entryId);
      const version = catalog.mcp.versions.find(
        (item) =>
          item.entryId === entryId &&
          item.digest ===
            catalog.mcp.entries.find((entry) => entry.id === entryId)?.currentVersionDigest
      );
      if (
        parsed.data.enabled &&
        version?.declaration.kind === 'stdio' &&
        !isDeploymentAdminActor(c.get('actor'))
      ) {
        throw new HTTPException(403, {
          message: 'Enabling a stdio MCP server requires deployment-admin authority.',
        });
      }
      const next = updateWorkspaceMcpBinding({
        binding: {
          allowedTools: parsed.data.allowedTools,
          approvalRequiredTools: parsed.data.approvalRequiredTools,
          credentialBindings: existingBinding?.credentialBindings ?? [],
          deniedTools: parsed.data.deniedTools,
          enabled: parsed.data.enabled,
          pinnedSchemaSnapshotId: existingBinding?.pinnedSchemaSnapshotId ?? null,
          revision: parsed.data.bindingRevision,
          schemaPolicy: parsed.data.schemaPolicy,
          timeoutMs: parsed.data.timeoutMs,
        },
        dataRoot: dataRoot(c),
        entryId: c.req.param('mcpId'),
        expectedRevision: parsed.data.expectedRevision,
        workspaceId: c.req.param('workspaceId'),
      });
      afterMutation?.(c.req.param('workspaceId'));
      return c.json(CatalogMutationResponseSchema.parse({ revision: next.revision }));
    } catch (error) {
      return catalogError(error, 'mcp_binding_failed');
    }
  });

  registerAppApiRoute(app, 'listPluginCatalog', (c) => {
    try {
      return c.json(
        ListPluginCatalogResponseSchema.parse({ items: pluginEntries(loadCatalog(c, dataRoot)) })
      );
    } catch (error) {
      return catalogError(error, 'plugin_catalog_list_failed');
    }
  });

  registerAppApiRoute(app, 'importPlugin', async (c) => {
    const parsed = ImportPluginRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return asInvalidRequestError('Invalid plugin import request.');
    }
    const staging = mkdtempSync(join(tmpdir(), 'openkit-plugin-upload-'));
    try {
      materializeCatalogTree(staging, catalogTree(parsed.data.tree), {
        maxBytes: 64 * 1024 * 1024,
        maxEntries: 4_096,
      });
      const result = importWorkspacePlugin({
        createdAt: new Date().toISOString(),
        dataRoot: dataRoot(c),
        expectedRevision: parsed.data.expectedRevision,
        install: parsed.data.install,
        producer: { id: c.get('actor').userId, kind: 'user' },
        ...(parsed.data.selectedPackageKeys
          ? { selectedPackageKeys: parsed.data.selectedPackageKeys }
          : {}),
        treeRoot: staging,
        workspaceId: c.req.param('workspaceId'),
      });
      afterMutation?.(c.req.param('workspaceId'));
      return c.json(
        ImportPluginResponseSchema.parse({
          entry: pluginEntries(result.catalog).find((item) => item.id === result.version.entryId),
          revision: result.catalog.revision,
          versionDigest: result.version.digest,
        }),
        201
      );
    } catch (error) {
      return catalogError(error, 'plugin_import_failed');
    } finally {
      rmSync(staging, { force: true, recursive: true });
    }
  });
}

/** Loads the Workspace catalog named in the route. */
function loadCatalog(
  c: Context<{ Variables: AuthVariables }>,
  dataRoot: (context: Context<{ Variables: AuthVariables }>) => string
) {
  return loadWorkspaceResourceCatalog(dataRoot(c), workspaceIdParam(c));
}

/** Builds the redacted catalog summary. */
function summarizeCatalog(catalog: ReturnType<typeof loadWorkspaceResourceCatalog>) {
  return GetWorkspaceCatalogResponseSchema.parse({
    candidates: catalog.skills.candidates.map(publicSkillCandidate),
    mcp: mcpEntries(catalog),
    plugins: pluginEntries(catalog),
    revision: catalog.revision,
    skills: catalog.skills.entries.map((entry) => ({
      ...entry,
      pinDigest: catalog.skills.pins.find((pin) => pin.entryId === entry.id)?.digest ?? null,
      versions: catalog.skills.versions
        .filter((version) => version.entryId === entry.id)
        .map((version) => ({ createdAt: version.createdAt, digest: version.digest })),
    })),
  });
}

/** Projects redacted MCP entries. */
function mcpEntries(catalog: ReturnType<typeof loadWorkspaceResourceCatalog>) {
  return catalog.mcp.entries.map((entry) => {
    const version = catalog.mcp.versions.find((item) => item.digest === entry.currentVersionDigest);
    const binding = catalog.mcp.bindings.find((item) => item.entryId === entry.id);
    return {
      availability: entry.availability,
      allowedTools: binding?.allowedTools ?? [],
      approvalRequiredTools: binding?.approvalRequiredTools ?? [],
      bindingRevision: binding?.revision ?? 0,
      currentVersionDigest: entry.currentVersionDigest,
      deniedTools: binding?.deniedTools ?? [],
      displayName: entry.displayName,
      enabled: binding?.enabled === true,
      id: entry.id,
      schemaPolicy: binding?.schemaPolicy ?? null,
      timeoutMs: binding?.timeoutMs ?? null,
      transportKind: version?.declaration.kind ?? null,
      versions: catalog.mcp.versions
        .filter((item) => item.entryId === entry.id)
        .map((item) => ({
          createdAt: item.createdAt,
          digest: item.digest,
          transportKind: item.declaration.kind,
        })),
    };
  });
}

/** Projects a Skill version without producer or provenance internals. */
function publicSkillVersion(version: ReturnType<typeof importWorkspaceSkill>['version']) {
  return {
    createdAt: version.createdAt,
    digest: version.digest,
    digestFormat: version.digestFormat,
    entryId: version.entryId,
    inventory: version.inventory,
    publisherVersion: version.publisherVersion,
  };
}

/** Projects a Skill candidate without producer internals. */
function publicSkillCandidate(
  candidate: ReturnType<typeof submitWorkspaceSkillCandidate>['candidate']
) {
  return {
    baseDigest: candidate.baseDigest,
    candidateDigest: candidate.candidateDigest,
    createdAt: candidate.createdAt,
    disposition: candidate.disposition,
    entryId: candidate.entryId,
    id: candidate.id,
    summary: candidate.summary,
  };
}

/** Projects redacted plugin entries. */
function pluginEntries(catalog: ReturnType<typeof loadWorkspaceResourceCatalog>) {
  return catalog.plugins.entries.map((entry) => {
    const installation = catalog.plugins.installations.find((item) => item.pluginId === entry.id);
    const version = catalog.plugins.versions.find(
      (item) => item.digest === installation?.versionDigest
    );
    return {
      availability: entry.availability,
      description: entry.description,
      displayName: entry.displayName,
      id: entry.id,
      installedVersionDigest: installation?.versionDigest ?? null,
      memberCount: version?.members.length ?? 0,
    };
  });
}

/** Maps catalog errors onto the App API envelope. */
function catalogError(error: unknown, code: string) {
  if (error instanceof CatalogConflictError) {
    return asCommandError(error, code, 409);
  }
  if (error instanceof CatalogNotFoundError) {
    return asApiError(error.message, code, 404);
  }
  if (error instanceof CatalogForbiddenError) {
    return asApiError(error.message, 'catalog_forbidden', 403);
  }
  if (error instanceof CatalogIntegrityError) {
    return asApiError(error.message, 'recovery_required', 409);
  }
  if (error instanceof Error && error.message.startsWith('Resource tree')) {
    return asInvalidRequestError(error);
  }
  if (error instanceof HTTPException) {
    return asApiError(error.message, code, error.status);
  }
  return asCommandError(error, code);
}

/** Reads the Workspace id from the route, failing closed when Hono omits it. */
function workspaceIdParam(c: Context<{ Variables: AuthVariables }>): string {
  const workspaceId = c.req.param('workspaceId');
  if (!workspaceId) {
    throw new CatalogNotFoundError('Workspace not found.');
  }
  return workspaceId;
}

/** Narrows optional tree fields so exactOptionalPropertyTypes stays satisfied. */
function catalogTree(
  tree: ReadonlyArray<{
    contentBase64?: string | undefined;
    executable?: boolean | undefined;
    kind: 'directory' | 'file';
    path: string;
  }>
): CatalogTreeFile[] {
  return tree.map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    ...(entry.contentBase64 !== undefined ? { contentBase64: entry.contentBase64 } : {}),
    ...(entry.executable !== undefined ? { executable: entry.executable } : {}),
  }));
}

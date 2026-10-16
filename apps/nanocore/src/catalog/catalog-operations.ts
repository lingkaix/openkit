import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CATALOG_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { z } from 'zod';
import { publishedErrorMessage } from '../api-errors.js';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import {
  type AdmittedOperationContext,
  type FamilyImplementations,
  publicOperationActor,
} from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import {
  CatalogConflictError,
  CatalogContentUnavailableError,
  CatalogForbiddenError,
  CatalogInputError,
  CatalogIntegrityError,
  CatalogNotFoundError,
  CatalogRetentionError,
  type CatalogTreeFile,
  createWorkspaceMcpConfig,
  decideWorkspaceSkillCandidate,
  importWorkspacePlugin,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  McpBindingValidationError,
  materializeCatalogTree,
  purgeWorkspaceSkillVersion,
  removeWorkspaceSkill,
  type SkillCandidateDecisionContext,
  selectWorkspaceMcpVersion,
  selectWorkspaceSkillDefault,
  setWorkspaceSkillPin,
  submitWorkspaceSkillCandidate,
  updateWorkspaceMcpBinding,
} from './resource-catalog.js';
import {
  diffWorkspaceSkillVersions,
  readWorkspaceSkillContent,
  readWorkspaceSkillVersion,
} from './skill-inspection.js';

/** Existing Audit and retention owners supply authority; absent proof blocks the affected effect. */
export interface CatalogOperationHooks {
  /** Publishes current authenticated decision evidence through the existing Audit owner. */
  readonly prepareSkillDecision?: (
    input: {
      readonly candidateId: string;
      readonly decision: 'promoted' | 'rejected' | 'withdrawn';
      readonly expectedRevision: number;
      readonly requestId: string;
      readonly workspaceId: string;
    },
    context: AdmittedOperationContext
  ) => SkillCandidateDecisionContext;
  /** Complete current external reference causes; null means the owner cannot establish them. */
  readonly retainedSkillReferences?: (input: {
    readonly digest: string;
    readonly entryId: string;
    readonly workspaceId: string;
  }) => readonly string[] | null;
}

/** Joins catalog definitions to immutable supply and compare-and-set publication under existing admission owners. */
export function createCatalogOperationImplementations(
  dependencies: OperationInvocationDependencies,
  hooks: CatalogOperationHooks = {}
) {
  const root = () => {
    const value = dependencies.dataRoot ?? dependencies.store?.getDataRoot();
    if (!value) throw new Error('Workspace catalog operations require a data root.');
    return value;
  };
  const afterMutation = (workspaceId: string) => {
    dependencies.runtimeConfigManager?.reload({ dryRun: false, mode: 'safe' });
    void dependencies.closeWorkspaceMcpSessions?.(workspaceId);
  };
  const administrator = (context: AdmittedOperationContext) =>
    dependencies.coreDb !== undefined &&
    isCurrentDeploymentAdministrator(dependencies.coreDb, publicOperationActor(context));
  return {
    'catalog.read': (input) => {
      try {
        return summarizeCatalog(loadWorkspaceResourceCatalog(root(), input.workspaceId));
      } catch (error) {
        catalogFailure(error, 'catalog_read_failed');
      }
    },
    'catalog.skill-list': (input) => {
      try {
        return { items: loadWorkspaceResourceCatalog(root(), input.workspaceId).skills.entries };
      } catch (error) {
        catalogFailure(error, 'skill_catalog_list_failed');
      }
    },
    'catalog.skill-version-list': (input) => {
      try {
        const catalog = loadWorkspaceResourceCatalog(root(), input.workspaceId);
        if (!catalog.skills.entries.some((entry) => entry.id === input.skillId))
          throw new CatalogNotFoundError('Skill not found.');
        return {
          items: catalog.skills.versions
            .filter((version) => version.entryId === input.skillId)
            .map(publicSkillVersion),
        };
      } catch (error) {
        catalogFailure(error, 'skill_version_list_failed');
      }
    },
    'catalog.skill-version-read': (input) => {
      try {
        return {
          version: publicSkillVersion(
            readWorkspaceSkillVersion({
              dataRoot: root(),
              digest: input.digest,
              entryId: input.skillId,
              workspaceId: input.workspaceId,
            })
          ),
        };
      } catch (error) {
        catalogFailure(error, 'skill_version_read_failed');
      }
    },
    'catalog.skill-content-read': (input) => {
      try {
        return readWorkspaceSkillContent({
          dataRoot: root(),
          digest: input.digest,
          entryId: input.skillId,
          path: input.path,
          workspaceId: input.workspaceId,
        });
      } catch (error) {
        catalogFailure(error, 'skill_content_read_failed');
      }
    },
    'catalog.skill-diff': (input) => {
      try {
        return diffWorkspaceSkillVersions({
          dataRoot: root(),
          baseDigest: input.baseDigest,
          candidateDigest: input.candidateDigest,
          entryId: input.skillId,
          workspaceId: input.workspaceId,
        });
      } catch (error) {
        catalogFailure(error, 'skill_diff_failed');
      }
    },
    'catalog.skill-remove': (input) => {
      try {
        const catalog = removeWorkspaceSkill({
          dataRoot: root(),
          entryId: input.skillId,
          expectedRevision: input.expectedRevision,
          workspaceId: input.workspaceId,
        });
        return { revision: catalog.revision };
      } catch (error) {
        catalogFailure(error, 'skill_remove_failed');
      }
    },
    'catalog.skill-purge': (input) => {
      try {
        const version = {
          digest: input.digest,
          entryId: input.skillId,
          workspaceId: input.workspaceId,
        };
        const catalog = purgeWorkspaceSkillVersion({
          ...version,
          dataRoot: root(),
          expectedRevision: input.expectedRevision,
          retainedReferences: hooks.retainedSkillReferences?.(version) ?? null,
        });
        return { revision: catalog.revision };
      } catch (error) {
        catalogFailure(error, 'skill_purge_failed');
      }
    },
    'catalog.skill-import': (input, context) => {
      try {
        const result = importWorkspaceSkill({
          activate: input.activate,
          createdAt: new Date().toISOString(),
          dataRoot: root(),
          displayName: input.displayName,
          expectedRevision: input.expectedRevision,
          ...(input.id ? { id: input.id } : {}),
          producer: { id: publicOperationActor(context).userId, kind: 'user' },
          tree: catalogTree(input.tree),
          workspaceId: input.workspaceId,
        });
        const entry = result.catalog.skills.entries.find(
          (item) => item.id === result.version.entryId
        )!;
        afterMutation(input.workspaceId);
        return {
          entry,
          revision: result.catalog.revision,
          version: publicSkillVersion(result.version),
        };
      } catch (error) {
        catalogFailure(error, 'skill_import_failed');
      }
    },
    'catalog.skill-candidate-submit': (input, context) => {
      try {
        const result = submitWorkspaceSkillCandidate({
          baseDigest: input.baseDigest,
          createdAt: new Date().toISOString(),
          dataRoot: root(),
          entryId: input.skillId,
          expectedRevision: input.expectedRevision,
          producer: { id: publicOperationActor(context).userId, kind: 'user' },
          summary: input.summary,
          submitter: { id: publicOperationActor(context).userId, kind: 'user' },
          tree: catalogTree(input.tree),
          workspaceId: input.workspaceId,
        });
        afterMutation(input.workspaceId);
        return {
          candidate: publicSkillCandidate(result.candidate),
          revision: result.catalog.revision,
        };
      } catch (error) {
        catalogFailure(error, 'skill_candidate_failed');
      }
    },
    'catalog.skill-candidate-decide': (input, context) => {
      try {
        if (!hooks.prepareSkillDecision)
          throw new CatalogIntegrityError('Skill decision Audit authority is unavailable.');
        const catalog = decideWorkspaceSkillCandidate({
          candidateId: input.candidateId,
          dataRoot: root(),
          decision: input.decision,
          decisionContext: hooks.prepareSkillDecision(input, context),
          configurationOwner: true,
          expectedCurrentDigest: input.expectedCurrentDigest,
          expectedRevision: input.expectedRevision,
          workspaceId: input.workspaceId,
        });
        afterMutation(input.workspaceId);
        return { revision: catalog.revision };
      } catch (error) {
        catalogFailure(error, 'skill_candidate_decision_failed');
      }
    },
    'catalog.skill-candidate-withdraw': (input, context) => {
      try {
        if (!hooks.prepareSkillDecision)
          throw new CatalogIntegrityError('Skill decision Audit authority is unavailable.');
        const catalog = decideWorkspaceSkillCandidate({
          candidateId: input.candidateId,
          dataRoot: root(),
          decision: 'withdrawn',
          decisionContext: hooks.prepareSkillDecision({ ...input, decision: 'withdrawn' }, context),
          expectedRevision: input.expectedRevision,
          workspaceId: input.workspaceId,
        });
        return { revision: catalog.revision };
      } catch (error) {
        catalogFailure(error, 'skill_candidate_withdraw_failed');
      }
    },
    'catalog.skill-select': (input) => {
      try {
        const catalog = selectWorkspaceSkillDefault({
          dataRoot: root(),
          digest: input.digest,
          expectedCurrentDigest: input.expectedCurrentDigest,
          entryId: input.skillId,
          expectedRevision: input.expectedRevision,
          workspaceId: input.workspaceId,
        });
        afterMutation(input.workspaceId);
        return { revision: catalog.revision };
      } catch (error) {
        catalogFailure(error, 'skill_select_failed');
      }
    },
    'catalog.skill-pin': (input) => {
      try {
        const catalog = setWorkspaceSkillPin({
          dataRoot: root(),
          digest: input.digest,
          expectedPinDigest: input.expectedPinDigest,
          entryId: input.skillId,
          expectedRevision: input.expectedRevision,
          workspaceId: input.workspaceId,
        });
        afterMutation(input.workspaceId);
        return { revision: catalog.revision };
      } catch (error) {
        catalogFailure(error, 'skill_pin_failed');
      }
    },
    'catalog.mcp-list': (input) => {
      try {
        return { items: mcpEntries(loadWorkspaceResourceCatalog(root(), input.workspaceId)) };
      } catch (error) {
        catalogFailure(error, 'mcp_catalog_list_failed');
      }
    },
    'catalog.mcp-create': (input, context) => {
      try {
        const result = createWorkspaceMcpConfig({
          allowedTools: input.allowedTools,
          createdAt: new Date().toISOString(),
          dataRoot: root(),
          declaration: input.declaration,
          displayName: input.displayName,
          expectedRevision: input.expectedRevision,
          ...(input.id ? { id: input.id } : {}),
          selectCurrent: true,
          stdioHostAuthorized: administrator(context),
          workspaceId: input.workspaceId,
        });
        afterMutation(input.workspaceId);
        return {
          entry: mcpEntries(result.catalog).find((item) => item.id === result.version.entryId)!,
          revision: result.catalog.revision,
          versionDigest: result.version.digest,
        };
      } catch (error) {
        catalogFailure(error, 'mcp_create_failed');
      }
    },
    'catalog.mcp-select': (input, context) => {
      try {
        const catalog = selectWorkspaceMcpVersion({
          dataRoot: root(),
          digest: input.digest,
          entryId: input.mcpId,
          expectedRevision: input.expectedRevision,
          stdioHostAuthorized: administrator(context),
          workspaceId: input.workspaceId,
        });
        afterMutation(input.workspaceId);
        return { revision: catalog.revision };
      } catch (error) {
        catalogFailure(error, 'mcp_select_failed');
      }
    },
    'catalog.mcp-binding': (input, context) => {
      try {
        const catalog = loadWorkspaceResourceCatalog(root(), input.workspaceId);
        const entryId = input.mcpId;
        const existingBinding = catalog.mcp.bindings.find((item) => item.entryId === entryId);
        const version = catalog.mcp.versions.find(
          (item) =>
            item.entryId === entryId &&
            item.digest ===
              catalog.mcp.entries.find((entry) => entry.id === entryId)?.currentVersionDigest
        );
        if (input.enabled && version?.declaration.kind === 'stdio' && !administrator(context)) {
          throw new OperationError(
            'mcp_binding_failed',
            'Enabling a stdio MCP server requires deployment-admin authority.',
            403
          );
        }
        const next = updateWorkspaceMcpBinding({
          binding: {
            allowedTools: input.allowedTools,
            approvalRequiredTools: input.approvalRequiredTools,
            credentialBindings:
              input.credentialBindings ?? existingBinding?.credentialBindings ?? [],
            deniedTools: input.deniedTools,
            enabled: input.enabled,
            pinnedSchemaSnapshotId: existingBinding?.pinnedSchemaSnapshotId ?? null,
            revision: input.bindingRevision,
            schemaPolicy: input.schemaPolicy,
            timeoutMs: input.timeoutMs,
          },
          dataRoot: root(),
          entryId: input.mcpId,
          expectedRevision: input.expectedRevision,
          workspaceId: input.workspaceId,
        });
        afterMutation(input.workspaceId);
        return { revision: next.revision };
      } catch (error) {
        catalogFailure(error, 'mcp_binding_failed');
      }
    },
    'catalog.plugin-list': (input) => {
      try {
        return { items: pluginEntries(loadWorkspaceResourceCatalog(root(), input.workspaceId)) };
      } catch (error) {
        catalogFailure(error, 'plugin_catalog_list_failed');
      }
    },
    'catalog.plugin-import': (input, context) => {
      const staging = mkdtempSync(join(tmpdir(), 'openkit-plugin-upload-'));
      try {
        materializeCatalogTree(staging, catalogTree(input.tree), {
          maxBytes: 64 * 1024 * 1024,
          maxEntries: 4_096,
        });
        const result = importWorkspacePlugin({
          createdAt: new Date().toISOString(),
          dataRoot: root(),
          expectedRevision: input.expectedRevision,
          install: input.install,
          producer: { id: publicOperationActor(context).userId, kind: 'user' },
          ...(input.selectedPackageKeys ? { selectedPackageKeys: input.selectedPackageKeys } : {}),
          treeRoot: staging,
          workspaceId: input.workspaceId,
        });
        afterMutation(input.workspaceId);
        return {
          entry: pluginEntries(result.catalog).find((item) => item.id === result.version.entryId)!,
          revision: result.catalog.revision,
          versionDigest: result.version.digest,
        };
      } catch (error) {
        catalogFailure(error, 'plugin_import_failed');
      } finally {
        rmSync(staging, { force: true, recursive: true });
      }
    },
  } satisfies FamilyImplementations<typeof CATALOG_OPERATION_DEFINITIONS>;
}

/** Builds the redacted catalog summary. */
function summarizeCatalog(catalog: ReturnType<typeof loadWorkspaceResourceCatalog>) {
  return {
    candidates: catalog.skills.candidates.map(publicSkillCandidate),
    mcp: mcpEntries(catalog),
    plugins: pluginEntries(catalog),
    revision: catalog.revision,
    skills: catalog.skills.entries.map((entry) => ({
      ...entry,
      pinDigest: catalog.skills.pins.find((pin) => pin.entryId === entry.id)?.digest ?? null,
      versions: catalog.skills.versions
        .filter((version) => version.entryId === entry.id)
        .map((version) => ({
          contentState: version.contentState,
          createdAt: version.createdAt,
          digest: version.digest,
        })),
    })),
  };
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

/** Projects exact immutable metadata without retained descriptive annotations. */
function publicSkillVersion(version: ReturnType<typeof importWorkspaceSkill>['version']) {
  return {
    contentState: version.contentState,
    createdAt: version.createdAt,
    digest: version.digest,
    digestFormat: version.digestFormat,
    entryId: version.entryId,
    inventory: version.inventory,
    producer: version.producer,
    provenance: version.provenance,
    publisherVersion: version.publisherVersion,
  };
}

/** Projects candidate lineage and its exact retained decision. */
function publicSkillCandidate(
  candidate: ReturnType<typeof submitWorkspaceSkillCandidate>['candidate']
) {
  return {
    baseDigest: candidate.baseDigest,
    candidateDigest: candidate.candidateDigest,
    createdAt: candidate.createdAt,
    decision: candidate.decision,
    disposition: candidate.disposition,
    entryId: candidate.entryId,
    id: candidate.id,
    producer: candidate.producer,
    submitter: candidate.submitter,
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

/** Classifies known native catalog refusals locally; unexpected exceptions keep their identity. */
function catalogFailure(error: unknown, code: string): never {
  if (error instanceof OperationError) throw error;
  if (error instanceof CatalogConflictError)
    throw new OperationError('conflict', error.message, 409, { cause: error });
  if (error instanceof CatalogRetentionError)
    throw new OperationError('resource_retained', error.message, 409, {
      cause: error,
      details: { references: error.references },
    });
  if (error instanceof CatalogContentUnavailableError)
    throw new OperationError('resource_unavailable', error.message, 503, { cause: error });
  if (error instanceof CatalogInputError)
    throw new OperationError('invalid_request', error.message, 400, { cause: error });
  if (error instanceof CatalogNotFoundError)
    throw new OperationError(code, error.message, 404, { cause: error });
  if (error instanceof CatalogForbiddenError)
    throw new OperationError('catalog_forbidden', error.message, 403, { cause: error });
  if (error instanceof CatalogIntegrityError)
    throw new OperationError('recovery_required', error.message, 409, { cause: error });
  if (error instanceof McpBindingValidationError)
    throw new OperationError('invalid_request', z.prettifyError(error.validationError), 400, {
      cause: error,
    });
  if (error instanceof Error && error.message.startsWith('Resource tree'))
    throw new OperationError('invalid_request', error.message, 400, { cause: error });
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    throw new OperationError(code, publishedErrorMessage(error), 404, { cause: error });
  throw error;
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

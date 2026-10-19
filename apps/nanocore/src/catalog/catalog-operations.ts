import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG_OPERATION_DEFINITIONS, type OperationInput } from '@openkit/app-api-schemas';
import { z } from 'zod';
import { publishedErrorMessage } from '../api-errors.js';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { auditAuthenticationFromActor } from '../auth/audit-attribution.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from '../auth/operation-authorizer.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import {
  type AdmittedOperationContext,
  type FamilyImplementations,
  publicOperationActor,
} from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { readAuditEventRowV1 } from '../policy/retained-records-v1.js';
import {
  IdempotencyKeyConflictError,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import {
  readSkillCandidateArtifact,
  requireSkillCandidateArtifactAccess,
  SkillCandidateArtifactError,
  type SkillCandidateArtifactSelection,
} from '../skill-candidate-artifact.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  CatalogConflictError,
  CatalogContentUnavailableError,
  CatalogForbiddenError,
  CatalogInputError,
  CatalogIntegrityError,
  CatalogNotFoundError,
  CatalogRetentionError,
  type CatalogTreeFile,
  createMcpConfig,
  decideWorkspaceSkillCandidate,
  importWorkspacePlugin,
  type importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  McpBindingValidationError,
  materializeCatalogTree,
  type SkillCandidateDecisionContext,
  selectMcpVersion,
  submitWorkspaceSkillCandidate,
  updateMcpBinding,
  validateCatalogTree,
} from './resource-catalog.js';
import {
  acquireRemoteEcosystemSkill,
  checkEcosystemSkillUpdate,
} from './skill-ecosystem-source.js';
import {
  diffWorkspaceSkillVersions,
  readWorkspaceSkillContent,
  readWorkspaceSkillVersion,
} from './skill-inspection.js';
import { createSkillManagementCommands } from './skill-management-commands.js';
import { SkillSourceInputError } from './skill-source.js';

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
      readonly operation: 'catalog.skill-candidate-decide' | 'catalog.skill-candidate-withdraw';
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

/** Records a real current human decision admission through the existing Workspace Audit owner. */
export function prepareCatalogSkillDecision(
  dependencies: OperationInvocationDependencies,
  input: Parameters<NonNullable<CatalogOperationHooks['prepareSkillDecision']>>[0],
  context: AdmittedOperationContext
): SkillCandidateDecisionContext {
  const actor = publicOperationActor(context);
  const policyOperation = CATALOG_OPERATION_DEFINITIONS[input.operation].policyOperation;
  if (
    !dependencies.coreDb ||
    !dependencies.repositoryWorkspaceDb ||
    context.actorRef.kind !== 'user' ||
    !isWorkspaceOperationAuthorized(dependencies.coreDb, actor, input.workspaceId, {
      mutating: true,
      policyOperation,
    })
  )
    throw new CatalogForbiddenError('Current Skill decision authority is unavailable.');
  const workspaceDb = dependencies.repositoryWorkspaceDb(input.workspaceId);
  try {
    const event = recordWorkspaceAuditEvent({
      workspaceDb,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      actor: context.actorRef,
      action: `${input.operation}.admit`,
      resource: `skill-candidate:${input.candidateId}`,
      resourceRevision: input.expectedRevision > 0 ? input.expectedRevision : null,
      outcome: 'succeeded',
      summary: `Human Skill candidate ${input.decision} admission.`,
    });
    return {
      actor: { kind: 'user', id: actor.userId },
      auditRef: event.id,
      decidedAt: new Date().toISOString(),
    };
  } finally {
    workspaceDb.sqlite.close();
  }
}

const ARTIFACT_EVIDENCE_PREFIX = 'artifact:';

/** Keeps the complete selected Artifact identity in the existing candidate evidence references. */
function artifactEvidence(selection: SkillCandidateArtifactSelection): string {
  const { workspaceId, artifactId, version, contentDigest } = selection;
  return `${ARTIFACT_EVIDENCE_PREFIX}${JSON.stringify({ workspaceId, artifactId, version, contentDigest })}`;
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
  const management = createSkillManagementCommands(dependencies, hooks, afterMutation);
  const administrator = (context: AdmittedOperationContext) =>
    dependencies.coreDb !== undefined &&
    isCurrentDeploymentAdministrator(dependencies.coreDb, publicOperationActor(context));
  /** Reuses the existing receipt/Audit owners; no catalog-specific ledger is created. */
  const commandOwners = (workspaceId: string) => {
    if (
      !dependencies.store ||
      !dependencies.coreDb ||
      !dependencies.inflightCommands ||
      !dependencies.repositoryWorkspaceDb
    )
      throw new OperationError(
        'operation_storage_unavailable',
        'Skill command storage is unavailable.',
        503
      );
    return {
      store: dependencies.store,
      inflightCommands: dependencies.inflightCommands,
      workspaceDb: dependencies.repositoryWorkspaceDb(workspaceId),
    };
  };
  /** Opens the existing Audit home before any file-backed catalog mutation. */
  const mutationAuditDb = (workspaceId: string) => {
    if (!dependencies.repositoryWorkspaceDb)
      throw new CatalogIntegrityError('Catalog Audit storage is unavailable.');
    return dependencies.repositoryWorkspaceDb(workspaceId);
  };
  /** Retains the actual caller and selected resource, without executable declarations or binding contents. */
  const auditMutation = (
    workspaceDb: WorkspaceDb,
    input: { workspaceId: string; requestId: string },
    context: AdmittedOperationContext,
    action: string,
    resource: string,
    resourceRevision: number
  ) =>
    recordWorkspaceAuditEvent({
      workspaceDb,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      actor: context.actorRef,
      authentication: auditAuthenticationFromActor(publicOperationActor(context)),
      action,
      resource,
      resourceRevision,
      category: 'command',
      outcome: 'succeeded',
      summary: 'Catalog mutation completed.',
    });
  const readArtifact = (
    selection: SkillCandidateArtifactSelection,
    context: AdmittedOperationContext
  ) => {
    if (!dependencies.store || !dependencies.coreDb)
      throw new CatalogIntegrityError('Skill Artifact authority is unavailable.');
    return readSkillCandidateArtifact({
      store: dependencies.store,
      coreDb: dependencies.coreDb,
      actor: publicOperationActor(context),
      selection,
      destination: 'workspace-skill',
    });
  };
  const requireArtifactAccess = (
    selection: SkillCandidateArtifactSelection,
    context: AdmittedOperationContext
  ) => {
    if (!dependencies.store || !dependencies.coreDb)
      throw new CatalogIntegrityError('Skill Artifact authority is unavailable.');
    requireSkillCandidateArtifactAccess({
      store: dependencies.store,
      coreDb: dependencies.coreDb,
      actor: publicOperationActor(context),
      selection,
      destination: 'workspace-skill',
    });
  };
  const revalidate = (
    workspaceId: string,
    operation:
      | 'catalog.skill-candidate-submit'
      | 'catalog.skill-candidate-decide'
      | 'catalog.skill-candidate-withdraw'
      | 'catalog.skill-update-check',
    context: AdmittedOperationContext
  ) => {
    if (
      !dependencies.coreDb ||
      !isWorkspaceOperationAuthorized(
        dependencies.coreDb,
        publicOperationActor(context),
        workspaceId,
        {
          mutating: operation !== 'catalog.skill-update-check',
          policyOperation: CATALOG_OPERATION_DEFINITIONS[operation].policyOperation,
        }
      )
    )
      throw new CatalogForbiddenError('Current Skill command authority is unavailable.');
  };
  /** Existing Audit admission makes an interrupted cross-store result visible without replaying its effect. */
  const refuseInterrupted = (
    workspaceDb: WorkspaceDb,
    operation: string,
    input: { requestId: string; workspaceId: string; expectedRevision: number },
    context: AdmittedOperationContext
  ) => {
    const admitted = workspaceDb.sqlite
      .prepare(
        'SELECT *, actor_json AS actor FROM audit_events WHERE workspace_id = ? AND request_id = ? AND action = ?'
      )
      .all(input.workspaceId, input.requestId, `${operation}.admit`) as { actor: string | null }[];
    for (const row of admitted) readAuditEventRowV1(row);
    if (
      loadWorkspaceResourceCatalog(root(), input.workspaceId).revision !== input.expectedRevision
    ) {
      if (admitted.some((row) => row.actor === JSON.stringify(context.actorRef)))
        throw new CatalogIntegrityError(
          'Skill command has an interrupted result. Inspect it before a new request.'
        );
      throw new CatalogConflictError();
    }
  };
  const auditResult = (
    workspaceDb: WorkspaceDb,
    operation: string,
    input: { workspaceId: string; requestId: string },
    context: AdmittedOperationContext,
    candidateId: string,
    revision: number
  ) =>
    recordWorkspaceAuditEvent({
      workspaceDb,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      actor: context.actorRef,
      action: operation,
      resource: `skill-candidate:${candidateId}`,
      resourceRevision: revision,
      outcome: 'succeeded',
      summary: 'Skill candidate command completed.',
    });
  const decision = async (
    operation: 'catalog.skill-candidate-decide' | 'catalog.skill-candidate-withdraw',
    input:
      | OperationInput<'catalog.skill-candidate-decide'>
      | OperationInput<'catalog.skill-candidate-withdraw'>,
    context: AdmittedOperationContext
  ) => {
    const owners = commandOwners(input.workspaceId);
    let published = false;
    const selectedDecision = 'decision' in input ? input.decision : 'withdrawn';
    const currentCandidate = () => {
      revalidate(input.workspaceId, operation, context);
      const catalog = loadWorkspaceResourceCatalog(root(), input.workspaceId);
      const candidate = catalog.skills.candidates.find((item) => item.id === input.candidateId);
      if (!candidate) throw new CatalogNotFoundError('Skill candidate not found.');
      for (const ref of candidate.evidenceRefs.filter((value) =>
        value.startsWith(ARTIFACT_EVIDENCE_PREFIX)
      )) {
        let selection: SkillCandidateArtifactSelection;
        try {
          selection = JSON.parse(
            ref.slice(ARTIFACT_EVIDENCE_PREFIX.length)
          ) as SkillCandidateArtifactSelection;
        } catch {
          throw new SkillCandidateArtifactError('source_unavailable');
        }
        if (
          !selection ||
          selection.workspaceId !== input.workspaceId ||
          typeof selection.artifactId !== 'string' ||
          !selection.artifactId ||
          !Number.isSafeInteger(selection.version) ||
          selection.version < 1 ||
          typeof selection.contentDigest !== 'string' ||
          !/^sha256:[a-f0-9]{64}$/.test(selection.contentDigest)
        )
          throw new SkillCandidateArtifactError('source_unavailable');
        requireArtifactAccess(selection, context);
      }
      return { catalog, candidate };
    };
    try {
      return await runIdempotentCommand({
        ...owners,
        command: operation,
        requestId: input.requestId,
        scope: {
          workspaceId: input.workspaceId,
          actorId: publicOperationActor(context).userId,
          candidateId: input.candidateId,
        },
        input,
        responseKind: 'skill_candidate',
        responseId: () => input.candidateId,
        replay: (receipt) => {
          const { catalog, candidate } = currentCandidate();
          if (
            receipt.response.kind !== 'skill_candidate' ||
            receipt.response.id !== candidate.id ||
            candidate.disposition !== selectedDecision ||
            candidate.decision?.actor.kind !== 'user' ||
            candidate.decision?.actor.id !== publicOperationActor(context).userId
          )
            throw new CatalogIntegrityError('Skill decision receipt does not match its candidate.');
          return { revision: catalog.revision };
        },
        execute: () => {
          const { catalog: current, candidate } = currentCandidate();
          refuseInterrupted(owners.workspaceDb, operation, input, context);
          if (candidate.disposition !== 'proposed')
            throw new CatalogNotFoundError('Skill candidate is not proposed.');
          const currentDigest = current.skills.entries.find(
            (entry) => entry.id === candidate.entryId
          )?.currentDigest;
          if (
            ('expectedCurrentDigest' in input && input.expectedCurrentDigest !== currentDigest) ||
            (selectedDecision === 'promoted' && candidate.baseDigest !== currentDigest)
          )
            throw new CatalogConflictError(
              'Skill candidate base no longer matches current selection.'
            );
          if (!hooks.prepareSkillDecision)
            throw new CatalogIntegrityError('Skill decision Audit authority is unavailable.');
          const catalog = decideWorkspaceSkillCandidate({
            candidateId: input.candidateId,
            dataRoot: root(),
            decision: selectedDecision,
            decisionContext: hooks.prepareSkillDecision(
              { ...input, operation, decision: selectedDecision },
              context
            ),
            configurationOwner:
              operation === 'catalog.skill-candidate-decide' ||
              Boolean(
                dependencies.coreDb &&
                  isWorkspaceOperationAuthorized(
                    dependencies.coreDb,
                    publicOperationActor(context),
                    input.workspaceId,
                    { mutating: true, policyOperation: 'workspace.configure' }
                  )
              ),
            ...('expectedCurrentDigest' in input
              ? { expectedCurrentDigest: input.expectedCurrentDigest }
              : {}),
            expectedRevision: input.expectedRevision,
            workspaceId: input.workspaceId,
          });
          published = true;
          auditResult(
            owners.workspaceDb,
            operation,
            input,
            context,
            input.candidateId,
            catalog.revision
          );
          afterMutation(input.workspaceId);
          return { revision: catalog.revision };
        },
      });
    } catch (error) {
      if (published)
        throw new CatalogIntegrityError(
          'Skill decision completion evidence is unavailable. Inspect the result before a new request.'
        );
      throw error;
    } finally {
      owners.workspaceDb.sqlite.close();
    }
  };
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
    'catalog.skill-update-check': async (input, context) => {
      try {
        revalidate(input.workspaceId, 'catalog.skill-update-check', context);
        const version = readWorkspaceSkillVersion({
          dataRoot: root(),
          workspaceId: input.workspaceId,
          entryId: input.skillId,
          digest: input.digest,
        });
        const result = await checkEcosystemSkillUpdate(version);
        revalidate(input.workspaceId, 'catalog.skill-update-check', context);
        return result;
      } catch (error) {
        catalogFailure(error, 'skill_update_check_failed');
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
    'catalog.skill-remove': async (input, context) => {
      try {
        return await management.mutateSkill('catalog.skill-remove', input, context);
      } catch (error) {
        catalogFailure(error, 'skill_remove_failed');
      }
    },
    'catalog.skill-purge': async (input, context) => {
      try {
        return await management.mutateSkill('catalog.skill-purge', input, context);
      } catch (error) {
        catalogFailure(error, 'skill_purge_failed');
      }
    },
    'catalog.skill-import': async (input, context) => {
      try {
        const result = await management.importSkill(input, context, () =>
          input.source === undefined
            ? { tree: catalogTree(input.tree!) }
            : acquireRemoteEcosystemSkill({
                source: input.source,
                sourceSubpath: input.sourceSubpath,
                sourceSkillName: input.sourceSkillName,
              })
        );
        const entry = result.catalog.skills.entries.find(
          (item) => item.id === result.version.entryId
        )!;
        return {
          entry,
          revision: result.catalog.revision,
          version: publicSkillVersion(result.version),
        };
      } catch (error) {
        catalogFailure(error, 'skill_import_failed');
      }
    },
    'catalog.skill-candidate-submit': async (input, context) => {
      const owners = commandOwners(input.workspaceId);
      let published = false;
      const source = () => {
        revalidate(input.workspaceId, 'catalog.skill-candidate-submit', context);
        if (input.artifact !== undefined) {
          const admitted = readArtifact(
            { workspaceId: input.workspaceId, ...input.artifact },
            context
          );
          const producer = admitted.producer;
          if (
            !producer ||
            (producer.kind !== 'agent' && producer.kind !== 'user' && producer.kind !== 'system')
          )
            throw new SkillCandidateArtifactError('source_unavailable');
          const reference = artifactEvidence(admitted.source);
          return {
            tree: admitted.tree,
            digest: admitted.digest,
            producer: { kind: producer.kind, id: producer.id },
            uploadedSourceId: reference,
            evidenceRefs: [
              reference,
              ...(admitted.producingTurn ? [`turn:${JSON.stringify(admitted.producingTurn)}`] : []),
            ],
            admitted,
          };
        }
        const tree = catalogTree(input.tree!);
        return {
          tree,
          digest: validateCatalogTree(tree).digest,
          producer: { kind: 'user' as const, id: publicOperationActor(context).userId },
          uploadedSourceId: null,
          evidenceRefs: [],
          admitted: null,
        };
      };
      try {
        return await runIdempotentCommand({
          ...owners,
          command: 'catalog.skill-candidate-submit',
          requestId: input.requestId,
          scope: { workspaceId: input.workspaceId, actorId: publicOperationActor(context).userId },
          input,
          responseKind: 'skill_candidate',
          responseId: (result) => result.candidate.id,
          replay: (receipt) => {
            revalidate(input.workspaceId, 'catalog.skill-candidate-submit', context);
            if (input.artifact !== undefined)
              requireArtifactAccess({ workspaceId: input.workspaceId, ...input.artifact }, context);
            const catalog = loadWorkspaceResourceCatalog(root(), input.workspaceId);
            const candidate = catalog.skills.candidates.find(
              (item) => item.id === receipt.response.id
            );
            if (
              receipt.response.kind !== 'skill_candidate' ||
              !candidate ||
              candidate.entryId !== input.skillId ||
              candidate.baseDigest !== input.baseDigest ||
              candidate.summary !== input.summary ||
              candidate.submitter?.id !== publicOperationActor(context).userId ||
              (input.artifact !== undefined
                ? !candidate.evidenceRefs.includes(
                    artifactEvidence({ workspaceId: input.workspaceId, ...input.artifact })
                  )
                : candidate.candidateDigest !==
                  validateCatalogTree(catalogTree(input.tree!)).digest)
            )
              throw new CatalogIntegrityError(
                'Skill submission receipt does not match its candidate.'
              );
            return { candidate: publicSkillCandidate(candidate), revision: catalog.revision };
          },
          execute: () => {
            const admitted = source();
            refuseInterrupted(owners.workspaceDb, 'catalog.skill-candidate-submit', input, context);
            recordWorkspaceAuditEvent({
              workspaceDb: owners.workspaceDb,
              workspaceId: input.workspaceId,
              requestId: input.requestId,
              actor: context.actorRef,
              ...(admitted.admitted?.producingTurn
                ? {
                    threadId: admitted.admitted.producingTurn.threadId,
                    turnId: admitted.admitted.producingTurn.turnId,
                    agentId: admitted.admitted.producingTurn.agentId,
                  }
                : {}),
              action: 'catalog.skill-candidate-submit.admit',
              resource: `skill:${input.skillId}@${admitted.digest}`,
              resourceRevision: input.expectedRevision > 0 ? input.expectedRevision : null,
              outcome: 'succeeded',
              summary: `Skill candidate admission from ${input.baseDigest ?? 'none'} to ${admitted.digest}.`,
            });
            const result = submitWorkspaceSkillCandidate({
              baseDigest: input.baseDigest,
              createdAt: new Date().toISOString(),
              dataRoot: root(),
              entryId: input.skillId,
              expectedRevision: input.expectedRevision,
              producer: admitted.producer,
              summary: input.summary,
              submitter: { id: publicOperationActor(context).userId, kind: 'user' },
              tree: admitted.tree,
              uploadedSourceId: admitted.uploadedSourceId,
              evidenceRefs: admitted.evidenceRefs,
              workspaceId: input.workspaceId,
            });
            published = true;
            auditResult(
              owners.workspaceDb,
              'catalog.skill-candidate-submit',
              input,
              context,
              result.candidate.id,
              result.catalog.revision
            );
            afterMutation(input.workspaceId);
            return {
              candidate: publicSkillCandidate(result.candidate),
              revision: result.catalog.revision,
            };
          },
        });
      } catch (error) {
        if (published)
          throw new OperationError(
            'recovery_required',
            'Skill submission completion evidence is unavailable. Inspect the result before a new request.',
            409,
            { cause: error }
          );
        catalogFailure(error, 'skill_candidate_failed');
      } finally {
        owners.workspaceDb.sqlite.close();
      }
    },
    'catalog.skill-candidate-decide': async (input, context) => {
      try {
        return await decision('catalog.skill-candidate-decide', input, context);
      } catch (error) {
        catalogFailure(error, 'skill_candidate_decision_failed');
      }
    },
    'catalog.skill-candidate-withdraw': async (input, context) => {
      try {
        return await decision('catalog.skill-candidate-withdraw', input, context);
      } catch (error) {
        catalogFailure(error, 'skill_candidate_withdraw_failed');
      }
    },
    'catalog.skill-select': async (input, context) => {
      try {
        return await management.mutateSkill('catalog.skill-select', input, context);
      } catch (error) {
        catalogFailure(error, 'skill_select_failed');
      }
    },
    'catalog.skill-pin': async (input, context) => {
      try {
        return await management.mutateSkill('catalog.skill-pin', input, context);
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
      const workspaceDb = mutationAuditDb(input.workspaceId);
      try {
        const result = createMcpConfig({
          allowedTools: input.allowedTools,
          createdAt: new Date().toISOString(),
          dataRoot: root(),
          declaration: input.declaration,
          displayName: input.displayName,
          expectedRevision: input.expectedRevision,
          ...(input.id ? { id: input.id } : {}),
          selectCurrent: true,
          stdioHostAuthorized: administrator(context),
          owner: { kind: 'workspace', workspaceId: input.workspaceId },
        });
        auditMutation(
          workspaceDb,
          input,
          context,
          'catalog.mcp-create',
          `mcp:${result.version.entryId}@${result.version.digest}`,
          result.catalog.revision
        );
        afterMutation(input.workspaceId);
        return {
          entry: mcpEntries(result.catalog).find((item) => item.id === result.version.entryId)!,
          revision: result.catalog.revision,
          versionDigest: result.version.digest,
        };
      } catch (error) {
        catalogFailure(error, 'mcp_create_failed');
      } finally {
        workspaceDb.sqlite.close();
      }
    },
    'catalog.mcp-select': (input, context) => {
      const workspaceDb = mutationAuditDb(input.workspaceId);
      try {
        const catalog = selectMcpVersion({
          dataRoot: root(),
          digest: input.digest,
          entryId: input.mcpId,
          expectedRevision: input.expectedRevision,
          stdioHostAuthorized: administrator(context),
          owner: { kind: 'workspace', workspaceId: input.workspaceId },
        });
        auditMutation(
          workspaceDb,
          input,
          context,
          'catalog.mcp-select',
          `mcp:${input.mcpId}@${input.digest}`,
          catalog.revision
        );
        afterMutation(input.workspaceId);
        return { revision: catalog.revision };
      } catch (error) {
        catalogFailure(error, 'mcp_select_failed');
      } finally {
        workspaceDb.sqlite.close();
      }
    },
    'catalog.mcp-binding': (input, context) => {
      const workspaceDb = mutationAuditDb(input.workspaceId);
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
        const next = updateMcpBinding({
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
          owner: { kind: 'workspace', workspaceId: input.workspaceId },
        });
        auditMutation(
          workspaceDb,
          input,
          context,
          'catalog.mcp-binding',
          `mcp:${input.mcpId}`,
          next.revision
        );
        afterMutation(input.workspaceId);
        return { revision: next.revision };
      } catch (error) {
        catalogFailure(error, 'mcp_binding_failed');
      } finally {
        workspaceDb.sqlite.close();
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
      let workspaceDb: WorkspaceDb | undefined;
      try {
        workspaceDb = mutationAuditDb(input.workspaceId);
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
        auditMutation(
          workspaceDb,
          input,
          context,
          'catalog.plugin-import',
          `plugin:${result.version.entryId}@${result.version.digest}`,
          result.catalog.revision
        );
        afterMutation(input.workspaceId);
        return {
          entry: pluginEntries(result.catalog).find((item) => item.id === result.version.entryId)!,
          revision: result.catalog.revision,
          versionDigest: result.version.digest,
        };
      } catch (error) {
        catalogFailure(error, 'plugin_import_failed');
      } finally {
        workspaceDb?.sqlite.close();
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
    skills: catalog.skills.entries.map((entry) => {
      const pin = catalog.skills.pins.find((item) => item.entryId === entry.id);
      return {
        ...entry,
        pinDigest: pin?.digest ?? null,
        ...(pin?.pinAuditRef === undefined ? {} : { pinAuditRef: pin.pinAuditRef }),
        versions: catalog.skills.versions
          .filter((version) => version.entryId === entry.id)
          .map((version) => ({
            contentState: version.contentState,
            createdAt: version.createdAt,
            digest: version.digest,
          })),
      };
    }),
  };
}

/** Projects redacted MCP entries. */
export function mcpEntries(catalog: ReturnType<typeof loadWorkspaceResourceCatalog>) {
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
export function catalogFailure(error: unknown, code: string): never {
  if (error instanceof OperationError) throw error;
  if (error instanceof SkillSourceInputError)
    throw new OperationError('invalid_request', error.message, 400, { cause: error });
  if (error instanceof IdempotencyKeyConflictError)
    throw new OperationError(error.code, error.message, error.status, { cause: error });
  if (error instanceof SkillCandidateArtifactError)
    throw new OperationError(error.code, error.message, error.status, { cause: error });
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

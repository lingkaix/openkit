import { readAuditEventRowV1 } from '../policy/retained-records-v1.js';
import { CATALOG_OPERATION_DEFINITIONS, type OperationInput } from '@openkit/app-api-schemas';
import type { ResourceCatalogDocument, SkillVersionRecord } from '@openkit/config-schema';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import { type AdmittedOperationContext, publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { runIdempotentCommand } from '../runtime/idempotent-command.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { CatalogOperationHooks } from './catalog-operations.js';
import {
  CatalogConflictError,
  CatalogForbiddenError,
  CatalogIntegrityError,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  purgeWorkspaceSkillVersion,
  removeWorkspaceSkill,
  selectWorkspaceSkillDefault,
  setWorkspaceSkillPin,
  validateCatalogTree,
} from './resource-catalog.js';
import type { AcquiredSkillSupply } from './skill-ecosystem-source.js';

type PointerOperation =
  | 'catalog.skill-select'
  | 'catalog.skill-pin'
  | 'catalog.skill-remove'
  | 'catalog.skill-purge';
type ManagementOperation = PointerOperation | 'catalog.skill-import';
type CommandInput = {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
};
type ImportResult = { catalog: ResourceCatalogDocument; version: SkillVersionRecord };

/**
 * Joins native Skill mutations to the existing command receipt and Workspace Audit owners.
 * Catalog files and SQLite are separate effect domains. An interrupted publication remains
 * inspectable and is never reconstructed from the current selection or repeated implicitly.
 */
export function createSkillManagementCommands(
  dependencies: OperationInvocationDependencies,
  hooks: CatalogOperationHooks,
  afterMutation: (workspaceId: string) => void
) {
  const dataRoot = dependencies.dataRoot ?? dependencies.store?.getDataRoot();
  const root = () => {
    if (!dataRoot) throw new CatalogIntegrityError('Skill catalog storage is unavailable.');
    return dataRoot;
  };
  const authorize = (
    operation: ManagementOperation,
    input: CommandInput,
    context: AdmittedOperationContext
  ) => {
    if (
      !dependencies.coreDb ||
      !isWorkspaceOperationAuthorized(
        dependencies.coreDb,
        publicOperationActor(context),
        input.workspaceId,
        {
          mutating: true,
          policyOperation: CATALOG_OPERATION_DEFINITIONS[operation].policyOperation,
        }
      )
    )
      throw new CatalogForbiddenError('Current Skill command authority is unavailable.');
  };
  const audit = (
    workspaceDb: WorkspaceDb,
    operation: ManagementOperation,
    input: CommandInput,
    context: AdmittedOperationContext,
    resource: string,
    revision: number,
    summary: string,
    admission = false
  ) =>
    recordWorkspaceAuditEvent({
      workspaceDb,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      actor: context.actorRef,
      action: `${operation}${admission ? '.admit' : ''}`,
      resource,
      resourceRevision: revision > 0 ? revision : null,
      outcome: 'succeeded',
      summary,
    });
  const command = async <T>(options: {
    operation: ManagementOperation;
    input: CommandInput;
    context: AdmittedOperationContext;
    responseKind: 'skill_version' | 'skill_catalog';
    responseId: (result: T) => string;
    replay: (id: string, catalog: ResourceCatalogDocument) => T;
    execute: (workspaceDb: WorkspaceDb, catalog: ResourceCatalogDocument) => T | Promise<T>;
  }): Promise<T> => {
    const { operation, input, context } = options;
    if (
      !dependencies.store ||
      !dependencies.inflightCommands ||
      !dependencies.repositoryWorkspaceDb
    )
      throw new OperationError(
        'operation_storage_unavailable',
        'Skill command storage is unavailable.',
        503
      );
    const workspaceDb = dependencies.repositoryWorkspaceDb(input.workspaceId);
    let published = false;
    let executing = false;
    try {
      return await runIdempotentCommand({
        store: dependencies.store,
        inflightCommands: dependencies.inflightCommands,
        workspaceDb,
        command: operation,
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId, actorId: publicOperationActor(context).userId },
        input,
        responseKind: options.responseKind,
        responseId: options.responseId,
        replay: (receipt) => {
          authorize(operation, input, context);
          if (receipt.response.kind !== options.responseKind)
            throw new CatalogIntegrityError('Skill command receipt has an invalid resource kind.');
          return options.replay(
            receipt.response.id,
            loadWorkspaceResourceCatalog(root(), input.workspaceId)
          );
        },
        execute: async () => {
          authorize(operation, input, context);
          const catalog = loadWorkspaceResourceCatalog(root(), input.workspaceId);
          const admitted = workspaceDb.sqlite
            .prepare(
              'SELECT *, actor_json AS actor FROM audit_events WHERE workspace_id = ? AND request_id = ? AND action = ?'
            )
            .all(input.workspaceId, input.requestId, `${operation}.admit`) as {
            actor: string | null;
          }[];
          for (const row of admitted) readAuditEventRowV1(row);
          // A purge can delete bytes before its catalog revision advances. Its admitted result
          // therefore needs inspection even if the old revision is still current.
          if (
            (operation === 'catalog.skill-purge' || catalog.revision !== input.expectedRevision) &&
            admitted.some((row) => row.actor === JSON.stringify(context.actorRef))
          )
            throw new CatalogIntegrityError(
              'Skill command has an interrupted result. Inspect it before a new request.'
            );
          if (catalog.revision !== input.expectedRevision) throw new CatalogConflictError();
          executing = true;
          const result = await options.execute(workspaceDb, catalog);
          published = true;
          afterMutation(input.workspaceId);
          return result;
        },
      });
    } catch (error) {
      if (
        published ||
        (executing &&
          loadWorkspaceResourceCatalog(root(), input.workspaceId).revision !==
            input.expectedRevision &&
          !(error instanceof CatalogConflictError))
      )
        throw new CatalogIntegrityError(
          'Skill command completion evidence is unavailable. Inspect the result before a new request.'
        );
      throw error;
    } finally {
      workspaceDb.sqlite.close();
    }
  };
  return {
    /** Acquisition runs only for a fresh admitted command, never while replaying retained bytes. */
    importSkill(
      input: OperationInput<'catalog.skill-import'>,
      context: AdmittedOperationContext,
      acquire: () => AcquiredSkillSupply | Promise<AcquiredSkillSupply>
    ): Promise<ImportResult> {
      return command({
        operation: 'catalog.skill-import',
        input,
        context,
        responseKind: 'skill_version',
        responseId: ({ version }) => JSON.stringify([version.entryId, version.digest]),
        replay: (id, catalog) => {
          const version = catalog.skills.versions.find(
            (item) => JSON.stringify([item.entryId, item.digest]) === id
          );
          if (!version)
            throw new CatalogIntegrityError('Skill import receipt has no retained version.');
          return { catalog, version };
        },
        execute: async (workspaceDb, catalog) => {
          const acquired = await acquire();
          const { tree } = acquired;
          const digest = validateCatalogTree(tree).digest;
          authorize('catalog.skill-import', input, context);
          if (
            loadWorkspaceResourceCatalog(root(), input.workspaceId).revision !==
            input.expectedRevision
          )
            throw new CatalogConflictError();
          const previous =
            catalog.skills.entries.find((item) => item.id === input.id)?.currentDigest ?? null;
          const summary = `Skill import from ${previous ?? 'none'} to ${digest}.`;
          audit(
            workspaceDb,
            'catalog.skill-import',
            input,
            context,
            `skill:${digest}`,
            catalog.revision,
            summary,
            true
          );
          const result = importWorkspaceSkill({
            activate: input.activate,
            createdAt: new Date().toISOString(),
            dataRoot: root(),
            displayName: input.displayName,
            expectedRevision: input.expectedRevision,
            ...(input.id === undefined ? {} : { id: input.id }),
            producer: { kind: 'user', id: publicOperationActor(context).userId },
            uploadedSourceId: input.requestId,
            ...(acquired.sourceLocator === undefined
              ? {}
              : { sourceLocator: acquired.sourceLocator }),
            ...(acquired.sourceCommit === undefined ? {} : { sourceCommit: acquired.sourceCommit }),
            ...(acquired.sourceSubpath === undefined
              ? {}
              : { sourceSubpath: acquired.sourceSubpath }),
            tree,
            workspaceId: input.workspaceId,
          });
          audit(
            workspaceDb,
            'catalog.skill-import',
            input,
            context,
            `skill:${result.version.entryId}@${digest}`,
            result.catalog.revision,
            summary
          );
          return result;
        },
      });
    },
    /** Selection, pinning, removal and purge retain their current catalog lifecycle semantics. */
    mutateSkill<O extends PointerOperation>(
      operation: O,
      input: OperationInput<O>,
      context: AdmittedOperationContext
    ): Promise<{ revision: number }> {
      return command({
        operation,
        input,
        context,
        responseKind: 'skill_catalog',
        responseId: () => input.workspaceId,
        replay: (id, catalog) => {
          if (id !== input.workspaceId)
            throw new CatalogIntegrityError('Skill command receipt has a different Workspace.');
          return { revision: catalog.revision };
        },
        execute: (workspaceDb, catalog) => {
          const version = 'digest' in input ? input.digest : null;
          const previous =
            operation === 'catalog.skill-pin'
              ? (catalog.skills.pins.find((item) => item.entryId === input.skillId)?.digest ?? null)
              : (catalog.skills.entries.find((item) => item.id === input.skillId)?.currentDigest ??
                null);
          const summary = `Skill command from ${previous ?? 'none'} to ${version ?? 'none'}.`;
          const resource = `skill:${input.skillId}${version ? `@${version}` : ''}`;
          const base = {
            dataRoot: root(),
            workspaceId: input.workspaceId,
            entryId: input.skillId,
            expectedRevision: input.expectedRevision,
          };
          const admit = () =>
            audit(
              workspaceDb,
              operation,
              input,
              context,
              resource,
              catalog.revision,
              summary,
              true
            );
          if (operation !== 'catalog.skill-purge') admit();
          let next: ResourceCatalogDocument;
          if (operation === 'catalog.skill-select' && 'expectedCurrentDigest' in input) {
            next = selectWorkspaceSkillDefault({
              ...base,
              digest: input.digest,
              expectedCurrentDigest: input.expectedCurrentDigest,
            });
          } else if (operation === 'catalog.skill-pin' && 'expectedPinDigest' in input) {
            next = setWorkspaceSkillPin({
              ...base,
              digest: input.digest,
              expectedPinDigest: input.expectedPinDigest,
            });
          } else if (operation === 'catalog.skill-remove') {
            next = removeWorkspaceSkill(base);
          } else if (
            operation === 'catalog.skill-purge' &&
            'digest' in input &&
            input.digest !== null
          ) {
            const selected = {
              workspaceId: input.workspaceId,
              entryId: input.skillId,
              digest: input.digest,
            };
            next = purgeWorkspaceSkillVersion({
              ...base,
              digest: input.digest,
              retainedReferences: hooks.retainedSkillReferences?.(selected) ?? null,
              admitDeletion: admit,
            });
          } else {
            throw new CatalogIntegrityError('Skill command input does not match its operation.');
          }
          audit(workspaceDb, operation, input, context, resource, next.revision, summary);
          return { revision: next.revision };
        },
      });
    },
  };
}

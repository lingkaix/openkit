import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ResourceCatalogIdSchema,
  ResourceDigestSchema,
  type SkillVersionRecord,
} from '@openkit/config-schema';
import { isSealedTurnTerminal } from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import {
  authorizeWorkspace,
  isCurrentDeploymentAdministrator,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { normalizeCapabilityRequestId } from '../capability/usage-ledger.js';
import {
  CatalogIntegrityError,
  loadWorkspaceResourceCatalog,
  readWorkspaceSkillSnapshot,
  skillSnapshotPath,
} from '../catalog/resource-catalog.js';
import type { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import type { CoreDb } from '../storage/db.js';
import {
  type AssistantSkillAdmission,
  AssistantSkillAdmissionSchema,
} from '../storage/work-observations.js';
import type { AgentTool, ToolExecutionContext } from './internal-agent-loop.js';
import { redactInternalAgentText } from './redaction.js';

/** Complete UTF-8 model projections are bounded; instructions are never truncated. */
const MAX_SKILL_PROJECTION_BYTES = 64 * 1024;

/** Logical private-operation input; caller authority is never model input. */
export const AssistantSkillReadInputSchema = z
  .object({
    skillId: ResourceCatalogIdSchema,
    versionId: ResourceDigestSchema,
    contentDigest: ResourceDigestSchema,
    path: z.string().min(1).default('SKILL.md'),
  })
  .strict();

/** Logical success validated by native invocation before model projection. */
export const AssistantSkillReadOutputSchema = z
  .object({
    skillId: ResourceCatalogIdSchema,
    versionId: ResourceDigestSchema,
    path: z.string().min(1),
    fileDigest: ResourceDigestSchema,
    text: z.string(),
  })
  .strict();

/** Parsed logical input, including the default relative file. */
export type AssistantSkillReadInput = z.output<typeof AssistantSkillReadInputSchema>;
/** Exact logical success; no AgentToolResult envelope reaches the invocation output validator. */
export type AssistantSkillReadOutput = z.output<typeof AssistantSkillReadOutputSchema>;

/** Release-authored private table, separate from every public operation projection. */
export const ASSISTANT_SKILL_OPERATION_DEFINITIONS = Object.freeze({
  'skill.read': Object.freeze({
    binding: 'internal',
    entryScope: 'conversation.submit',
    description:
      'Read one UTF-8 text file from an exact selected Skill. Loading text executes no code.',
    inputSchema: AssistantSkillReadInputSchema,
    outputSchema: AssistantSkillReadOutputSchema,
    policyOperation: 'workspace.read',
    mutating: false,
  } as const),
});

type SkillResourceFailureCode =
  | 'resource_unavailable'
  | 'resource_access_denied'
  | 'invalid_skill_read'
  | 'skill_content_integrity_failed'
  | 'skill_content_too_large'
  | 'skill_content_not_text';

/** Fixed safe failures at admission or the private Skill Tool boundary. */
export class AssistantSkillResourceError extends Error {
  public constructor(public readonly code: SkillResourceFailureCode) {
    super(
      {
        resource_unavailable: 'Selected Skill resources are unavailable.',
        resource_access_denied: 'Skill resource access is denied.',
        invalid_skill_read: 'The Skill read does not match an admitted relative file.',
        skill_content_integrity_failed: 'The selected Skill content failed integrity checks.',
        skill_content_too_large: 'The Skill content exceeds the response size limit.',
        skill_content_not_text: 'The selected Skill file is not valid UTF-8 text.',
      }[code]
    );
    this.name = 'AssistantSkillResourceError';
  }
}

/** Metadata-only identity of one selected immutable Workspace Skill. */
export interface AssistantSkillMetadata {
  readonly skillId: string;
  readonly name: string;
  readonly description: string | null;
  /** Catalog versions use their existing content digest as identity. */
  readonly versionId: string;
  readonly contentDigest: string;
}

/** Trusted ordinary-entry lineage and authored selection for one new bounded run. */
export interface AssistantSkillAssemblyInput {
  readonly dataRoot: string;
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly actor: Actor;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  /** Actual command identity supplied by entry admission, never inferred from retained evidence. */
  readonly requestId: string;
  readonly skillIds?: readonly string[];
}

/** Fixed metadata, existing-owner evidence input and retained native invocation handler. */
export interface AssistantSkillResources {
  readonly index: readonly AssistantSkillMetadata[];
  readonly admission: AssistantSkillAdmission;
  /**
   * Handles logical reads only under the retained trusted invocation context.
   *
   * This inline shape projects P12's agreed AssistantOperationInvocationContext until its canonical type export lands. P12 owns the type; replace this structural projection with that import when the supplier is published, rather than adding a competing named context owner.
   */
  read(
    input: AssistantSkillReadInput,
    context: {
      readonly kind: 'assistant-command';
      readonly actor: Actor;
      readonly workspaceId: string;
      readonly threadId: string;
      readonly turnId: string;
      readonly entryScope: 'conversation.submit';
      readonly requestId: string;
      readonly signal: AbortSignal;
    }
  ): Promise<AssistantSkillReadOutput>;
  /** Checks the original lineage and current retained authority without selecting new pins. */
  assertCurrent(
    lineage: Pick<AssistantSkillAssemblyInput, 'actor' | 'workspaceId' | 'threadId' | 'turnId'>
  ): void;
}

/** Exact catalog metadata and retained inventory admitted together. */
type AdmittedSkill = { metadata: AssistantSkillMetadata; version: SkillVersionRecord };

/**
 * Assembles selected Skill metadata and an exact-snapshot read closure for an ordinary Assistant run.
 *
 * The ordinary entry supplies authored IDs once per run. Catalog presence grants no selection or authority, and resource text cannot enlarge the Tool set. Entry assembly retains admission through existing Turn/capability evidence and owns publication reauthorization; this factory persists no run or selection record.
 *
 * @param input Current authority, admitted conversation lineage, and selected Workspace identities.
 * @returns Immutable metadata, admission and the original logical handler for native invocation.
 * @throws AssistantSkillResourceError when selected metadata or current authority is unavailable.
 */
export async function assembleAssistantSkillResources(
  input: AssistantSkillAssemblyInput
): Promise<AssistantSkillResources> {
  const requestId = normalizeCapabilityRequestId(input.requestId);
  if (requestId === null) throw new AssistantSkillResourceError('resource_access_denied');
  // Copy transient selectors; a caller's later object mutation cannot change this run's authority.
  const scope = {
    dataRoot: input.dataRoot,
    coreDb: input.coreDb,
    store: input.store,
    actor: {
      ...input.actor,
      ...(input.actor.tokenWorkspaceIds
        ? { tokenWorkspaceIds: [...input.actor.tokenWorkspaceIds] }
        : {}),
    },
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId,
  };
  const admitted = new Map<string, AdmittedSkill>();
  const metadata: AssistantSkillMetadata[] = [];
  let catalogRevision: number | null = null;
  try {
    assertCurrentSkillAuthority(scope);
    const selected = [...(input.skillIds ?? [])];
    if (new Set(selected).size !== selected.length || selected.some((id) => !id))
      throw new AssistantSkillResourceError('resource_unavailable');
    if (selected.length > 0) {
      const catalog = loadWorkspaceResourceCatalog(scope.dataRoot, scope.workspaceId);
      catalogRevision = catalog.revision;
      let indexBytes = 2;
      for (const skillId of selected.sort()) {
        const entry = catalog.skills.entries.find((item) => item.id === skillId);
        const digest =
          catalog.skills.pins.find((item) => item.entryId === skillId)?.digest ??
          entry?.currentDigest;
        const version = catalog.skills.versions.find(
          (item) => item.entryId === skillId && item.digest === digest
        );
        if (
          !entry ||
          entry.availability !== 'available' ||
          !digest ||
          !version ||
          version.contentState === 'purged'
        )
          throw new AssistantSkillResourceError('resource_unavailable');
        const item = Object.freeze({
          skillId,
          name: entry.displayName,
          description: entry.description,
          versionId: digest,
          contentDigest: digest,
        });
        indexBytes += (metadata.length > 0 ? 1 : 0) + Buffer.byteLength(JSON.stringify(item));
        if (indexBytes > MAX_SKILL_PROJECTION_BYTES)
          throw new AssistantSkillResourceError('resource_unavailable');
        // Directory metadata is sufficient here; no Skill body is read before a Tool request.
        assertSnapshotContained(
          scope.dataRoot,
          skillSnapshotPath(scope.dataRoot, scope.workspaceId, skillId, digest)
        );
        metadata.push(item);
        admitted.set(skillId, { metadata: item, version });
      }
    }
  } catch (error) {
    throw safeSkillFailure(error);
  }
  const index = Object.freeze(metadata);
  const admission: AssistantSkillAdmission = AssistantSkillAdmissionSchema.parse({
    catalogRevision,
    skills: index.map(({ skillId, versionId, contentDigest }) => ({
      skillId,
      versionId,
      contentDigest,
    })),
  });
  for (const skill of admission.skills) Object.freeze(skill);
  Object.freeze(admission.skills);
  Object.freeze(admission);

  /** Removal denies reuse; default and pin changes do not replace the original version. */
  function assertRetainedSkills(selection: Iterable<AdmittedSkill>): void {
    assertCurrentSkillAuthority(scope);
    if (admitted.size === 0) return;
    const current = loadWorkspaceResourceCatalog(scope.dataRoot, scope.workspaceId);
    for (const selected of selection) {
      const { skillId, contentDigest } = selected.metadata;
      const entry = current.skills.entries.find((item) => item.id === skillId);
      const version = current.skills.versions.find(
        (item) => item.entryId === skillId && item.digest === contentDigest
      );
      if (
        entry?.availability !== 'available' ||
        !version ||
        version.contentState === 'purged' ||
        JSON.stringify(version.inventory) !== JSON.stringify(selected.version.inventory)
      )
        throw new AssistantSkillResourceError('resource_unavailable');
      assertSnapshotContained(
        scope.dataRoot,
        skillSnapshotPath(scope.dataRoot, scope.workspaceId, skillId, contentDigest)
      );
    }
  }
  return Object.freeze({
    index,
    admission,
    async read(
      args: AssistantSkillReadInput,
      context: Parameters<AssistantSkillResources['read']>[1]
    ): Promise<AssistantSkillReadOutput> {
      try {
        if (
          !context ||
          context.kind !== 'assistant-command' ||
          context.entryScope !== ASSISTANT_SKILL_OPERATION_DEFINITIONS['skill.read'].entryScope ||
          context.workspaceId !== scope.workspaceId ||
          context.threadId !== scope.threadId ||
          context.turnId !== scope.turnId ||
          context.requestId !== scope.requestId ||
          !isDeepStrictEqual(context.actor, scope.actor) ||
          !(context.signal instanceof AbortSignal)
        )
          throw new AssistantSkillResourceError('resource_access_denied');
        context.signal.throwIfAborted();
        const parsed = AssistantSkillReadInputSchema.safeParse(args);
        if (!parsed.success) throw new AssistantSkillResourceError('invalid_skill_read');
        const { skillId, versionId, contentDigest, path } = parsed.data;
        const selected = admitted.get(skillId);
        if (
          !selected ||
          selected.metadata.versionId !== versionId ||
          selected.metadata.contentDigest !== contentDigest
        )
          throw new AssistantSkillResourceError('invalid_skill_read');
        const retainedFile = selected.version.inventory.find(
          (file) => file.path === path && file.kind === 'file'
        );
        if (!retainedFile?.sha256) throw new AssistantSkillResourceError('invalid_skill_read');
        assertRetainedSkills([selected]);
        if (retainedFile.size > MAX_SKILL_PROJECTION_BYTES)
          throw new AssistantSkillResourceError('skill_content_too_large');
        // Catalog owns complete tree/digest/inventory verification. Return bytes from that same collection.
        const { entries } = readWorkspaceSkillSnapshot({
          dataRoot: scope.dataRoot,
          workspaceId: scope.workspaceId,
          entryId: skillId,
          digest: contentDigest,
        });
        const file = entries.find((item) => item.path === path && item.kind !== 0);
        if (!file?.content) throw new AssistantSkillResourceError('resource_unavailable');
        let text: string;
        try {
          // Preserve a UTF-8 BOM and exact text; provenance hashes the original bytes.
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.content);
        } catch {
          throw new AssistantSkillResourceError('skill_content_not_text');
        }
        for (const character of text) {
          const value = character.codePointAt(0)!;
          if ((value < 32 && value !== 9 && value !== 10 && value !== 13) || value === 127)
            throw new AssistantSkillResourceError('skill_content_not_text');
        }
        const output = AssistantSkillReadOutputSchema.parse({
          skillId,
          versionId,
          path,
          fileDigest: retainedFile.sha256,
          text: redactInternalAgentText(text),
        });
        const result = JSON.stringify(output);
        // The loop sanitizes again. Require a fixed point so provenance and the byte bound survive it.
        if (redactInternalAgentText(result) !== result)
          throw new AssistantSkillResourceError('resource_unavailable');
        if (Buffer.byteLength(result) > MAX_SKILL_PROJECTION_BYTES)
          throw new AssistantSkillResourceError('skill_content_too_large');
        // Verified bytes do not outlive current actor, audience, Turn or catalog eligibility.
        assertRetainedSkills([selected]);
        context.signal.throwIfAborted();
        return output;
      } catch (error) {
        if (context?.signal?.aborted) throw context.signal.reason;
        throw safeSkillFailure(error);
      }
    },
    assertCurrent(
      lineage: Pick<AssistantSkillAssemblyInput, 'actor' | 'workspaceId' | 'threadId' | 'turnId'>
    ) {
      try {
        if (
          lineage.workspaceId !== scope.workspaceId ||
          lineage.threadId !== scope.threadId ||
          lineage.turnId !== scope.turnId ||
          !isDeepStrictEqual(lineage.actor, scope.actor)
        )
          throw new AssistantSkillResourceError('resource_access_denied');
        assertRetainedSkills(admitted.values());
      } catch (error) {
        throw safeSkillFailure(error);
      }
    },
  });
}

/**
 * Derives the private model Tool from the release-authored definition and a native invoker.
 *
 * The caller binds native invocation to this run's retained handler and trusted context. This projection receives no resources or handler, and cannot provide a direct read alternative. Invocation owns input parsing, primary admission and logical output validation; this final projection enforces the model envelope and never exposes unknown exception text.
 *
 * @param invoke Native invoker supplied by P12's exact-key private binding.
 * @returns One fixed definition-derived Tool with bounded safe observations.
 */
export function createAssistantSkillReadTool(
  invoke: (input: unknown, context: ToolExecutionContext) => Promise<AssistantSkillReadOutput>
): AgentTool {
  const [name] = Object.keys(ASSISTANT_SKILL_OPERATION_DEFINITIONS) as ['skill.read'];
  const definition = ASSISTANT_SKILL_OPERATION_DEFINITIONS[name];
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(definition.inputSchema, {
    io: 'input',
  });
  return Object.freeze({
    name,
    description: definition.description,
    inputSchema,
    async execute(input: unknown, context: ToolExecutionContext) {
      context.signal.throwIfAborted();
      try {
        const output = definition.outputSchema.safeParse(await invoke(input, context));
        context.signal.throwIfAborted();
        if (!output.success) throw new AssistantSkillResourceError('resource_unavailable');
        const result = JSON.stringify(output.data);
        if (redactInternalAgentText(result) !== result)
          throw new AssistantSkillResourceError('resource_unavailable');
        if (Buffer.byteLength(result) > MAX_SKILL_PROJECTION_BYTES)
          throw new AssistantSkillResourceError('skill_content_too_large');
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        const failure =
          error instanceof OperationError
            ? new AssistantSkillResourceError(
                error.code === 'invalid_request' || error.code === 'invalid_operation_input'
                  ? 'invalid_skill_read'
                  : error.code === 'workspace_access_denied' ||
                      error.code === 'bound_input_conflict' ||
                      error.code === 'core.auth.unauthenticated'
                    ? 'resource_access_denied'
                    : 'resource_unavailable'
              )
            : safeSkillFailure(error);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ code: failure.code, message: failure.message }),
            },
          ],
        };
      }
    },
  });
}

/** Applies catalog-read Policy, current Thread audience, and the exact nonterminal Turn admission. */
function assertCurrentSkillAuthority(scope: Omit<AssistantSkillAssemblyInput, 'skillIds'>): void {
  try {
    if (
      !authorizeWorkspace(scope.coreDb, scope.actor, scope.workspaceId, {
        mutating: false,
        policyOperation: 'workspace.read',
      }) ||
      !isThreadIdVisible(
        scope.store,
        scope.workspaceId,
        scope.threadId,
        scope.actor.userId,
        isCurrentDeploymentAdministrator(scope.coreDb, scope.actor)
      )
    )
      throw new AssistantSkillResourceError('resource_access_denied');
    const turn = scope.store.getTurn(scope.workspaceId, scope.threadId, scope.turnId);
    if (isSealedTurnTerminal(turn.status))
      throw new AssistantSkillResourceError('resource_access_denied');
  } catch {
    throw new AssistantSkillResourceError('resource_access_denied');
  }
}

/** Rejects snapshot or ancestor symlinks before the catalog walker can follow a redirected root. */
function assertSnapshotContained(dataRoot: string, snapshot: string): void {
  const within = relative(resolve(dataRoot), resolve(snapshot));
  if (!within || isAbsolute(within) || within.split(sep).includes('..'))
    throw new AssistantSkillResourceError('resource_unavailable');
  let current = resolve(dataRoot);
  for (const segment of within.split(sep)) {
    current = join(current, segment);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new AssistantSkillResourceError('resource_unavailable');
  }
  const canonical = relative(realpathSync(dataRoot), realpathSync(snapshot));
  if (!canonical || isAbsolute(canonical) || canonical.split(sep).includes('..'))
    throw new AssistantSkillResourceError('resource_unavailable');
}

/** Unknown filesystem/catalog failures never disclose paths, source text, or exception messages. */
function safeSkillFailure(error: unknown): AssistantSkillResourceError {
  if (error instanceof AssistantSkillResourceError) return error;
  return new AssistantSkillResourceError(
    error instanceof CatalogIntegrityError
      ? 'skill_content_integrity_failed'
      : 'resource_unavailable'
  );
}

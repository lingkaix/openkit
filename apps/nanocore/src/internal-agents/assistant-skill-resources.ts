import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  digestOpenKitTree,
  hashOpenKitTreeEntries,
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
import { loadWorkspaceResourceCatalog, skillSnapshotPath } from '../catalog/resource-catalog.js';
import type { FsStore } from '../lib/store.js';
import type { CoreDb } from '../storage/db.js';
import type { AgentTool, ToolExecutionContext } from './internal-agent-loop.js';

/** Complete UTF-8 model projections are bounded; instructions are never truncated. */
const MAX_SKILL_PROJECTION_BYTES = 64 * 1024;

/** Private fixed Skill read contract; caller authority is never model input. */
const SkillReadInputSchema = z
  .object({
    skillId: z.string().min(1),
    versionId: ResourceDigestSchema,
    contentDigest: ResourceDigestSchema,
    path: z.string().min(1).default('SKILL.md'),
  })
  .strict();

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
  readonly skillIds?: readonly string[];
}

/** Fixed metadata, existing-owner evidence input, and one on-demand read Tool. */
export interface AssistantSkillResources {
  readonly index: readonly AssistantSkillMetadata[];
  readonly admission: {
    /** No catalog observation is required when selection is empty. */
    readonly catalogRevision: number | null;
    readonly skills: readonly AssistantSkillMetadata[];
  };
  readonly tool: AgentTool;
}

/**
 * Assembles selected Skill metadata and an exact-snapshot read closure for an ordinary Assistant run.
 *
 * The ordinary entry supplies authored IDs once per run. Catalog presence grants no selection or authority, and resource text cannot enlarge the Tool set. Entry assembly retains admission through existing Turn/capability evidence and owns publication reauthorization; this factory persists no run or selection record.
 *
 * @param input Current authority, admitted conversation lineage, and selected Workspace identities.
 * @returns Immutable metadata and the fixed progressive read Tool.
 * @throws AssistantSkillResourceError when selected metadata or current authority is unavailable.
 */
export async function assembleAssistantSkillResources(
  input: AssistantSkillAssemblyInput
): Promise<AssistantSkillResources> {
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
  };
  const admitted = new Map<
    string,
    { metadata: AssistantSkillMetadata; version: SkillVersionRecord }
  >();
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
        if (!entry || entry.availability !== 'available' || !digest || !version)
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
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(SkillReadInputSchema, {
    io: 'input',
  });
  const tool: AgentTool = Object.freeze({
    name: 'skill.read',
    description:
      'Read one UTF-8 text file from an exact selected Skill. Loading text executes no code.',
    inputSchema,
    async execute(args: unknown, context: ToolExecutionContext) {
      context.signal.throwIfAborted();
      try {
        const parsed = SkillReadInputSchema.safeParse(args);
        if (!parsed.success) throw new AssistantSkillResourceError('invalid_skill_read');
        const { skillId, versionId, contentDigest, path } = parsed.data;
        const selected = admitted.get(skillId);
        if (
          !selected ||
          selected.metadata.versionId !== versionId ||
          selected.metadata.contentDigest !== contentDigest
        )
          throw new AssistantSkillResourceError('invalid_skill_read');
        // Reuse catalog path admission without opening any path supplied by the model.
        try {
          hashOpenKitTreeEntries([{ kind: 1, path, content: Buffer.alloc(0) }]);
        } catch {
          throw new AssistantSkillResourceError('invalid_skill_read');
        }
        const retainedFile = selected.version.inventory.find(
          (file) => file.path === path && file.kind === 'file'
        );
        if (!retainedFile?.sha256) throw new AssistantSkillResourceError('invalid_skill_read');
        assertCurrentSkillAuthority(scope);
        const current = loadWorkspaceResourceCatalog(scope.dataRoot, scope.workspaceId);
        const entry = current.skills.entries.find((item) => item.id === skillId);
        const version = current.skills.versions.find(
          (item) => item.entryId === skillId && item.digest === contentDigest
        );
        if (
          entry?.availability !== 'available' ||
          !version ||
          JSON.stringify(version.inventory) !== JSON.stringify(selected.version.inventory)
        )
          throw new AssistantSkillResourceError('resource_unavailable');
        // Default/pin changes affect later runs; removal and changed retained authority deny this read.
        const root = skillSnapshotPath(scope.dataRoot, scope.workspaceId, skillId, contentDigest);
        assertSnapshotContained(scope.dataRoot, root);
        assertSkillFileBounded(root, path);
        // Verify the complete immutable version, then return bytes from that same verified collection.
        const tree = digestOpenKitTree(root);
        if (tree.digest !== contentDigest)
          throw new AssistantSkillResourceError('skill_content_integrity_failed');
        const file = tree.entries.find((item) => item.path === path && item.kind !== 0);
        if (!file?.content) throw new AssistantSkillResourceError('resource_unavailable');
        const fileDigest = `sha256:${createHash('sha256').update(file.content).digest('hex')}`;
        if (
          fileDigest !== retainedFile.sha256 ||
          file.content.length !== retainedFile.size ||
          (file.kind === 2) !== retainedFile.executable
        )
          throw new AssistantSkillResourceError('skill_content_integrity_failed');
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
        const result = JSON.stringify({ skillId, versionId, path, fileDigest, text });
        if (Buffer.byteLength(result) > MAX_SKILL_PROJECTION_BYTES)
          throw new AssistantSkillResourceError('skill_content_too_large');
        context.signal.throwIfAborted();
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        const failure = safeSkillFailure(error);
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
  return Object.freeze({
    index,
    admission: Object.freeze({ catalogRevision, skills: index }),
    tool,
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

/** Checks each requested parent before leaf metadata so even the size check cannot follow a link. */
function assertSkillFileBounded(root: string, path: string): void {
  const segments = path.split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink())
      throw new AssistantSkillResourceError('skill_content_integrity_failed');
    if (index < segments.length - 1) {
      if (!entry.isDirectory())
        throw new AssistantSkillResourceError('skill_content_integrity_failed');
    } else {
      if (!entry.isFile()) throw new AssistantSkillResourceError('invalid_skill_read');
      if (entry.size > MAX_SKILL_PROJECTION_BYTES)
        throw new AssistantSkillResourceError('skill_content_too_large');
    }
  }
}

/** Unknown filesystem/catalog failures never disclose paths, source text, or exception messages. */
function safeSkillFailure(error: unknown): AssistantSkillResourceError {
  return error instanceof AssistantSkillResourceError
    ? error
    : new AssistantSkillResourceError('resource_unavailable');
}

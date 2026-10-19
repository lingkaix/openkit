import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CatalogTreeFileSchema } from '@openkit/app-api-schemas';
import {
  type ActorRef,
  ArtifactSchema,
  responsibleUserIdForActor,
  TurnSchema,
} from '@openkit/protocol';
import type { Actor } from './auth/identity.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isArtifactVisible } from './auth/thread-visibility.js';
import { type CatalogTreeFile, validateCatalogTree } from './catalog/resource-catalog.js';
import { type FsStore, quickChatWorkspaceIdForUser } from './lib/store.js';
import { readArtifactFileBytes } from './storage/artifacts/file-records.js';
import type { CoreDb } from './storage/db.js';

type Artifact = ReturnType<FsStore['getArtifact']>;

/** Bounds JSON framing and escaped paths as well as the independently bounded 16 MiB tree. */
export const MAX_SKILL_CANDIDATE_ARTIFACT_BYTES = 64 * 1024 * 1024;

/** Exact retained source selected by the candidate command in its addressed Workspace. */
export interface SkillCandidateArtifactSelection {
  /** Addressed Workspace; the command separately binds this to its destination. */
  readonly workspaceId: string;
  /** Existing Artifact identity, never a locator or host path. */
  readonly artifactId: string;
  /** Exact retained source version chosen by the caller. */
  readonly version: number;
  /** Expected original-byte digest, independently verified before decoding. */
  readonly contentDigest: string;
}

/** Validated candidate input and truthful source attribution; this grants no publication authority. */
export interface SkillCandidateArtifactInput {
  /** Complete proposed transport tree checked by the shared Catalog validator. */
  readonly tree: readonly CatalogTreeFile[];
  /** Existing openkit-tree-v1 identity; no parallel tree digest is introduced. */
  readonly digest: string;
  /** Original retained Artifact attribution, independent of submission authority. */
  readonly source: SkillCandidateArtifactSelection & { readonly origin: Artifact['origin'] };
  /** Provable selected-version producer, or null; never substitute the submitter. */
  readonly producer: ActorRef | null;
  /** Selected-version publication facts, absent for a direct import. */
  readonly producingTurn: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly agentId: string | null;
    readonly triggerActor: ActorRef;
  } | null;
  /** Current authenticated public caller; this is not Worker attribution. */
  readonly submitter: ActorRef;
}

/** Safe source-admission failure without retained bytes, locators or untrusted diagnostics. */
export class SkillCandidateArtifactError extends Error {
  /** HTTP projection for the existing native command error adapter. */
  public readonly status: number;

  /** Constructs one bounded source error. */
  public constructor(public readonly code: 'source_unavailable' | 'stale' | 'invalid_request') {
    super(
      code === 'stale'
        ? 'Selected Skill Artifact changed.'
        : code === 'invalid_request'
          ? 'Skill Artifact input is invalid.'
          : 'Skill Artifact is unavailable.'
    );
    this.name = 'SkillCandidateArtifactError';
    this.status = code === 'stale' ? 409 : code === 'invalid_request' ? 400 : 503;
  }
}

/** Checks current source and destination audiences without re-admitting retained candidate bytes. */
export function requireSkillCandidateArtifactAccess(input: {
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly actor: Actor;
  readonly selection: Pick<SkillCandidateArtifactSelection, 'workspaceId' | 'artifactId'>;
  readonly destination?: 'workspace-skill';
}): Artifact {
  try {
    if (
      !isWorkspaceOperationAuthorized(input.coreDb, input.actor, input.selection.workspaceId, {
        mutating: false,
        policyOperation: 'artifact.read',
      })
    )
      throw new SkillCandidateArtifactError('source_unavailable');
    const artifact = ArtifactSchema.parse(
      input.store.getArtifact(input.selection.workspaceId, input.selection.artifactId)
    );
    if (
      !isArtifactVisible(
        input.store,
        artifact,
        input.actor.userId,
        isCurrentDeploymentAdministrator(input.coreDb, input.actor)
      )
    ) {
      throw new SkillCandidateArtifactError('source_unavailable');
    }
    if (input.destination === 'workspace-skill' && artifact.origin.kind === 'turn-output') {
      const thread = input.store.getThread(input.selection.workspaceId, artifact.origin.threadId);
      const workspace = input.store.getWorkspace(input.selection.workspaceId);
      // Administrator readability does not disclose a private origin to shared supply.
      if (
        thread.visibility !== 'workspace' &&
        !(
          workspace.kind === 'personal' &&
          thread.privateOwnerUserId &&
          workspace.id === quickChatWorkspaceIdForUser(thread.privateOwnerUserId)
        )
      )
        throw new SkillCandidateArtifactError('source_unavailable');
    }
    return artifact;
  } catch (error) {
    if (error instanceof SkillCandidateArtifactError) throw error;
    throw new SkillCandidateArtifactError('source_unavailable');
  }
}

/**
 * Reads one exact authorized retained JSON Artifact without creating a version or candidate.
 * The native command must bind selection.workspaceId to its own addressed catalog Workspace.
 *
 * @param input Current native owners, authenticated public actor and exact source selection.
 * @returns Validated tree and retained provenance without publishing Catalog content.
 * @throws SkillCandidateArtifactError for unavailable, stale or malformed source input.
 */
export function readSkillCandidateArtifact(input: {
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly actor: Actor;
  readonly selection: SkillCandidateArtifactSelection;
  /** Native publication additionally checks the destination audience; source inspection grants no transfer. */
  readonly destination?: 'workspace-skill';
}): SkillCandidateArtifactInput {
  const selection = { ...input.selection };
  try {
    const readSelected = () => {
      if (
        !isWorkspaceOperationAuthorized(input.coreDb, input.actor, selection.workspaceId, {
          mutating: true,
          policyOperation: 'workspace.write',
        })
      )
        throw new SkillCandidateArtifactError('source_unavailable');
      const current = requireSkillCandidateArtifactAccess({ ...input, selection });
      if (selection.version > current.version) throw new SkillCandidateArtifactError('stale');
      const retained = input.store.getArtifactVersion(
        selection.workspaceId,
        selection.artifactId,
        selection.version
      );
      const { artifact } = retained;
      if (artifact.contentDigest !== selection.contentDigest)
        throw new SkillCandidateArtifactError('stale');
      if (
        artifact.content.format !== 'json' &&
        !(artifact.content.format === 'file' && artifact.content.mediaType === 'application/json')
      ) {
        throw new SkillCandidateArtifactError('source_unavailable');
      }
      return retained;
    };
    const selected = readSelected();
    const { artifact, version } = selected;
    let body: string;
    if (artifact.content.format === 'file') {
      if (artifact.content.byteLength > MAX_SKILL_CANDIDATE_ARTIFACT_BYTES)
        throw new SkillCandidateArtifactError('invalid_request');
      const bytes = readArtifactFileBytes({
        workspaceRoot: join(input.coreDb.dataRoot, 'workspaces', selection.workspaceId),
        artifactId: selection.artifactId,
        version: selection.version,
        byteLength: artifact.content.byteLength,
        contentDigest: selection.contentDigest,
        maximumBytes: MAX_SKILL_CANDIDATE_ARTIFACT_BYTES,
      });
      if (bytes === null) throw new SkillCandidateArtifactError('invalid_request');
      try {
        body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new SkillCandidateArtifactError('invalid_request');
      }
    } else body = artifact.content.body;
    if (Buffer.byteLength(body, 'utf8') > MAX_SKILL_CANDIDATE_ARTIFACT_BYTES) {
      throw new SkillCandidateArtifactError('invalid_request');
    }
    const contentDigest = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
    if (contentDigest !== artifact.contentDigest)
      throw new SkillCandidateArtifactError('source_unavailable');
    let tree: CatalogTreeFile[];
    let digest: string;
    try {
      // JSON cannot carry undefined: optional keys are absent or have their validated value.
      tree = CatalogTreeFileSchema.array().max(1024).parse(JSON.parse(body)) as CatalogTreeFile[];
      digest = validateCatalogTree(tree).digest;
    } catch {
      throw new SkillCandidateArtifactError('invalid_request');
    }
    let producer: ActorRef | null = null;
    let producingTurn: SkillCandidateArtifactInput['producingTurn'] = null;
    if (version.threadId === null || version.turnId === null) {
      producer = version.actor;
    } else {
      const turn = TurnSchema.parse(
        input.store.getTurn(selection.workspaceId, version.threadId, version.turnId)
      );
      producingTurn = {
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        agentId: turn.agentId ?? null,
        triggerActor: turn.triggerActor,
      };
      if (turn.agentId)
        producer = {
          kind: 'agent',
          id: turn.agentId,
          responsibleUserId: responsibleUserIdForActor(turn.triggerActor),
        };
      // Later manual revisions belong to their author, not the original Worker's Turn.
      else if (version.artifactVersion > 1) producer = version.actor;
    }
    const confirmed = readSelected();
    if (
      JSON.stringify(confirmed.artifact.content) !== JSON.stringify(artifact.content) ||
      JSON.stringify(confirmed.artifact.origin) !== JSON.stringify(artifact.origin) ||
      JSON.stringify(confirmed.version) !== JSON.stringify(version)
    ) {
      throw new SkillCandidateArtifactError('source_unavailable');
    }
    return {
      tree,
      digest,
      source: { ...selection, origin: artifact.origin },
      producer,
      producingTurn,
      submitter: { kind: 'user', id: input.actor.userId },
    };
  } catch (error) {
    if (error instanceof SkillCandidateArtifactError) throw error;
    throw new SkillCandidateArtifactError('source_unavailable');
  }
}

import { createHash } from 'node:crypto';
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
  /** Exact current source version chosen by the caller. */
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
  /** Provable original producer, or null; consumers must not substitute the submitter. */
  readonly producer: ActorRef | null;
  /** Actual producing work facts, absent for imported Artifacts. */
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
    const readCurrent = (): Artifact => {
      if (
        !isWorkspaceOperationAuthorized(input.coreDb, input.actor, selection.workspaceId, {
          mutating: true,
          policyOperation: 'workspace.write',
        })
      )
        throw new SkillCandidateArtifactError('source_unavailable');
      const artifact = requireSkillCandidateArtifactAccess({ ...input, selection });
      if (
        artifact.version !== selection.version ||
        artifact.contentDigest !== selection.contentDigest
      ) {
        throw new SkillCandidateArtifactError('stale');
      }
      if (artifact.content.format !== 'json') {
        throw new SkillCandidateArtifactError('source_unavailable');
      }
      return artifact;
    };
    const artifact = readCurrent();
    const body = artifact.content.body;
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
    if (artifact.origin.kind === 'imported') {
      producer = artifact.origin.actor;
    } else {
      const turn = TurnSchema.parse(
        input.store.getTurn(selection.workspaceId, artifact.origin.threadId, artifact.origin.turnId)
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
    }
    const current = readCurrent();
    if (
      current.content.body !== body ||
      JSON.stringify(current.origin) !== JSON.stringify(artifact.origin)
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

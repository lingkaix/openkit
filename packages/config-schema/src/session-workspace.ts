import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';

/** Worker-visible workspace slot kind. */
export const WorkspaceSlotKindSchema = z.enum([
  'worktree',
  'input',
  'data',
  'artifact-input',
  'output',
  'scratch',
  'session',
  'context',
  'instructions',
  'cache',
]);

/** Worker-visible workspace slot access. */
export const WorkspaceSlotAccessSchema = z.enum(['read-only', 'read-write']);

/** Worker-visible workspace slot retention. */
export const WorkspaceSlotRetentionSchema = z.enum(['turn', 'session', 'policy']);

/** Worker-visible workspace slot write-back behavior. */
export const WorkspaceSlotWriteBackSchema = z.enum([
  'discard',
  'artifact-only',
  'reviewed-change-set',
  'artifact-or-reviewed-change-set',
]);

/** Supported first-slice materialization modes. */
export const WorkspaceMaterializationModeSchema = z.enum([
  'bind',
  'copy',
  'upload',
  'rsync',
  'checkout',
  'fetch',
  'object-store-sync',
  'provider-file-sync',
  'gateway-read',
  'create-empty',
]);

/** Worker-visible workspace slot declaration. */
export const WorkspaceSlotSchema = z
  .object({
    id: z.string().min(1),
    kind: WorkspaceSlotKindSchema,
    path: z.string().min(1),
    access: WorkspaceSlotAccessSchema,
    allowedSourceKinds: z.array(z.string().min(1)).min(1),
    allowedMaterializationModes: z.array(WorkspaceMaterializationModeSchema).min(1),
    writeBack: WorkspaceSlotWriteBackSchema,
    retention: WorkspaceSlotRetentionSchema,
    lineageRequired: z.boolean(),
  })
  .strict();

/** Session-static worker workspace layout. */
export const SessionWorkspaceLayoutSchema = z
  .object({
    schemaVersion: z.literal(1),
    layoutId: z.string().min(1),
    root: z.string().min(1),
    workingDirectory: z.string().min(1),
    slots: z.array(WorkspaceSlotSchema).min(1),
    control: z
      .object({
        transcriptRoot: z.string().min(1),
        contextRoot: z.string().min(1),
        instructionsRoot: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((layout, ctx) => {
    const ids = new Set<string>();
    const paths = new Set<string>();

    for (const [index, slot] of layout.slots.entries()) {
      if (ids.has(slot.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate workspace slot id: ${slot.id}.`,
          path: ['slots', index, 'id'],
        });
      }
      ids.add(slot.id);

      const safePath = normalizeWorkerPath(slot.path);
      if (!safePath || !isAllowedWorkerPath(layout.root, safePath)) {
        ctx.addIssue({
          code: 'custom',
          message: `Workspace slot ${slot.id} path must stay inside the worker layout envelope.`,
          path: ['slots', index, 'path'],
        });
        continue;
      }

      if (paths.has(safePath)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate workspace slot path: ${safePath}.`,
          path: ['slots', index, 'path'],
        });
      }
      paths.add(safePath);
    }

    for (const [leftIndex, left] of layout.slots.entries()) {
      const leftPath = normalizeWorkerPath(left.path);
      if (!leftPath || left.access !== 'read-write') {
        continue;
      }

      for (const [rightIndex, right] of layout.slots.entries()) {
        if (leftIndex === rightIndex || right.access !== 'read-only') {
          continue;
        }

        const rightPath = normalizeWorkerPath(right.path);
        if (rightPath && isAncestorPath(leftPath, rightPath)) {
          ctx.addIssue({
            code: 'custom',
            message: `Writable slot ${left.id} must not contain read-only slot ${right.id}.`,
            path: ['slots', leftIndex, 'path'],
          });
        }
      }
    }
  });

/** Compatibility key for strict V1 agent-session reuse. */
export const SessionCompatibilityKeySchema = z
  .object({
    schemaVersion: z.literal(1),
    digest: z.string().min(1),
    algorithm: z.literal('sha256'),
  })
  .strict();

/** Turn-dynamic workspace materialization input binding. */
export const TurnWorkspaceMaterializationInputSchema = z
  .object({
    inputId: z.string().min(1),
    slotId: z.string().min(1),
    mode: WorkspaceMaterializationModeSchema,
    access: WorkspaceSlotAccessSchema,
  })
  .strict();

/** Turn-dynamic workspace materialization plan. */
export const TurnWorkspaceMaterializationSchema = z
  .object({
    schemaVersion: z.literal(1),
    materializationId: z.string().min(1),
    layoutId: z.string().min(1),
    selectedSlotIds: z.array(z.string().min(1)),
    inputs: z.array(TurnWorkspaceMaterializationInputSchema),
    outputSlotIds: z.array(z.string().min(1)),
  })
  .strict();

/** Parsed session-static worker workspace layout. */
export type SessionWorkspaceLayout = z.infer<typeof SessionWorkspaceLayoutSchema>;

/** Parsed worker-visible workspace slot declaration. */
export type WorkspaceSlot = z.infer<typeof WorkspaceSlotSchema>;

/** Parsed strict V1 session compatibility key. */
export type SessionCompatibilityKey = z.infer<typeof SessionCompatibilityKeySchema>;

/** Parsed turn-dynamic workspace materialization plan. */
export type TurnWorkspaceMaterialization = z.infer<typeof TurnWorkspaceMaterializationSchema>;

/** Existing session summary used by the pure planner. */
export interface ExistingSessionCompatibility {
  /** Existing agent-session id. */
  agentSessionId: string;
  /** Stored compatibility-key digest. */
  compatibilityKey: string;
  /** Current session availability. */
  status: 'idle' | 'running' | 'stale' | 'failed';
}

/** Minimal package shape needed for session workspace planning. */
export interface SessionWorkspacePlanningPackage {
  /** Package id used for deterministic record ids. */
  packageId?: string;
  /** Package snapshot id used for deterministic record ids. */
  snapshotId?: string;
  /** Durable Thread and Turn lineage for turn-scoped inputs. */
  scope?: {
    threadId?: string;
    turnId?: string;
  };
  /** Selected agent summary. */
  agent?: unknown;
  /** Runtime-static package section. */
  runtime?: unknown;
  /** Worker-visible workspace section. */
  workspace?: {
    root?: string;
    inputs?: Array<{
      id: string;
      kind: string;
      access: 'read-only' | 'read-write';
      source?: { kind?: string } & Record<string, unknown>;
      materialization?: Record<string, unknown> | undefined;
      target?: string | undefined;
    }>;
    outputs?: Array<{ id: string } & Record<string, unknown>>;
  };
  /** Worker control section. */
  control?: unknown;
  /** Provider section. */
  providers?: unknown;
  /** Vault section. */
  vault?: unknown;
  /** Policy section. */
  policy?: unknown;
  /** Backend requirements section. */
  backend?: unknown;
}

/** Workspace input shape consumed by the pure planner. */
type SessionWorkspacePlanningInput = NonNullable<
  NonNullable<SessionWorkspacePlanningPackage['workspace']>['inputs']
>[number];

/** Input for the pure session workspace planner. */
export interface PlanSessionWorkspaceMaterializationInput {
  /** Package-like static envelope to plan from. */
  environmentPackage: SessionWorkspacePlanningPackage;
  /** Optional existing session to evaluate for strict V1 reuse. */
  existingSession?: ExistingSessionCompatibility;
}

/** Pure planner result for one package and optional existing session. */
export interface SessionWorkspaceMaterializationPlan {
  /** Session-static layout. */
  layout: SessionWorkspaceLayout;
  /** Strict V1 compatibility key. */
  compatibilityKey: SessionCompatibilityKey;
  /** Turn-dynamic materialization plan. */
  materialization: TurnWorkspaceMaterialization;
  /** Reuse decision. */
  decision:
    | { kind: 'create' }
    | { kind: 'reuse'; agentSessionId: string }
    | { kind: 'replace'; reason: string };
}

/**
 * Plans the first reusable session workspace layout and turn materialization.
 *
 * @param input Package-like static envelope plus optional existing session.
 * @returns Layout, strict compatibility key, materialization plan, and reuse decision.
 */
export function planSessionWorkspaceMaterialization(
  input: PlanSessionWorkspaceMaterializationInput
): SessionWorkspaceMaterializationPlan {
  const layout = createDefaultSessionWorkspaceLayout(input.environmentPackage);
  const compatibilityKey = computeSessionCompatibilityKey(layout, input.environmentPackage);
  const materialization = TurnWorkspaceMaterializationSchema.parse({
    schemaVersion: 1,
    materializationId: `twm_${safeId(input.environmentPackage.snapshotId ?? 'default')}`,
    layoutId: layout.layoutId,
    selectedSlotIds: layout.slots.map((slot) => slot.id),
    inputs: (input.environmentPackage.workspace?.inputs ?? []).map((workspaceInput) => {
      const slot = selectSlotForInput(layout, workspaceInput, input.environmentPackage.scope);

      return {
        inputId: workspaceInput.id,
        slotId: slot.id,
        mode: selectModeForInput(workspaceInput),
        access: workspaceInput.access,
      };
    }),
    outputSlotIds:
      (input.environmentPackage.workspace?.outputs ?? []).length > 0 ? ['turn-output'] : [],
  });

  return {
    compatibilityKey,
    decision: selectSessionDecision(input.existingSession, compatibilityKey),
    layout,
    materialization,
  };
}

/**
 * Computes the strict V1 session compatibility key.
 *
 * @param layout Session-static layout.
 * @param environmentPackage Package-like static envelope.
 * @returns Compatibility key digest and algorithm.
 */
export function computeSessionCompatibilityKey(
  layout: SessionWorkspaceLayout,
  environmentPackage: SessionWorkspacePlanningPackage
): SessionCompatibilityKey {
  return SessionCompatibilityKeySchema.parse({
    schemaVersion: 1,
    algorithm: 'sha256',
    digest: `sha256:${createHash('sha256')
      .update(
        stableJson({
          agent: environmentPackage.agent ?? null,
          backend: environmentPackage.backend ?? null,
          control: environmentPackage.control ?? null,
          layout,
          policy: environmentPackage.policy ?? null,
          providers: environmentPackage.providers ?? null,
          runtime: environmentPackage.runtime ?? null,
          vault: environmentPackage.vault ?? null,
        })
      )
      .digest('hex')}`,
  });
}

/**
 * Creates the default reusable worker filesystem layout.
 *
 * @param environmentPackage Package-like static envelope.
 * @returns Parsed default layout.
 */
function createDefaultSessionWorkspaceLayout(
  environmentPackage: SessionWorkspacePlanningPackage
): SessionWorkspaceLayout {
  const root = environmentPackage.workspace?.root ?? '/workspace';

  return SessionWorkspaceLayoutSchema.parse({
    schemaVersion: 1,
    layoutId: `swl_${safeId(root)}`,
    root,
    workingDirectory: root,
    slots: [
      slot(
        'main-worktree',
        'worktree',
        `${root}/worktrees/main`,
        'read-write',
        ['git', 'workspace-dir'],
        ['checkout', 'fetch', 'bind', 'copy', 'upload', 'rsync'],
        'reviewed-change-set',
        'session'
      ),
      slot(
        'turn-inputs',
        'input',
        `${root}/inputs`,
        'read-only',
        [
          'workspace-file',
          'workspace-dir',
          'generated',
          'openkit-artifact',
          'openkit-upload',
          'http-archive',
        ],
        ['copy', 'upload', 'rsync'],
        'discard',
        'turn'
      ),
      slot(
        'external-data',
        'data',
        `${root}/data`,
        'read-only',
        ['s3', 'r2', 'gcs', 'azure-blob', 'box', 's3-files'],
        ['object-store-sync', 'provider-file-sync', 'gateway-read'],
        'artifact-only',
        'policy'
      ),
      slot(
        'artifact-input',
        'artifact-input',
        `${root}/artifacts/in`,
        'read-only',
        ['openkit-artifact'],
        ['copy', 'upload', 'rsync'],
        'discard',
        'turn'
      ),
      slot(
        'turn-output',
        'output',
        `${root}/outputs`,
        'read-write',
        ['generated'],
        ['create-empty'],
        'artifact-or-reviewed-change-set',
        'turn',
        false
      ),
      slot(
        'scratch',
        'scratch',
        `${root}/scratch`,
        'read-write',
        ['generated'],
        ['create-empty'],
        'discard',
        'turn',
        false
      ),
      slot(
        'session',
        'session',
        '/openkit/session',
        'read-write',
        ['generated'],
        ['create-empty'],
        'artifact-only',
        'session',
        false
      ),
      slot(
        'context',
        'context',
        '/openkit/context',
        'read-only',
        ['generated'],
        ['copy', 'upload'],
        'discard',
        'turn'
      ),
      slot(
        'instructions',
        'instructions',
        '/openkit/instructions',
        'read-only',
        ['generated'],
        ['copy', 'upload'],
        'discard',
        'session'
      ),
      slot(
        'cache',
        'cache',
        `${root}/.openkit/cache`,
        'read-write',
        ['generated'],
        ['create-empty'],
        'discard',
        'policy',
        false
      ),
    ],
    control: {
      transcriptRoot: '/openkit/session',
      contextRoot: '/openkit/context',
      instructionsRoot: '/openkit/instructions',
    },
  });
}

/**
 * Creates one workspace slot declaration.
 *
 * @returns Workspace slot declaration.
 */
function slot(
  id: WorkspaceSlot['id'],
  kind: WorkspaceSlot['kind'],
  path: WorkspaceSlot['path'],
  access: WorkspaceSlot['access'],
  allowedSourceKinds: WorkspaceSlot['allowedSourceKinds'],
  allowedMaterializationModes: WorkspaceSlot['allowedMaterializationModes'],
  writeBack: WorkspaceSlot['writeBack'],
  retention: WorkspaceSlot['retention'],
  lineageRequired = true
): WorkspaceSlot {
  return {
    access,
    allowedMaterializationModes,
    allowedSourceKinds,
    id,
    kind,
    lineageRequired,
    path,
    retention,
    writeBack,
  };
}

/**
 * Selects the slot that should receive one workspace input.
 *
 * @param layout Session workspace layout.
 * @param workspaceInput Workspace input declaration.
 * @param scope Durable package lineage used to validate turn-scoped inputs.
 * @returns Compatible slot.
 */
function selectSlotForInput(
  layout: SessionWorkspaceLayout,
  workspaceInput: SessionWorkspacePlanningInput,
  scope: SessionWorkspacePlanningPackage['scope']
): WorkspaceSlot {
  const requestedSlotId = workspaceInput.materialization?.slotId;
  if (requestedSlotId === 'context' && isDedicatedContextPackageInput(workspaceInput, scope)) {
    const contextSlot = layout.slots.find((candidate) => candidate.id === 'context');
    if (!contextSlot) {
      throw new Error(`No context workspace slot found for input ${workspaceInput.id}.`);
    }
    return contextSlot;
  }
  if (requestedSlotId !== undefined && requestedSlotId !== 'context') {
    throw new Error(`Unsupported explicit workspace slot for input ${workspaceInput.id}.`);
  }
  const slotId =
    workspaceInput.kind === 'repository' ||
    (workspaceInput.kind === 'directory' && workspaceInput.access === 'read-write')
      ? 'main-worktree'
      : workspaceInput.kind === 'object-store'
        ? 'external-data'
        : workspaceInput.kind === 'artifact'
          ? 'artifact-input'
          : 'turn-inputs';
  const slot = layout.slots.find((candidate) => candidate.id === slotId);

  if (!slot) {
    throw new Error(`No compatible workspace slot found for input ${workspaceInput.id}.`);
  }

  return slot;
}

/**
 * Returns whether one generated input is the exact immutable S39 Context Package tuple.
 *
 * @param workspaceInput Workspace input considered by the session planner.
 * @param scope Durable package lineage that the input must match exactly.
 * @returns True only for the dedicated Context Package input.
 */
function isDedicatedContextPackageInput(
  workspaceInput: SessionWorkspacePlanningInput,
  scope: SessionWorkspacePlanningPackage['scope']
): boolean {
  const materialization = workspaceInput.materialization;
  const source = workspaceInput.source;

  return (
    typeof scope?.threadId === 'string' &&
    typeof scope.turnId === 'string' &&
    workspaceInput.kind === 'generated' &&
    workspaceInput.access === 'read-only' &&
    workspaceInput.target === '/openkit/context' &&
    !('mount' in workspaceInput) &&
    source?.kind === 'generated' &&
    source.pathRef === `threads/${scope.threadId}/turns/${scope.turnId}/context-package` &&
    Object.keys(source).sort().join(',') === 'kind,pathRef' &&
    workspaceInput.id === `context_${scope.turnId}` &&
    materialization?.strategy === 'filesystem' &&
    typeof materialization.contentDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(materialization.contentDigest) &&
    materialization.slotId === 'context' &&
    Object.keys(materialization).sort().join(',') === 'contentDigest,slotId,strategy'
  );
}

/**
 * Selects the first materialization mode for one workspace input.
 *
 * @param workspaceInput Workspace input declaration.
 * @returns Materialization mode.
 */
function selectModeForInput(
  workspaceInput: SessionWorkspacePlanningInput
): z.infer<typeof WorkspaceMaterializationModeSchema> {
  if (workspaceInput.kind === 'repository') {
    return 'checkout';
  }

  if (workspaceInput.kind === 'object-store') {
    return 'object-store-sync';
  }

  return 'copy';
}

/**
 * Selects the strict V1 reuse decision.
 *
 * @param existingSession Existing session summary.
 * @param compatibilityKey Newly computed compatibility key.
 * @returns Session reuse decision.
 */
function selectSessionDecision(
  existingSession: ExistingSessionCompatibility | undefined,
  compatibilityKey: SessionCompatibilityKey
): SessionWorkspaceMaterializationPlan['decision'] {
  if (!existingSession) {
    return { kind: 'create' };
  }

  if (existingSession.status !== 'idle') {
    return { kind: 'replace', reason: `session-${existingSession.status}` };
  }

  if (existingSession.compatibilityKey !== compatibilityKey.digest) {
    return { kind: 'replace', reason: 'session-compatibility-key-mismatch' };
  }

  return { kind: 'reuse', agentSessionId: existingSession.agentSessionId };
}

/**
 * Normalizes one worker path.
 *
 * @param value Worker path.
 * @returns Normalized absolute path or null when unsafe.
 */
function normalizeWorkerPath(value: string): string | null {
  if (!value.startsWith('/') || value.includes('\\')) {
    return null;
  }

  const normalized = posix.normalize(value);

  if (normalized === '/' || normalized.includes('/../') || normalized === '/..') {
    return null;
  }

  return normalized;
}

/**
 * Checks whether a worker path is inside the public worker envelope.
 *
 * @param root Workspace root.
 * @param path Worker path.
 * @returns True when the path is allowed.
 */
function isAllowedWorkerPath(root: string, path: string): boolean {
  return (
    path === root ||
    isAncestorPath(root, path) ||
    path === '/openkit' ||
    isAncestorPath('/openkit', path)
  );
}

/**
 * Checks whether a parent path contains a child path.
 *
 * @param parent Candidate parent.
 * @param child Candidate child.
 * @returns True when parent contains child.
 */
function isAncestorPath(parent: string, child: string): boolean {
  const relative = posix.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !posix.isAbsolute(relative);
}

/**
 * Converts an arbitrary id seed into a stable record-id suffix.
 *
 * @param value Raw id seed.
 * @returns Safe id suffix.
 */
function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Stable JSON stringifier for compatibility-key hashing.
 *
 * @param value Value to stringify.
 * @returns Stable JSON representation.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(',')}}`;
}

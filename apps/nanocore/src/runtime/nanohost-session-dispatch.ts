import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  AgentEnvironmentDockerfileInputSchema,
  DOCKERFILE_INPUT_MAX_BYTES,
} from '@openkit/config-schema';
import type { Context, Hono } from 'hono';
import { createScanner } from 'jsonc-parser';
import { asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  isNanoHostPhysicalConnectionContext,
  type NanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { OperationError } from '../operation-error.js';
import type { CoreDb } from '../storage/db.js';
import {
  createNanoHostEffectRequest,
  nanoHostSandboxIdFromBackendSessionId,
} from './nanohost-effect-identity.js';
import {
  dispatchNanoHostHarnessOperation,
  markNanoHostHarnessOperationUnknown,
  type NanoHostHarnessCommand,
  type NanoHostHarnessResult,
  settleNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import {
  getNanoHostRuntimeTarget,
  requireNanoHostPhysicalEpoch,
  requireStoredNanoHostPhysicalEpoch,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import { listWorkerBackendSessions } from './worker-backend-sessions.js';
import { WorkerSandboxPolicyIntentSchema } from './worker-governance-backend.js';
import {
  readWorkerImageSettlement,
  type WorkerImageSettlement,
  WorkerImageSettlementConflict,
  WorkerImageSettlementDeferred,
  type WorkerImageSettlementIdentity,
  WorkerImageSettlementIdentitySchema,
  WorkerImageSettlementSchema,
  writeWorkerImageSettlement,
} from './worker-image-settlements.js';

import {
  admitWorkspaceCollectJsonResult,
  sameWorkspaceSnapshot,
  WorkspaceCollectCommandSchema,
  WorkspaceSnapshotPairSchema,
} from './workspace-collect-wire.js';

const CONTROL_BODY_MAX_BYTES = 1024 * 1024;
/** Exact outer-session inference request ceiling preserved from its semantic owner. */
const INFERENCE_BODY_MAX_BYTES = 2 * 1024 * 1024;
/** Per-request capability body ceiling, independent of the family DATA reservation. */
const CAPABILITY_BODY_MAX_BYTES = 512 * 1024;
/** Exact V1 maximum for one file-data body. */
const FILE_DATA_MAX_BYTES = 256 * 1024 * 1024;
/** Maximum application write or consumption release for file data. */
const FILE_DATA_CHUNK_BYTES = 64 * 1024;
/** Sole media type accepted on the two raw file-data directions. */
const FILE_DATA_CONTENT_TYPE = 'application/octet-stream';
/** Exact fixed metadata header names shared by import and export. */
const FILE_DATA_HEADERS = {
  byteLength: 'x-openkit-byte-length',
  relativePath: 'x-openkit-relative-path',
  requestId: 'x-openkit-request-id',
  sha256: 'x-openkit-sha256',
  slot: 'x-openkit-slot',
} as const;
const INTEGRATION_BINDING_HEADER = 'x-openkit-integration-binding';
const HARNESS_POLL_PATH = '/worker-control/harness/poll';
const HARNESS_RESULT_PATH = '/worker-control/harness/result';

/** Closed NanoHost-owned runtime effect vocabulary. */
export const NANO_HOST_EFFECT_OPERATIONS = [
  'sandbox.create',
  'sandbox.delete',
  'bridge.open',
  'bridge.close',
  'image.acquire',
  'image.build',
  'image.inspect',
  'storage.inspect',
  'storage.purge',
  'file.export',
  'reference.import',
  'workspace.collect',
] as const;

/** Complete owned key set for the authority-bearing sandbox create instruction. */
const SANDBOX_CREATE_INPUT_KEYS = [
  'backendSessionId',
  'environment',
  'imageDigest',
  'leaseId',
  'packageSnapshotId',
  'policyIntent',
  'requestId',
  'sandboxId',
  'storage',
] as const;

/** One fixed NanoHost-owned runtime effect operation. */
export type NanoHostEffectOperation = (typeof NANO_HOST_EFFECT_OPERATIONS)[number];

/** Exact private command/result paths for the closed NanoHost effect vocabulary. */
const NANO_HOST_EFFECT_PATHS = {
  'workspace.collect': {
    command: '/api/nanohost/transport/effects/workspace.collect',
    result: '/api/nanohost/transport/effects/workspace.collect/result',
  },
  'bridge.close': {
    command: '/api/nanohost/transport/effects/bridge.close',
    result: '/api/nanohost/transport/effects/bridge.close/result',
  },
  'bridge.open': {
    command: '/api/nanohost/transport/effects/bridge.open',
    result: '/api/nanohost/transport/effects/bridge.open/result',
  },
  'file.export': {
    command: '/api/nanohost/transport/effects/file.export',
    result: '/api/nanohost/transport/effects/file.export/result',
  },
  'image.acquire': {
    command: '/api/nanohost/transport/effects/image.acquire',
    result: '/api/nanohost/transport/effects/image.acquire/result',
  },
  'image.build': {
    command: '/api/nanohost/transport/effects/image.build',
    result: '/api/nanohost/transport/effects/image.build/result',
  },
  'image.inspect': {
    command: '/api/nanohost/transport/effects/image.inspect',
    result: '/api/nanohost/transport/effects/image.inspect/result',
  },
  'reference.import': {
    command: '/api/nanohost/transport/effects/reference.import',
    result: '/api/nanohost/transport/effects/reference.import/result',
  },
  'sandbox.create': {
    command: '/api/nanohost/transport/effects/sandbox.create',
    result: '/api/nanohost/transport/effects/sandbox.create/result',
  },
  'sandbox.delete': {
    command: '/api/nanohost/transport/effects/sandbox.delete',
    result: '/api/nanohost/transport/effects/sandbox.delete/result',
  },
  'storage.inspect': {
    command: '/api/nanohost/transport/effects/storage.inspect',
    result: '/api/nanohost/transport/effects/storage.inspect/result',
  },
  'storage.purge': {
    command: '/api/nanohost/transport/effects/storage.purge',
    result: '/api/nanohost/transport/effects/storage.purge/result',
  },
} as const satisfies Record<
  NanoHostEffectOperation,
  { readonly command: string; readonly result: string }
>;

/** Route families carried by one authoritative NanoHost session. */
export type NanoHostSessionRouteFamily = 'capability' | 'inference' | 'worker-control';

/** One bounded semantic route request carried by NanoHost. */
export interface NanoHostSessionRouteRequest {
  readonly body: Uint8Array;
  readonly credentialClass: NanoHostSessionRouteFamily | 'harness';
  readonly family: NanoHostSessionRouteFamily;
  readonly path: string;
}

/** One NanoHost-owned runtime effect request. */
export interface NanoHostSessionEffectRequest {
  /** Private preparation lineage; never copied into a command body. */
  readonly imageSettlement?: WorkerImageSettlementIdentity;
  /** Process-private live capture cancellation; never hashed or carried on the wire. */
  readonly signal?: AbortSignal | undefined;
  readonly input: Readonly<Record<string, unknown>>;
  readonly kind: NanoHostEffectOperation | string;
  /** Deterministic opaque effect identity produced from durable attempt lineage. */
  readonly requestId?: string;
}

/** One exact accepted cleanup identity reconstructed without replay authority. */
interface NanoHostCleanupResultOnlyExpectation {
  readonly imageSettlement?: never;
  readonly kind: 'bridge.close' | 'sandbox.delete';
  /** Immutable origin of the physical cleanup target. */
  readonly originPhysicalEpoch: string;
  readonly requestId: string;
}

/** One exact accepted preparation-image identity reconstructed without replay authority. */
interface NanoHostImageResultOnlyExpectation {
  /** Immutable provenance reconstructed from the authored preparation candidate. */
  readonly imageSettlement?: WorkerImageSettlementIdentity;
  readonly kind: 'image.acquire' | 'image.build';
  readonly originPhysicalEpoch?: never;
  readonly requestId: string;
}

/** One exact accepted effect identity reconstructed without replay authority. */
export type NanoHostResultOnlyExpectation =
  | NanoHostCleanupResultOnlyExpectation
  | NanoHostImageResultOnlyExpectation;

/** One exact retained result matched to its reconstructed effect identity. */
export interface NanoHostResultOnlySettlement {
  readonly kind: NanoHostResultOnlyExpectation['kind'];
  readonly result: unknown;
}

/** Dependencies for authoritative session dispatch. */
export interface CreateNanoHostSessionDispatchInput {
  /** Existing server database used for preparation-image settlement and cleaned-delete correlation. */
  readonly coreDb?: CoreDb | undefined;
  /** Optional direct handler used by lower-level dispatcher checks. */
  readonly effectHandler?: (request: NanoHostSessionEffectRequest) => Promise<unknown>;
  /** Optional semantic-route handler used by the shared outer session. */
  readonly routeHandler?: (request: NanoHostSessionRouteRequest) => Promise<unknown>;
  readonly sessionAuthority: NanoHostTransportSessionAuthority;
}

/** Stable configured target binding used to recheck durable readiness at effect carriage. */
interface NanoHostReadinessRuntimeTarget {
  readonly coreDb: CoreDb;
  readonly deploymentId: string;
  readonly identityId: string;
  readonly targetId: string;
}

/** Authoritative NanoHost route and effect dispatcher. */
export interface NanoHostSessionDispatch {
  /** Queues one fixed NanoHost effect for the authoritative client to poll. */
  effect(request: NanoHostSessionEffectRequest): Promise<unknown>;
  /** Dispatches one already-carried effect after checking the physical connection. */
  effect(physicalConnection: object, request: NanoHostSessionEffectRequest): Promise<unknown>;
  /** Awaits one retained result without storing or dispatching its command. */
  expectResultOnly?(
    expectations: readonly NanoHostResultOnlyExpectation[]
  ): Promise<NanoHostResultOnlySettlement>;
  /** Polls one fixed operation path on the authoritative physical connection. */
  poll(
    physicalConnection: object,
    operation: NanoHostEffectOperation
  ): Promise<Record<string, unknown> | null>;
  /** Accepts one correlated success or exact typed failure on its fixed operation path. */
  result(
    physicalConnection: object,
    operation: NanoHostEffectOperation,
    result: Readonly<Record<string, unknown>>
  ): Promise<void>;
  /** Accepts one raw correlated file export on its fixed result path. */
  fileExportResult(physicalConnection: object, request: Request): Promise<void>;
  /** Admits one candidate bound to the exact pending snapshot-chain command. */
  workspaceCollectResult(physicalConnection: object, request: Request): Promise<void>;
  /** Clears an unknown collection delivery and its private check values on the exact connection. */
  beginWorkspaceCollectionDelivery?(physicalConnection: object): {
    abandon: () => void;
    signal: AbortSignal | undefined;
  };
  /** Returns one accepted image build's exact retained Dockerfile bytes once. */
  imageBuildInput(
    physicalConnection: object,
    request: Request
  ): Promise<{
    readonly body: Buffer;
    readonly byteLength: number;
    readonly requestId: string;
    readonly sha256: string;
  }>;
  /**
   * Projects readiness for one exact authoritative native connection generation.
   *
   * @param physicalConnection Opaque native HTTP/2 session identity.
   * @param body Exact readiness request bytes.
   * @param runtimeTarget Existing durable target and configured identity binding.
   * @returns Completion after the durable projection commits.
   * @throws Error when carriage, authority, body, configuration, or durable projection fails.
   */
  readiness?(
    physicalConnection: object,
    body: Uint8Array,
    runtimeTarget?: NanoHostReadinessRuntimeTarget
  ): Promise<void>;
  /** Dispatches one existing semantic route on the current generation. */
  route(physicalConnection: object, request: NanoHostSessionRouteRequest): Promise<unknown>;
}

/** One process-local pending effect owned by the dispatcher. */
interface PendingNanoHostEffect {
  /** Caller has left; accepted file results remain owned solely for verified disposal. */
  fileExportAbandoned?: boolean;
  fileExportWaitCleanup?: () => void;
  collectionTimeout?: ReturnType<typeof setTimeout>;
  collectionDeliveryStarted?: boolean;
  collectionAbort?: AbortController | undefined;
  imageSettlement?: WorkerImageSettlementIdentity;
  imageSettlementDeferred?: boolean;
  acceptedConnection?: object;
  command: Readonly<Record<string, unknown>> | null;
  /** Rejects the existing caller promise for one acknowledged definite failure. */
  readonly reject: (error: Error) => void;
  readonly requestId: string;
  readonly resolve: (result: unknown) => void;
  accepted: boolean;
  imageBuildInputServed?: boolean;
  /** Physical Epoch current when this command entered the dispatch queue. */
  originPhysicalEpoch?: string;
  resultOnlyGroup?: NanoHostResultOnlyGroup;
}

/** Process-local correlation shared by one bounded result-only expectation set. */
interface NanoHostResultOnlyGroup {
  readonly expectations: readonly NanoHostResultOnlyExpectation[];
}

/** One bounded completed result retained for exact duplicate recognition. */
interface CompletedNanoHostEffect {
  readonly requestId: string;
  readonly resultJson: string;
  readonly fileResult?: NanoHostFileResultIdentity;
  redeliveredConnection?: object;
}

/** Exact immutable identity of one completely verified raw file result. */
interface NanoHostFileResultIdentity {
  readonly byteLength: number;
  readonly relativePath: string;
  readonly sha256: string;
  readonly slot: string;
}

/** Dependencies for registering the private fixed effect routes. */
export interface RegisterNanoHostSessionEffectRoutesInput {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly dispatch: NanoHostSessionDispatch;
}

/** Dependencies for readiness and semantic projections outside the public route inventory. */
export interface RegisterNanoHostSessionSemanticRoutesInput {
  /** Hono app receiving private native-session carriage. */
  readonly app: Hono<{ Variables: AuthVariables }>;
  /** Existing Core database that owns RuntimeTarget readiness. */
  readonly coreDb?: CoreDb;
  /** Dispatcher shared with effect producers and native transport routes. */
  readonly dispatch: NanoHostSessionDispatch;
  /** Live runtime owner that binds dispatch-time Turn credentials before carriage. */
  readonly harnessCommandDispatched?:
    | ((command: NanoHostHarnessCommand) => NanoHostHarnessCommand)
    | undefined;
  /** Live runtime owner that advances the exact settled Harness operation. */
  readonly harnessResultSettled?: ((result: NanoHostHarnessResult) => void) | undefined;
  /** Releases the exact live waiter into cleanup after incomplete-delivery fencing or storage failure. */
  readonly harnessCommandDeliveryFailed?:
    | ((
        command: Pick<NanoHostHarnessCommand, 'harnessInstanceId' | 'operationId'>,
        failure?: unknown
      ) => void)
    | undefined;
  /** Configured target identity and deployment checked against durable allocation. */
  readonly nanoHostConfig?: {
    readonly deploymentId: string;
    readonly identityId: string;
  };
}

/**
 * Creates the direct outer-session dispatcher for existing semantic routes and NanoHost effects.
 *
 * @param input Existing handlers and session authority.
 * @returns Fail-closed generation-bound dispatcher.
 */
export function createNanoHostSessionDispatch(
  input: CreateNanoHostSessionDispatchInput
): NanoHostSessionDispatch {
  const pendingEffects = new Map<NanoHostEffectOperation, PendingNanoHostEffect>();
  const completedEffects = new Map<NanoHostEffectOperation, CompletedNanoHostEffect>();
  const readyPhysicalConnections = new WeakMap<
    object,
    {
      readonly connectionGeneration: number;
      readonly physicalEpoch: string;
      readonly runtimeTarget: NanoHostReadinessRuntimeTarget;
    }
  >();
  // A completed poll distinguishes a live connection from a poll-first successor.
  const completedEffectPollConnections = new WeakSet<object>();
  let currentReadiness: {
    readonly connectionGeneration: number;
    readonly physicalEpoch: string;
    readonly runtimeTarget: NanoHostReadinessRuntimeTarget;
  } | null = null;

  /** Rechecks one process-local readiness observation against its durable current owner. */
  const requireCurrentReadiness = (readiness: NonNullable<typeof currentReadiness>): string => {
    const target = getNanoHostRuntimeTarget(
      readiness.runtimeTarget.coreDb,
      readiness.runtimeTarget.targetId
    );
    if (
      !target ||
      target.identityId !== readiness.runtimeTarget.identityId ||
      target.deploymentId !== readiness.runtimeTarget.deploymentId ||
      target.connectionGeneration !== readiness.connectionGeneration ||
      !target.predecessorFenced ||
      !target.ready ||
      !target.freshEmpty ||
      target.physicalEpoch !== readiness.physicalEpoch
    ) {
      throw new Error('NanoHost effect dispatch has no current physical Epoch authority.');
    }
    return readiness.physicalEpoch;
  };

  /** Checks disposal eligibility only; cleaned state is not proof of prior dispatch or settlement. */
  const canDiscardCleanedDeleteResult = (
    physicalConnection: object,
    requestId: string,
    result: Readonly<Record<string, unknown>>
  ): boolean => {
    const coreDb = input.coreDb;
    const readiness = readyPhysicalConnections.get(physicalConnection);
    if (
      !coreDb ||
      !readiness ||
      readiness.runtimeTarget.coreDb !== coreDb ||
      !/^[0-9a-f]{64}$/.test(requestId) ||
      typeof result.sandboxId !== 'string' ||
      result.state !== 'deleted'
    )
      return false;
    requireCurrentReadiness(readiness);
    const matches = listWorkerBackendSessions(coreDb).filter((row) => {
      if (
        row.backendKind !== 'openshell' ||
        row.deploymentId !== readiness.runtimeTarget.deploymentId ||
        row.runtimeTargetId !== readiness.runtimeTarget.targetId
      )
        return false;
      if (!row.attemptId.trim() || !row.packageSnapshotId.trim()) {
        throw effectTransportError(409, 'NanoHost delete correlation lineage is incomplete.');
      }
      const sandboxId = nanoHostSandboxIdFromBackendSessionId(row.backendSessionId);
      return (
        sandboxId === result.sandboxId &&
        createNanoHostEffectRequest(row, row.attemptId, 'sandbox.delete', {
          attemptId: row.attemptId,
          sandboxId,
        }).requestId === requestId
      );
    });
    return (
      matches.length === 1 &&
      (matches[0]!.state === 'physical-cleaned' || matches[0]!.state === 'cleaned')
    );
  };

  return {
    effect(
      requestOrConnection: object | NanoHostSessionEffectRequest,
      carriedRequest?: NanoHostSessionEffectRequest
    ) {
      const effectPromise = (async () => {
        if (carriedRequest) {
          requireAuthoritativeSession(input.sessionAuthority, requestOrConnection);
          requireEffectRequest(carriedRequest);
          if (!input.effectHandler) {
            throw new Error('NanoHost direct effect handler is not configured.');
          }
          return input.effectHandler(carriedRequest);
        }

        const request = requestOrConnection as NanoHostSessionEffectRequest;
        const { operation, requestId } = requireEffectRequest(request);
        if (request.imageSettlement) {
          WorkerImageSettlementIdentitySchema.parse(request.imageSettlement);
          if (!input.coreDb || !['image.acquire', 'image.build'].includes(operation)) {
            throw new Error('Preparation image settlement is unavailable for this effect.');
          }
          const known = readWorkerImageSettlement(input.coreDb, requestId);
          if (known)
            return settledImageResult(known, request.imageSettlement, requestId, operation);
        }
        let command: Readonly<Record<string, unknown>>;
        if (operation === 'reference.import') {
          command = requireReferenceImportCommand(request.input, requestId);
        } else if (operation === 'image.build') {
          command = requireImageBuildCommand(request.input, requestId);
        } else if (operation === 'bridge.open') {
          command = requireBridgeOpenCommand(request.input, requestId);
        } else if (operation === 'workspace.collect') {
          command = WorkspaceCollectCommandSchema.parse({ ...request.input, requestId });
          if (Buffer.byteLength(JSON.stringify(command)) > 512 * 1024)
            throw effectTransportError(413, 'Workspace collection command is too large.');
        } else if (operation === 'file.export') {
          command = requireFileExportCommand(request.input, requestId);
        } else if (operation === 'image.inspect') {
          command = requireImageInspectCommand(request.input, requestId);
        } else if (operation === 'storage.inspect' || operation === 'storage.purge') {
          command = requireStorageCommand(request.input, requestId);
        } else {
          const allowed: readonly string[] =
            operation === 'sandbox.create'
              ? SANDBOX_CREATE_INPUT_KEYS
              : operation === 'image.acquire'
                ? [
                    'backendSessionId',
                    'imageReference',
                    'leaseId',
                    'packageSnapshotId',
                    'requestId',
                  ]
                : ['backendSessionId', 'leaseId', 'packageSnapshotId', 'requestId', 'sandboxId'];
          if (Object.keys(request.input).some((key) => !allowed.includes(key))) {
            throw effectTransportError(400, 'NanoHost effect command contains an unowned field.');
          }
          command = { ...request.input, requestId };
        }
        if (pendingEffects.has(operation)) {
          if (operation === 'file.export' && request.input.purpose === 'artifact-submission')
            throw new OperationError(
              'artifact_capture_busy',
              'Another file capture is still in progress. Use a new request after it settles.',
              409
            );
          throw new Error(`NanoHost effect ${operation} already has a pending command.`);
        }
        const readiness = currentReadiness;
        if (!readiness) {
          throw new Error('NanoHost effect dispatch has no current physical Epoch authority.');
        }
        const originPhysicalEpoch = requireCurrentReadiness(readiness);
        completedEffects.delete(operation);
        return new Promise<unknown>((resolve, reject) => {
          const collectionAbort =
            operation === 'workspace.collect' ? new AbortController() : undefined;
          pendingEffects.set(operation, {
            ...(collectionAbort ? { collectionAbort } : {}),
            accepted: false,
            ...(request.imageSettlement ? { imageSettlement: request.imageSettlement } : {}),
            command,
            originPhysicalEpoch,
            reject,
            requestId,
            resolve,
          });
          if (operation === 'file.export' && request.input.purpose === 'artifact-submission') {
            armLiveFileExportWait(pendingEffects, pendingEffects.get(operation)!, request.signal);
          }
          if (operation === 'workspace.collect') {
            // NanoHost owns the scan clock; Core bounds the pre-delivery wait by both fixed phase allowances.
            armWorkspaceCollectionDeadline(pendingEffects, pendingEffects.get(operation)!, 240_000);
          }
        });
      })();
      void effectPromise.catch(() => undefined);
      return effectPromise;
    },

    expectResultOnly(expectations) {
      if (
        expectations.length === 0 ||
        expectations.length > NANO_HOST_EFFECT_OPERATIONS.length ||
        new Set(expectations.map(({ kind }) => kind)).size !== expectations.length
      ) {
        throw new Error('NanoHost result-only expectations are empty, duplicate, or unbounded.');
      }
      for (const expectation of expectations) {
        const cleanupExpectation =
          expectation.kind === 'bridge.close' || expectation.kind === 'sandbox.delete';
        if (cleanupExpectation !== (expectation.originPhysicalEpoch !== undefined)) {
          throw new Error('NanoHost result-only cleanup physical Epoch origin is invalid.');
        }
        if (cleanupExpectation) {
          requireStoredNanoHostPhysicalEpoch(expectation.originPhysicalEpoch);
        }
        if (!expectation.imageSettlement) continue;
        WorkerImageSettlementIdentitySchema.parse(expectation.imageSettlement);
        if (!input.coreDb || !['image.acquire', 'image.build'].includes(expectation.kind)) {
          throw new Error('Preparation image settlement recovery is unavailable.');
        }
      }
      const cleanupExpectations = expectations.filter(
        (expectation): expectation is NanoHostCleanupResultOnlyExpectation =>
          expectation.kind === 'bridge.close' || expectation.kind === 'sandbox.delete'
      );
      if (
        cleanupExpectations.length !== 0 &&
        (cleanupExpectations.length !== expectations.length ||
          new Set(cleanupExpectations.map(({ originPhysicalEpoch }) => originPhysicalEpoch))
            .size !== 1)
      ) {
        throw new Error(
          'NanoHost result-only expectations must be one image group or one cleanup origin group.'
        );
      }
      if (input.coreDb) {
        for (const expectation of expectations) {
          if (!expectation.imageSettlement) continue;
          const known = readWorkerImageSettlement(input.coreDb, expectation.requestId);
          if (!known) continue;
          return Promise.resolve({
            kind: expectation.kind,
            result: settledImageResult(
              known,
              expectation.imageSettlement,
              expectation.requestId,
              expectation.kind
            ),
          });
        }
      }
      for (const expectation of expectations) {
        if (
          !['bridge.close', 'image.acquire', 'image.build', 'sandbox.delete'].includes(
            expectation.kind
          ) ||
          !/^[0-9a-f]{64}$/.test(expectation.requestId) ||
          pendingEffects.has(expectation.kind)
        ) {
          throw new Error('NanoHost result-only expectation conflicts with current effect state.');
        }
      }
      const resultPromise = new Promise<NanoHostResultOnlySettlement>((resolve, reject) => {
        const group: NanoHostResultOnlyGroup = { expectations: [...expectations] };
        for (const expectation of expectations) {
          pendingEffects.set(expectation.kind, {
            accepted: false,
            command: null,
            ...(expectation.imageSettlement
              ? { imageSettlement: expectation.imageSettlement }
              : {}),
            reject,
            requestId: expectation.requestId,
            resolve: (value) => resolve(value as NanoHostResultOnlySettlement),
            resultOnlyGroup: group,
            ...(expectation.originPhysicalEpoch !== undefined
              ? { originPhysicalEpoch: expectation.originPhysicalEpoch }
              : {}),
          });
        }
      });
      void resultPromise.catch(() => undefined);
      return resultPromise;
    },

    async poll(physicalConnection, operation) {
      requireAuthoritativeSession(input.sessionAuthority, physicalConnection);
      const pollingReadiness = readyPhysicalConnections.get(physicalConnection);
      if (!pollingReadiness) {
        throw new Error('NanoHost physical connection has not completed durable readiness.');
      }
      const pollingPhysicalEpoch = requireCurrentReadiness(pollingReadiness);
      for (const [candidateOperation, candidate] of pendingEffects) {
        if (
          !candidate.resultOnlyGroup ||
          candidate.originPhysicalEpoch === undefined ||
          candidate.originPhysicalEpoch === pollingPhysicalEpoch
        ) {
          continue;
        }
        removePendingEffectGroup(pendingEffects, candidateOperation, candidate);
        candidate.reject(
          new Error(
            'NanoHost cleanup result-only origin physical Epoch is absent from the current coordinator.'
          )
        );
      }
      const priorConnectionEffects = [...pendingEffects.entries()].filter(
        ([, candidate]) =>
          (candidate.resultOnlyGroup && !completedEffectPollConnections.has(physicalConnection)) ||
          (candidate.accepted && candidate.acceptedConnection !== physicalConnection)
      );
      if (priorConnectionEffects.length > 0) {
        const mutatingOutcomeUnknown = priorConnectionEffects.some(
          ([candidateOperation, candidate]) =>
            candidate.resultOnlyGroup || !isConnectionEphemeralEffect(candidateOperation)
        );
        const unknown = effectTransportError(
          409,
          mutatingOutcomeUnknown
            ? 'NanoHost accepted effect outcome is unknown; successor connection fenced.'
            : 'NanoHost accepted effect outcome is unknown after connection replacement.'
        );
        const rejectedResultOnlyGroups = new Set<NanoHostResultOnlyGroup>();
        for (const [candidateOperation, candidate] of priorConnectionEffects) {
          if (
            candidate.resultOnlyGroup &&
            rejectedResultOnlyGroups.has(candidate.resultOnlyGroup)
          ) {
            continue;
          }
          if (candidate.resultOnlyGroup) {
            rejectedResultOnlyGroups.add(candidate.resultOnlyGroup);
          }
          removePendingEffectGroup(pendingEffects, candidateOperation, candidate);
          candidate.reject(unknown);
        }
        if (mutatingOutcomeUnknown) {
          input.sessionAuthority.closePhysicalConnection(physicalConnection);
          throw unknown;
        }
      }
      const pending = pendingEffects.get(operation);
      if (!pending) {
        completedEffectPollConnections.add(physicalConnection);
        return null;
      }
      if (
        pending.command &&
        pending.originPhysicalEpoch !== undefined &&
        pending.originPhysicalEpoch !== pollingPhysicalEpoch
      ) {
        removePendingEffectGroup(pendingEffects, operation, pending);
        pending.reject(
          new Error('NanoHost queued effect origin physical Epoch is no longer current.')
        );
        completedEffectPollConnections.add(physicalConnection);
        return null;
      }
      if (pending.accepted || !pending.command) {
        completedEffectPollConnections.add(physicalConnection);
        return null;
      }
      pending.accepted = true;
      pending.acceptedConnection = physicalConnection;
      const command = { ...pending.command };
      completedEffectPollConnections.add(physicalConnection);
      if (operation === 'image.build') {
        const { dockerfile: _dockerfile, ...metadata } = command;
        return metadata;
      }
      return command;
    },

    async imageBuildInput(physicalConnection, request) {
      requireAuthoritativeSession(input.sessionAuthority, physicalConnection);
      if (!readyPhysicalConnections.has(physicalConnection)) {
        throw effectTransportError(
          409,
          'NanoHost physical connection has not completed durable readiness.'
        );
      }
      const requestId = await readImageBuildInputRequest(request);
      const pending = pendingEffects.get('image.build');
      if (
        !pending ||
        !pending.command ||
        !pending.accepted ||
        pending.acceptedConnection !== physicalConnection ||
        pending.requestId !== requestId ||
        pending.imageBuildInputServed
      ) {
        throw effectTransportError(409, 'NanoHost image build input has no matching request.');
      }
      const body = pending.command.dockerfile;
      const byteLength = pending.command.dockerfileByteLength;
      const sha256 = pending.command.dockerfileDigest;
      if (
        !Buffer.isBuffer(body) ||
        !Number.isSafeInteger(byteLength) ||
        body.byteLength !== byteLength ||
        typeof sha256 !== 'string'
      ) {
        throw effectTransportError(500, 'NanoHost image build input source is unavailable.');
      }
      pending.imageBuildInputServed = true;
      return { body, byteLength: byteLength as number, requestId, sha256 };
    },

    async readiness(physicalConnection, body, runtimeTarget) {
      if (!isNanoHostPhysicalConnectionContext(physicalConnection)) {
        throw new Error('NanoHost readiness requires a native physical connection.');
      }
      requireAuthoritativeSession(input.sessionAuthority, physicalConnection);
      const readiness = parseJsonObject(body, 'NanoHost readiness body is invalid.');
      if (typeof readiness.physicalEpoch !== 'string') {
        throw new Error('NanoHost readiness body requires physicalEpoch.');
      }
      const physicalEpoch = requireNanoHostPhysicalEpoch(readiness.physicalEpoch);
      if (!runtimeTarget) {
        throw new Error('NanoHost RuntimeTarget readiness composition is unavailable.');
      }
      const connectionGeneration = input.sessionAuthority.connectionGeneration(physicalConnection);
      if (connectionGeneration === null) {
        throw new Error('NanoHost readiness connection generation is unavailable.');
      }
      upsertNanoHostRuntimeTarget(runtimeTarget.coreDb, {
        connectionGeneration,
        deploymentId: runtimeTarget.deploymentId,
        freshEmpty: true,
        identityId: runtimeTarget.identityId,
        observedAt: new Date().toISOString(),
        physicalEpoch,
        predecessorFenced: true,
        ready: true,
        targetId: runtimeTarget.targetId,
      });
      const acceptedReadiness = {
        connectionGeneration,
        physicalEpoch,
        runtimeTarget,
      };
      readyPhysicalConnections.set(physicalConnection, acceptedReadiness);
      currentReadiness = acceptedReadiness;
    },

    async result(physicalConnection, operation, result) {
      requireAuthoritativeSession(input.sessionAuthority, physicalConnection);
      if (operation === 'workspace.collect') {
        const pending = pendingEffects.get(operation);
        if (!pending?.accepted || !pending.command)
          throw effectTransportError(409, 'Workspace collection has no accepted pending command.');
        result = admitWorkspaceCollectJsonResult(
          result,
          WorkspaceCollectCommandSchema.parse(pending.command)
        );
      }
      const requestId = readRequestId(result);
      result = readNanoHostEffectResult(operation, result);
      const resultNames = Object.keys(result);
      const carriesFailureCode = resultNames.includes('failureCode');
      const isExactEffectFailure =
        carriesFailureCode &&
        resultNames.length === 2 &&
        /^[0-9a-f]{64}$/.test(requestId) &&
        result.failureCode === 'effect_failed';
      const isExactFileAbsence =
        operation === 'file.export' &&
        resultNames.length === 2 &&
        /^[0-9a-f]{64}$/.test(requestId) &&
        result.state === 'absent';
      if (carriesFailureCode && !isExactEffectFailure) {
        throw effectTransportError(409, 'NanoHost effect failure result is invalid.');
      }
      if (
        isExactEffectFailure &&
        (operation === 'bridge.open' ||
          operation === 'reference.import' ||
          operation === 'file.export')
      ) {
        throw effectTransportError(409, 'NanoHost special effect has no JSON failure result.');
      }
      const isExactFileRefusal =
        operation === 'file.export' &&
        resultNames.length === 3 &&
        /^[0-9a-f]{64}$/.test(requestId) &&
        result.state === 'refused' &&
        result.reasonCode === 'artifact_file_not_regular';
      if (operation === 'file.export' && !isExactFileAbsence && !isExactFileRefusal) {
        throw effectTransportError(409, 'NanoHost file export JSON result is invalid.');
      }
      const resultBody = Object.fromEntries(
        Object.entries(result).filter(([name]) => name !== 'requestId')
      );
      const resultJson = JSON.stringify(resultBody);
      const pending = pendingEffects.get(operation);
      if (!pending) {
        if (input.coreDb && (operation === 'image.acquire' || operation === 'image.build')) {
          const known = readWorkerImageSettlement(input.coreDb, requestId);
          if (known) {
            if (
              known.operation !== operation ||
              JSON.stringify(known.outcome) !== JSON.stringify(imageSettlementOutcome(resultBody))
            ) {
              throw new WorkerImageSettlementConflict();
            }
            return;
          }
        }
        const completed = completedEffects.get(operation);
        if (completed?.requestId === requestId && completed.resultJson === resultJson) {
          if (
            (operation === 'bridge.open' || isExactEffectFailure || isExactFileAbsence) &&
            completed.redeliveredConnection === physicalConnection
          ) {
            throw effectTransportError(
              409,
              isExactEffectFailure
                ? 'NanoHost settled effect failure duplicate cannot retry on one generation.'
                : isExactFileAbsence
                  ? 'NanoHost optional absence result cannot retry on one generation.'
                  : 'NanoHost sensitive bridge result cannot retry on one generation.'
            );
          }
          if (operation === 'bridge.open' || isExactEffectFailure || isExactFileAbsence) {
            completed.redeliveredConnection = physicalConnection;
          }
          return;
        }
        if (operation === 'sandbox.delete' && completed?.requestId === requestId) {
          throw effectTransportError(
            409,
            'NanoHost delete result conflicts with its completed outcome.'
          );
        }
        if (
          operation === 'sandbox.delete' &&
          canDiscardCleanedDeleteResult(physicalConnection, requestId, resultBody)
        )
          return;
        throw new Error('NanoHost effect result does not match a pending request.');
      }
      if ((!pending.accepted && !pending.resultOnlyGroup) || pending.requestId !== requestId) {
        if (pending.resultOnlyGroup) {
          const conflict = effectTransportError(
            409,
            'NanoHost retained effect result conflicts with its result-only expectation.'
          );
          removePendingEffectGroup(pendingEffects, operation, pending);
          pending.reject(conflict);
          input.sessionAuthority.closePhysicalConnection(physicalConnection);
        }
        throw new Error('NanoHost effect result requestId or operation does not match.');
      }
      if (
        isExactFileRefusal &&
        (pending.command?.purpose !== 'artifact-submission' ||
          pending.command?.presence !== 'optional')
      )
        throw effectTransportError(409, 'NanoHost refusal has no admitted live request.');
      if (isExactFileAbsence && pending.command?.presence !== 'optional') {
        throw effectTransportError(409, 'NanoHost required file export cannot be absent.');
      }
      if (pending.imageSettlement) {
        const settlement = WorkerImageSettlementSchema.parse({
          ...pending.imageSettlement,
          requestId,
          operation,
          outcome: imageSettlementOutcome(resultBody),
        });
        const coreDb = input.coreDb;
        if (!coreDb) throw new Error('Missing image settlement database.');
        try {
          writeWorkerImageSettlement(coreDb, settlement);
        } catch (error) {
          if (error instanceof WorkerImageSettlementConflict) throw error;
          const deferred = new WorkerImageSettlementDeferred();
          if (!pending.imageSettlementDeferred) {
            pending.imageSettlementDeferred = true;
            console.warn('nanohost image settlement deferred');
            pending.reject(deferred);
          }
          throw deferred;
        }
        if (pending.imageSettlementDeferred || pending.resultOnlyGroup)
          console.info('nanohost image settlement recovered');
      }
      if (isExactEffectFailure) {
        removePendingEffectGroup(pendingEffects, operation, pending);
        completedEffects.set(operation, {
          redeliveredConnection: physicalConnection,
          requestId,
          resultJson,
        });
        pending.reject(effectTransportError(500, 'NanoHost effect failed: effect_failed.'));
        return;
      }
      if (
        operation === 'sandbox.delete' &&
        pending.command &&
        (resultBody.sandboxId !== pending.command.sandboxId ||
          typeof resultBody.sandboxId !== 'string' ||
          resultBody.state !== 'deleted')
      ) {
        throw effectTransportError(409, 'NanoHost delete result disagrees with its command.');
      }
      if (operation === 'bridge.open') {
        if (!pending.command) {
          throw effectTransportError(500, 'NanoHost bridge command is unavailable.');
        }
        requireBridgeOpenResult(resultBody, pending.command);
      }
      if (operation === 'reference.import') {
        if (!pending.command) {
          throw effectTransportError(500, 'NanoHost import command is unavailable.');
        }
        const expectedReference = `sandbox://${String(pending.command.sandboxId)}/${String(
          pending.command.slot
        )}/${String(pending.command.relativePath)}`;
        if (
          resultBody.byteLength !== pending.command.byteLength ||
          resultBody.reference !== expectedReference
        ) {
          throw effectTransportError(409, 'NanoHost import result disagrees with its command.');
        }
      }
      removePendingEffectGroup(pendingEffects, operation, pending);
      completedEffects.set(operation, {
        requestId,
        resultJson,
        ...(operation === 'bridge.open' || isExactFileAbsence
          ? { redeliveredConnection: physicalConnection }
          : {}),
      });
      pending.resolve(
        pending.resultOnlyGroup ? { kind: operation, result: resultBody } : resultBody
      );
    },

    beginWorkspaceCollectionDelivery(physicalConnection) {
      requireAuthoritativeSession(input.sessionAuthority, physicalConnection);
      const pending = pendingEffects.get('workspace.collect');
      if (pending?.accepted && !pending.collectionDeliveryStarted) {
        pending.collectionDeliveryStarted = true;
        armWorkspaceCollectionDeadline(pendingEffects, pending, 120_000);
      }
      return {
        signal: pending?.collectionAbort?.signal,
        abandon: () => {
          if (
            !pending ||
            pendingEffects.get('workspace.collect') !== pending ||
            (pending.acceptedConnection && pending.acceptedConnection !== physicalConnection)
          )
            return;
          pending.command = null;
          removePendingEffectGroup(pendingEffects, 'workspace.collect', pending);
          pending.reject(
            new Error('Workspace collection delivery is unknown; authorize a new request.')
          );
        },
      };
    },

    async workspaceCollectResult(physicalConnection, request) {
      requireAuthoritativeSession(input.sessionAuthority, physicalConnection);
      const pending = pendingEffects.get('workspace.collect');
      if (!pending?.accepted || !pending.command)
        throw effectTransportError(409, 'Workspace collection has no accepted pending command.');
      const command = WorkspaceCollectCommandSchema.parse(pending.command);
      if (command.mode !== 'capture')
        throw effectTransportError(409, 'Baseline collection cannot return a candidate.');
      const requestId = request.headers.get('x-openkit-request-id');
      const readPair = (name: string) => {
        const wire = request.headers.get(name);
        if (!wire || !/^[0-9a-f]{40} [0-9a-f]{40}$/.test(wire))
          throw effectTransportError(400, 'Workspace collection snapshot header is invalid.');
        const [tree, manifest] = wire.split(' ');
        return WorkspaceSnapshotPairSchema.parse({ tree, manifest });
      };
      const head = readPair('x-openkit-head');
      const previousHead = readPair('x-openkit-previous-head');
      const acceptedBase = readPair('x-openkit-accepted-base');
      const unstable = request.headers.get('x-openkit-unstable');
      const byteLength = readCanonicalByteLengthText(
        request.headers.get('x-openkit-byte-length') ?? ''
      );
      const sha256 = readSha256(request.headers.get('x-openkit-sha256'));
      if (
        request.headers.get('content-type') !== FILE_DATA_CONTENT_TYPE ||
        requestId !== pending.requestId ||
        request.headers.get('content-length') !== String(byteLength) ||
        byteLength === 0 ||
        (unstable !== 'true' && unstable !== 'false') ||
        !sameWorkspaceSnapshot(previousHead, command.previousHead) ||
        !sameWorkspaceSnapshot(acceptedBase, command.acceptedBase) ||
        sameWorkspaceSnapshot(head, previousHead) ||
        sameWorkspaceSnapshot(head, acceptedBase) ||
        pending.acceptedConnection !== physicalConnection
      ) {
        throw effectTransportError(
          409,
          'Workspace collection candidate disagrees with its command.'
        );
      }
      const staged = await stageFileExport(
        request,
        { byteLength, sha256 },
        pending.collectionAbort?.signal
      );
      try {
        requireAuthoritativeSession(input.sessionAuthority, physicalConnection);
        if (pendingEffects.get('workspace.collect') !== pending)
          throw effectTransportError(409, 'Workspace collection delivery became unknown.');
      } catch (error) {
        await rm(staged.directory, { force: true, recursive: true });
        throw error;
      }
      clearTimeout(pending.collectionTimeout);
      pending.command = null;
      pendingEffects.delete('workspace.collect');
      pending.resolve({
        outcome: 'candidate',
        head,
        previousHead,
        acceptedBase,
        unstable: unstable === 'true',
        byteLength,
        sha256,
        stagingPath: staged.path,
      });
    },

    async fileExportResult(physicalConnection, request) {
      requireAuthoritativeSession(input.sessionAuthority, physicalConnection);
      const metadata = readFileDataHeaders(request.headers);
      const pending = pendingEffects.get('file.export');
      const completed = completedEffects.get('file.export');
      if (pending) {
        requirePendingFileExport(pending, metadata);
      } else if (!completed?.fileResult || completed.requestId !== metadata.requestId) {
        throw effectTransportError(409, 'NanoHost file export has no matching pending request.');
      }
      if (!pending && completed?.redeliveredConnection === physicalConnection) {
        throw effectTransportError(409, 'NanoHost file export cannot retry on one generation.');
      }

      const staged = await stageFileExport(request, metadata);
      if (!pending) {
        const matchesCompleted = sameFileResult(completed?.fileResult, metadata);
        await rm(staged.directory, { force: true, recursive: true });
        if (!matchesCompleted) {
          throw effectTransportError(409, 'NanoHost file export duplicate conflicts.');
        }
        if (completed) {
          completed.redeliveredConnection = physicalConnection;
        }
        return;
      }

      if (pending.fileExportAbandoned) {
        // A complete late copy is verified above and disposed before uncertain admission is freed.
        await rm(staged.directory, { force: true, recursive: true });
      }
      removePendingEffectGroup(pendingEffects, 'file.export', pending);
      completedEffects.set('file.export', {
        fileResult: metadata,
        redeliveredConnection: physicalConnection,
        requestId: metadata.requestId,
        resultJson: JSON.stringify(metadata),
      });
      if (pending.fileExportAbandoned) return;
      pending.resolve({
        byteLength: metadata.byteLength,
        relativePath: metadata.relativePath,
        sha256: metadata.sha256,
        slot: metadata.slot,
        stagingPath: staged.path,
      });
    },

    async route(physicalConnection, request) {
      requireAuthoritativeSession(input.sessionAuthority, physicalConnection);
      const isHarnessRoute =
        request.path === HARNESS_POLL_PATH || request.path === HARNESS_RESULT_PATH;
      if (isHarnessRoute) {
        if (
          request.family !== 'worker-control' ||
          request.credentialClass !== 'harness' ||
          !readyPhysicalConnections.has(physicalConnection)
        ) {
          throw new Error('NanoHost private Harness route is not admitted.');
        }
        return;
      }
      if (request.credentialClass !== request.family) {
        throw new Error('NanoHost route credential class does not match its family.');
      }
      const prefix =
        request.family === 'worker-control'
          ? '/worker-control/'
          : request.family === 'inference'
            ? '/inference/'
            : '/capabilities/';
      if (!request.path.startsWith(prefix) || request.path.startsWith('//')) {
        throw new Error('NanoHost route path does not match its family.');
      }
      if (request.family === 'worker-control' && request.body.byteLength > CONTROL_BODY_MAX_BYTES) {
        throw new Error('NanoHost worker-control body exceeds its bound.');
      }
      if (request.family === 'capability' && request.body.byteLength > CAPABILITY_BODY_MAX_BYTES) {
        throw new Error('NanoHost capability body exceeds its bound.');
      }
      if (!input.routeHandler) {
        return;
      }
      return input.routeHandler(request);
    },
  };
}

/** Identifies effects without successor replay; purge remains fenced by its Core purge-pending owner. */
function isConnectionEphemeralEffect(operation: NanoHostEffectOperation): boolean {
  return (
    operation === 'workspace.collect' ||
    operation === 'image.inspect' ||
    operation === 'storage.inspect' ||
    operation === 'storage.purge'
  );
}

/** Arms the existing collection cancellation timer; delivery gets one absolute allowance without renewal. */
function armWorkspaceCollectionDeadline(
  pendingEffects: Map<NanoHostEffectOperation, PendingNanoHostEffect>,
  pending: PendingNanoHostEffect,
  milliseconds: number
): void {
  clearTimeout(pending.collectionTimeout);
  pending.collectionTimeout = setTimeout(() => {
    if (pendingEffects.get('workspace.collect') !== pending) return;
    removePendingEffectGroup(pendingEffects, 'workspace.collect', pending);
    pending.reject(new Error('Workspace collection delivery is unknown.'));
  }, milliseconds);
  pending.collectionTimeout.unref();
}

/** Bounds the live caller by NanoHost's existing 300-second file-effect deadline without abandoning accepted effect ownership. */
function armLiveFileExportWait(
  pendingEffects: Map<NanoHostEffectOperation, PendingNanoHostEffect>,
  pending: PendingNanoHostEffect,
  signal?: AbortSignal
): void {
  const abandon = () => {
    if (pendingEffects.get('file.export') !== pending || pending.fileExportAbandoned) return;
    pending.fileExportAbandoned = true;
    pending.fileExportWaitCleanup?.();
    // An undelivered command has no uncertain effect; an accepted command stays busy for late disposal.
    if (!pending.accepted) removePendingEffectGroup(pendingEffects, 'file.export', pending);
    pending.reject(
      new OperationError('recovery_required', 'Worker file capture outcome is unknown.', 409)
    );
  };
  // Matches ExecSandboxRequest.timeout_seconds in NanoHost openshell_client.rs.
  const timeout = setTimeout(abandon, 300_000);
  timeout.unref();
  pending.fileExportWaitCleanup = () => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abandon);
  };
  signal?.addEventListener('abort', abandon, { once: true });
  if (signal?.aborted) abandon();
}

/** Removes one ordinary pending effect or every member of its result-only correlation set. */
function removePendingEffectGroup(
  pendingEffects: Map<NanoHostEffectOperation, PendingNanoHostEffect>,
  operation: NanoHostEffectOperation,
  pending: PendingNanoHostEffect
): void {
  clearTimeout(pending.collectionTimeout);
  pending.fileExportWaitCleanup?.();
  if (operation === 'workspace.collect') {
    pending.command = null;
    pending.collectionAbort?.abort();
  }
  if (!pending.resultOnlyGroup) {
    if (pendingEffects.get(operation) === pending) pendingEffects.delete(operation);
    return;
  }
  for (const expectation of pending.resultOnlyGroup.expectations) {
    if (pendingEffects.get(expectation.kind)?.resultOnlyGroup === pending.resultOnlyGroup) {
      pendingEffects.delete(expectation.kind);
    }
  }
}

/**
 * Installs readiness and the three fixed semantic projections on the native session.
 *
 * Readiness is registered as private pre-auth transport carriage. The semantic
 * paths preserve method, query, headers, body, status, response headers, and
 * response bytes while delegating decisions to the existing App owners
 * after public route matching. None becomes a public App API or proxy route.
 *
 * @param input App and authoritative dispatcher owned by the composition root.
 */
export function registerNanoHostSessionSemanticRoutes(
  input: RegisterNanoHostSessionSemanticRoutesInput
): void {
  input.app.use('/api/nanohost/transport/session/readiness', async (context) => {
    if (context.req.method !== 'POST') {
      return context.body(null, 405, { allow: 'POST' });
    }
    try {
      if (context.req.header('content-type') !== 'application/json') {
        throw new Error('NanoHost readiness content type must be application/json.');
      }
      const physicalConnection = requirePhysicalConnection(context.env);
      if (!input.dispatch.readiness) {
        throw new Error('NanoHost readiness dispatcher is unavailable.');
      }
      const body = new Uint8Array(await context.req.arrayBuffer());
      if (!input.coreDb || !input.nanoHostConfig) {
        throw new Error('NanoHost RuntimeTarget readiness composition is unavailable.');
      }
      await input.dispatch.readiness(physicalConnection, body, {
        coreDb: input.coreDb,
        deploymentId: input.nanoHostConfig.deploymentId,
        identityId: input.nanoHostConfig.identityId,
        targetId: input.nanoHostConfig.identityId,
      });
      return context.body(null, 204);
    } catch (error) {
      return privateEffectError(error);
    }
  });

  input.app.notFound(async (context) => {
    // Core semantic request entry precedes body collection, admission and the dispatch transaction.
    const receivedAt = performance.now();
    const path = context.req.path;
    const family = path.startsWith('/worker-control/')
      ? 'worker-control'
      : path.startsWith('/inference/')
        ? 'inference'
        : path.startsWith('/capabilities/')
          ? 'capability'
          : null;
    if (!family) {
      return context.text('404 Not Found', 404);
    }
    if (context.req.method !== 'POST') {
      return context.body(null, 405, { allow: 'POST' });
    }
    try {
      const request = context.req.raw;
      const bodyBuffer = await readBoundedSemanticBody(
        request,
        family === 'worker-control'
          ? CONTROL_BODY_MAX_BYTES
          : family === 'inference'
            ? INFERENCE_BODY_MAX_BYTES
            : CAPABILITY_BODY_MAX_BYTES
      );
      const body = new Uint8Array(bodyBuffer);
      const isHarnessRoute = path === HARNESS_POLL_PATH || path === HARNESS_RESULT_PATH;
      if (isHarnessRoute) {
        if (!input.coreDb) {
          throw new Error('NanoHost private Harness storage is unavailable.');
        }
        if (request.headers.has('authorization')) {
          throw new Error('NanoHost private Harness route rejects bearer authorization.');
        }
        const sandboxIntegrationBindingRef = request.headers.get(INTEGRATION_BINDING_HEADER);
        if (
          !sandboxIntegrationBindingRef ||
          sandboxIntegrationBindingRef.length > 512 ||
          sandboxIntegrationBindingRef.includes(',') ||
          /[\r\n\0]/.test(sandboxIntegrationBindingRef)
        ) {
          throw new Error('NanoHost private Sandbox Integration binding is missing or ambiguous.');
        }
        if (request.headers.get('content-type') !== 'application/json') {
          throw new Error('NanoHost private Harness content type must be application/json.');
        }
        await input.dispatch.route(requirePhysicalConnection(context.env), {
          body,
          credentialClass: 'harness',
          family: 'worker-control',
          path,
        });
        const value = parseJsonObject(body, 'NanoHost private Harness body is invalid.');
        if (path === HARNESS_POLL_PATH) {
          if (value.schemaVersion !== 2) {
            throw new Error('NanoHost private Harness poll body is invalid.');
          }
          const incoming = (context.env as { incoming?: import('node:http2').Http2ServerRequest })
            ?.incoming;
          // No await separates this check from dispatch: known cancelled carriage grants no delivery.
          if (
            request.signal.aborted ||
            incoming?.aborted ||
            incoming?.stream.destroyed ||
            incoming?.stream.rstCode
          ) {
            return context.body(null, 204);
          }
          let command = dispatchNanoHostHarnessOperation(input.coreDb, {
            sandboxIntegrationBindingRef,
          });
          const committedAt = performance.now();
          if (command) {
            command = input.harnessCommandDispatched?.(command) ?? command;
          }
          if (command) {
            // Dispatch is committed; response handoff is evidence, never receipt or retry authority.
            try {
              console.error(
                JSON.stringify({
                  event: 'worker.harness.dispatched',
                  harnessInstanceId: command.harnessInstanceId,
                  operationId: command.operationId,
                  operation: command.operation,
                  sequence: command.sequence,
                  at: new Date().toISOString(),
                })
              );
            } catch {
              /* Diagnostic sink failure has no execution authority. */
            }
            const coreDb = input.coreDb;
            const identity = {
              harnessInstanceId: command.harnessInstanceId,
              operationId: command.operationId,
            };
            observeHarnessResponse(context, command, { receivedAt, committedAt }, () => {
              // An accepted result may win before the reset observer; never fence a settled successor.
              try {
                const pending = coreDb.sqlite
                  .prepare(
                    `SELECT harness_binding_ref AS harnessBindingRef FROM harness_instance_records
                   WHERE harness_instance_id = ? AND operation_id = ? AND operation_state = 'dispatched'`
                  )
                  .get(identity.harnessInstanceId, identity.operationId) as
                  | { harnessBindingRef: string }
                  | undefined;
                if (!pending) return;
                markNanoHostHarnessOperationUnknown(coreDb, {
                  harnessBindingRef: pending.harnessBindingRef,
                  operationId: identity.operationId,
                  timestamp: new Date().toISOString(),
                });
              } catch (failure) {
                // A storage refusal must fail the live owner, not escape a native event callback.
                input.harnessCommandDeliveryFailed?.(identity, failure);
                return;
              }
              input.harnessCommandDeliveryFailed?.(identity);
            });
          }
          return command ? context.json(command, 200) : context.body(null, 204);
        }
        const result = value as unknown as NanoHostHarnessResult;
        settleNanoHostHarnessOperation(input.coreDb, {
          sandboxIntegrationBindingRef,
          result,
          timestamp: new Date().toISOString(),
          onSettled: input.harnessResultSettled,
        });
        try {
          console.error(
            JSON.stringify({
              event: 'worker.harness.result.accepted',
              harnessInstanceId: result.harnessInstanceId,
              operationId: result.operationId,
              sequence: result.sequence,
              disposition: result.disposition,
              at: new Date().toISOString(),
            })
          );
        } catch {
          /* Diagnostic sink failure has no execution authority. */
        }
        return context.body(null, 204);
      }
      await input.dispatch.route(requirePhysicalConnection(context.env), {
        body,
        credentialClass: family,
        family,
        path,
      });
      const target = new URL(request.url);
      target.pathname =
        family === 'worker-control'
          ? `/api${target.pathname}`
          : family === 'inference'
            ? `/api/worker-inference${target.pathname.slice('/inference'.length)}`
            : `/api/worker-capabilities${target.pathname.slice('/capabilities'.length)}`;
      return input.app.fetch(
        new Request(target, {
          body: bodyBuffer,
          headers: request.headers,
          method: 'POST',
        })
      );
    } catch (error) {
      return privateEffectError(error);
    }
  });
}

/** One native sampler; resets wait for observation, and a late maximum is carried once. */
const HARNESS_RESPONSE_DELAY_RESOLUTION_MS = 10;
const harnessResponseEventLoopDelay = monitorEventLoopDelay({
  resolution: HARNESS_RESPONSE_DELAY_RESOLUTION_MS,
});
harnessResponseEventLoopDelay.enable();
let harnessResponseDelayWindowStartedAt = performance.now();
let harnessResponseDelayReportedMax = 0;
let harnessResponseDelayCarryMax = 0;
let harnessResponseDelayCarryStartedAt = harnessResponseDelayWindowStartedAt;
let harnessResponseDelayResetPending = false;
let harnessResponseDelayResetCount = 0;
let harnessResponseDelayResetCheckedAt = harnessResponseDelayWindowStartedAt;

/** Joins a post-response native sample without a timer; one unreferenced check is pending at most. */
function resetHarnessResponseDelayAfterSample(): void {
  const checkedAt = performance.now();
  const count = harnessResponseEventLoopDelay.count;
  const checkWasDelayed =
    checkedAt - harnessResponseDelayResetCheckedAt > 2 * HARNESS_RESPONSE_DELAY_RESOLUTION_MS;
  harnessResponseDelayResetCheckedAt = checkedAt;
  if (checkWasDelayed) {
    // Another callback may have blocked after sampling but before this check; join a fresh sample.
    harnessResponseDelayResetCount = count;
  }
  if (count <= harnessResponseDelayResetCount) {
    setImmediate(resetHarnessResponseDelayAfterSample).unref();
    return;
  }
  const maximum = harnessResponseEventLoopDelay.max;
  if (maximum > harnessResponseDelayReportedMax) {
    // Preserve an observation that no terminal record has yet reported, even if the sink failed.
    if (!harnessResponseDelayCarryMax) {
      harnessResponseDelayCarryStartedAt = harnessResponseDelayWindowStartedAt;
    }
    harnessResponseDelayCarryMax = Math.max(harnessResponseDelayCarryMax, maximum);
  }
  harnessResponseEventLoopDelay.reset();
  harnessResponseDelayWindowStartedAt = checkedAt;
  harnessResponseDelayReportedMax = 0;
  harnessResponseDelayResetPending = false;
}

/** Fences known incomplete delivery once; completed native writes remain evidence, never receipt. */
function observeHarnessResponse(
  context: Context,
  command: NanoHostHarnessCommand,
  timing: { readonly receivedAt: number; readonly committedAt: number },
  onIncompleteDelivery: () => void
): void {
  const bindings = context.env as
    | {
        outgoing?: import('node:http2').Http2ServerResponse;
        incoming?: import('node:http2').Http2ServerRequest;
      }
    | undefined;
  const outgoing = bindings?.outgoing;
  if (!outgoing) return;
  const started = performance.now();
  const { harnessInstanceId, operationId, operation, sequence } = command;
  let settled = false;
  /** Emits a single fixed terminal disposition and removes every observer. */
  const finish = (outcome: 'completed' | 'reset' | 'aborted') => {
    if (settled) return;
    settled = true;
    outgoing.off('finish', terminal);
    outgoing.off('close', terminal);
    bindings?.incoming?.off('aborted', aborted);
    const observedAt = performance.now();
    const sampledMaximum = harnessResponseEventLoopDelay.max;
    const eventLoopDelayMaxMs = Math.round(
      Math.max(sampledMaximum, harnessResponseDelayCarryMax) / 1_000_000
    );
    const windowStartedAt = harnessResponseDelayCarryMax
      ? Math.min(harnessResponseDelayWindowStartedAt, harnessResponseDelayCarryStartedAt)
      : harnessResponseDelayWindowStartedAt;
    const eventLoopDelayWindowMs = Math.round(observedAt - windowStartedAt);
    harnessResponseDelayCarryMax = 0;
    harnessResponseDelayReportedMax = Math.max(harnessResponseDelayReportedMax, sampledMaximum);
    // Resetting here erases a block whose native sampler callback is still pending.
    if (!harnessResponseDelayResetPending) {
      harnessResponseDelayResetCount = harnessResponseEventLoopDelay.count;
      harnessResponseDelayResetCheckedAt = observedAt;
      harnessResponseDelayResetPending = true;
      setImmediate(resetHarnessResponseDelayAfterSample).unref();
    }
    const resetCode = bindings?.incoming?.stream.rstCode ?? null;
    if (resetCode && !outgoing.writableFinished) onIncompleteDelivery();
    try {
      console.error(
        JSON.stringify({
          event: 'worker.harness.response',
          harnessInstanceId,
          operationId,
          operation,
          sequence,
          outcome,
          resetCode,
          durationMs: Math.round(observedAt - started),
          pollToDispatchMs: Math.round(timing.committedAt - timing.receivedAt),
          pollToResponseMs: Math.round(observedAt - timing.receivedAt),
          eventLoopDelayMaxMs,
          eventLoopDelayWindowMs,
          at: new Date().toISOString(),
        })
      );
    } catch {
      /* Diagnostic sink failure has no execution authority. */
    }
  };
  // Native H2 may emit finish on closure after end() even when DATA never completed.
  const terminal = () =>
    finish(
      bindings?.incoming?.stream.rstCode || !outgoing.writableFinished ? 'reset' : 'completed'
    );
  const aborted = () => finish('aborted');
  outgoing.once('finish', terminal);
  outgoing.once('close', terminal);
  bindings?.incoming?.once('aborted', aborted);
}

/**
 * Registers the sixteen private fixed effect paths on the native NanoHost session.
 *
 * @param input App and authoritative dispatcher owned by the composition root.
 */
export function registerNanoHostSessionEffectRoutes(
  input: RegisterNanoHostSessionEffectRoutesInput
): void {
  let fileDataTransferActive = false;

  input.app.use('*', async (context, next) => {
    if (context.req.path !== '/api/nanohost/transport/effects/image.build/input') {
      return next();
    }
    if (context.req.method !== 'POST') {
      return context.body(null, 405, { allow: 'POST' });
    }
    if (fileDataTransferActive) {
      return privateEffectError(
        effectTransportError(409, 'NanoHost file-data transfer is already active.')
      );
    }
    fileDataTransferActive = true;
    try {
      const file = await input.dispatch.imageBuildInput(
        requirePhysicalConnection(context.env),
        context.req.raw
      );
      return createChunkedFileDataResponse(
        file.body,
        {
          'content-length': String(file.byteLength),
          'content-type': FILE_DATA_CONTENT_TYPE,
          [FILE_DATA_HEADERS.byteLength]: String(file.byteLength),
          [FILE_DATA_HEADERS.requestId]: file.requestId,
          [FILE_DATA_HEADERS.sha256]: file.sha256,
        },
        () => {
          fileDataTransferActive = false;
        }
      );
    } catch (error) {
      fileDataTransferActive = false;
      return privateEffectError(error);
    }
  });

  for (const operation of NANO_HOST_EFFECT_OPERATIONS) {
    const { command: commandPath, result: resultPath } = NANO_HOST_EFFECT_PATHS[operation];

    input.app.post(commandPath, async (context) => {
      let reservedFileData = false;
      try {
        if (operation === 'reference.import') {
          if (fileDataTransferActive) {
            throw effectTransportError(409, 'NanoHost file-data transfer is already active.');
          }
          fileDataTransferActive = true;
          reservedFileData = true;
        }
        await readBoundedJsonObject(context.req.raw);
        const physicalConnection = requirePhysicalConnection(context.env);
        const command = await input.dispatch.poll(physicalConnection, operation);
        if (operation === 'reference.import' && command) {
          const file = requireReferenceImportCommand(command, readRequestId(command));
          return createChunkedFileDataResponse(
            file.body,
            {
              'content-length': String(file.byteLength),
              'content-type': FILE_DATA_CONTENT_TYPE,
              [FILE_DATA_HEADERS.byteLength]: String(file.byteLength),
              [FILE_DATA_HEADERS.relativePath]: encodeRelativePath(file.relativePath),
              [FILE_DATA_HEADERS.requestId]: file.requestId,
              [FILE_DATA_HEADERS.sha256]: file.sha256,
              [FILE_DATA_HEADERS.slot]: file.slot,
            },
            () => {
              fileDataTransferActive = false;
            }
          );
        }
        if (reservedFileData) {
          fileDataTransferActive = false;
        }
        return command ? context.json(command, 200) : context.body(null, 204);
      } catch (error) {
        if (reservedFileData) {
          fileDataTransferActive = false;
        }
        return privateEffectError(error);
      }
    });

    input.app.post(resultPath, async (context) => {
      let collectionDelivery: { abandon: () => void; signal: AbortSignal | undefined } | undefined;
      try {
        const physicalConnection = requirePhysicalConnection(context.env);
        if (operation === 'workspace.collect')
          collectionDelivery =
            input.dispatch.beginWorkspaceCollectionDelivery?.(physicalConnection);
        if (
          operation === 'workspace.collect' &&
          context.req.header('content-type') === FILE_DATA_CONTENT_TYPE
        ) {
          if (fileDataTransferActive)
            throw effectTransportError(409, 'NanoHost file-data transfer is already active.');
          fileDataTransferActive = true;
          try {
            await input.dispatch.workspaceCollectResult(physicalConnection, context.req.raw);
          } finally {
            fileDataTransferActive = false;
          }
          return context.body(null, 204);
        }
        if (
          operation === 'file.export' &&
          context.req.header('content-type') === 'application/json'
        ) {
          if (
            Object.values(FILE_DATA_HEADERS).some(
              (header) => context.req.header(header) !== undefined
            )
          ) {
            throw effectTransportError(
              400,
              'NanoHost optional absence result has forbidden file metadata.'
            );
          }
          const result = await readBoundedJsonObject(context.req.raw);
          await input.dispatch.result(physicalConnection, operation, result);
          return context.body(null, 204);
        }
        if (operation === 'file.export') {
          if (fileDataTransferActive) {
            throw effectTransportError(409, 'NanoHost file-data transfer is already active.');
          }
          fileDataTransferActive = true;
          try {
            await input.dispatch.fileExportResult(physicalConnection, context.req.raw);
          } finally {
            fileDataTransferActive = false;
          }
          return context.body(null, 204);
        }
        const result =
          operation === 'workspace.collect'
            ? await readWorkspaceCollectionJson(context.req.raw, collectionDelivery?.signal)
            : await readBoundedJsonObject(context.req.raw);
        await input.dispatch.result(physicalConnection, operation, result);
        return context.body(null, 204);
      } catch (error) {
        if (operation === 'workspace.collect') {
          collectionDelivery?.abandon();
        }
        if (
          operation === 'file.export' &&
          context.req.header('content-type') === FILE_DATA_CONTENT_TYPE &&
          error instanceof Error &&
          error.message.includes('cannot retry on one generation')
        ) {
          return closeRejectedNativeFileStream(context.env, 409);
        }
        return privateEffectError(error);
      }
    });
  }
}

/** Validates one fixed effect request and returns its operation and identity. */
function requireEffectRequest(request: NanoHostSessionEffectRequest): {
  operation: NanoHostEffectOperation;
  requestId: string;
} {
  if (!isNanoHostEffectOperation(request.kind)) {
    throw new Error('NanoHost effect operation is not enabled.');
  }
  if (request.kind === 'sandbox.create') {
    if (
      Object.keys(request.input).some(
        (key) => !(SANDBOX_CREATE_INPUT_KEYS as readonly string[]).includes(key)
      )
    ) {
      throw effectTransportError(400, 'NanoHost effect command contains an unowned field.');
    }
    const intent = WorkerSandboxPolicyIntentSchema.safeParse(request.input.policyIntent);
    if (!intent.success) {
      throw effectTransportError(400, 'NanoHost sandbox policy intent is invalid.');
    }
  }
  const requestId = request.requestId ?? readRequestId(request.input);
  return { operation: request.kind, requestId };
}

/** Returns whether a string is one of the fixed effect operations. */
function isNanoHostEffectOperation(value: string): value is NanoHostEffectOperation {
  return (NANO_HOST_EFFECT_OPERATIONS as readonly string[]).includes(value);
}

/** Reads one required opaque request identity. */
function readRequestId(value: Readonly<Record<string, unknown>>): string {
  const requestId = value.requestId;
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw new Error('NanoHost effect requestId is required.');
  }
  return requestId;
}

/**
 * Validates the only sensitive fixed-effect command before it can be polled.
 *
 * @param value Internal `bridge.open` input derived from the current attempt lineage.
 * @param requestId Deterministic effect identity.
 * @returns Canonical command carrying exactly two independent route tokens.
 * @throws Error when either token is malformed, equal, or aliases a lineage binding.
 */
function requireBridgeOpenCommand(
  value: Readonly<Record<string, unknown>>,
  requestId: string
): Readonly<Record<string, unknown>> {
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'sandboxIntegrationBindingRef')) {
    throw new Error('NanoHost bridge command contains an unowned field.');
  }
  return {
    sandboxIntegrationBindingRef: readBoundedIdentity(
      value.sandboxIntegrationBindingRef,
      'Sandbox Integration binding'
    ),
    requestId,
  };
}

/** Validates the closed required-or-optional export command projection. */
function requireFileExportCommand(
  value: Readonly<Record<string, unknown>>,
  requestId: string
): Readonly<Record<string, unknown>> {
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'backendSessionId',
          'finalStatusAccepted',
          'leaseId',
          'maxByteLength',
          'packageSnapshotId',
          'presence',
          'purpose',
          'submissionRequestId',
          'turnId',
          'agentSessionId',
          'relativePath',
          'requestId',
          'sandboxId',
          'slot',
          'terminalBarrierProved',
        ].includes(key)
    )
  ) {
    throw effectTransportError(400, 'NanoHost effect command contains an unowned field.');
  }
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw effectTransportError(400, 'NanoHost file export requestId is invalid.');
  }
  if (value.presence !== 'required' && value.presence !== 'optional') {
    throw effectTransportError(400, 'NanoHost file export presence is invalid.');
  }
  const maximum = readCanonicalByteLength(value.maxByteLength);
  const live = value.purpose === 'artifact-submission';
  if (value.purpose !== undefined && value.purpose !== 'terminal' && !live)
    throw effectTransportError(400, 'NanoHost export purpose is invalid.');
  if (
    live &&
    (value.presence !== 'optional' ||
      maximum < 1 ||
      maximum > 16 * 1024 * 1024 + 1 ||
      [
        'submissionRequestId',
        'turnId',
        'agentSessionId',
        'packageSnapshotId',
        'leaseId',
        'backendSessionId',
        'sandboxId',
      ].some((key) => typeof value[key] !== 'string' || !(value[key] as string).length) ||
      value.terminalBarrierProved !== undefined ||
      value.finalStatusAccepted !== undefined)
  )
    throw effectTransportError(400, 'NanoHost live export admission is invalid.');
  // Terminal producers and Host admission retain their existing proof owners; live capture adds no terminal gate.
  if (!live && maximum !== FILE_DATA_MAX_BYTES)
    throw effectTransportError(400, 'NanoHost terminal export bound is invalid.');
  return { ...value, requestId };
}

/** Validates one exact local immutable-image inspection command. */
function requireImageInspectCommand(
  value: Readonly<Record<string, unknown>>,
  requestId: string
): Readonly<Record<string, unknown>> {
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'imageDigest')) {
    throw effectTransportError(400, 'NanoHost image inspection contains an unowned field.');
  }
  const imageDigest = value.imageDigest;
  if (typeof imageDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    throw effectTransportError(400, 'NanoHost image inspection digest is invalid.');
  }
  return { imageDigest, requestId };
}

/** Validates one exact retained-storage inspection or purge command. */
function requireStorageCommand(
  value: Readonly<Record<string, unknown>>,
  requestId: string
): Readonly<Record<string, unknown>> {
  if (
    Object.keys(value).sort().join(',') !== 'attachmentGeneration,storageRef' ||
    !Number.isSafeInteger(value.attachmentGeneration) ||
    (value.attachmentGeneration as number) < 1
  ) {
    throw effectTransportError(400, 'NanoHost storage command is invalid.');
  }
  return {
    attachmentGeneration: value.attachmentGeneration,
    storageRef: readBoundedIdentity(value.storageRef, 'Worker storage'),
    requestId,
  };
}

/**
 * Validates the settled redacted bridge result against its accepted command lineage.
 *
 * @param result Candidate operation-specific result without its request id.
 * @param command Accepted command after both raw tokens were discarded.
 * @throws Error when the result is not the exact authenticated starting latch.
 */
function requireBridgeOpenResult(
  result: Readonly<Record<string, unknown>>,
  command: Readonly<Record<string, unknown>>
): void {
  if (
    result.accepted !== true ||
    result.integrationReady !== true ||
    result.state !== 'open' ||
    typeof command.sandboxIntegrationBindingRef !== 'string'
  ) {
    throw effectTransportError(409, 'NanoHost bridge result disagrees with its command.');
  }
}

/** Parses one already-bounded private JSON object. */
function parseJsonObject(body: Uint8Array, message: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(message);
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error(message);
  }
}

/**
 * Retains one exact inline Dockerfile while producing its byte-free wire metadata.
 *
 * @param value Complete immutable image-build input supplied by the existing producer.
 * @param requestId Deterministic identity derived from that complete input.
 * @returns Canonical pending command with exact retained bytes and derived byte length.
 * @throws A 400, 409, or 413 transport error for malformed, conflicting, or oversized input.
 */
function requireImageBuildCommand(
  value: Readonly<Record<string, unknown>>,
  requestId: string
): Readonly<Record<string, unknown>> {
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw effectTransportError(400, 'NanoHost image build requestId is invalid.');
  }
  if (Object.hasOwn(value, 'dockerfileByteLength')) {
    throw effectTransportError(409, 'NanoHost image build byte length must be derived.');
  }
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'arguments',
          'argumentsDigest',
          'backendSessionId',
          'contextDigest',
          'contextRef',
          'dockerfile',
          'dockerfileDigest',
          'egress',
          'layerLimit',
          'leaseId',
          'outputLimitBytes',
          'packageSnapshotId',
          'requestId',
          'timeLimitSeconds',
        ].includes(key)
    )
  ) {
    throw effectTransportError(400, 'NanoHost effect command contains an unowned field.');
  }
  const dockerfile = value.dockerfile;
  const dockerfileDigest = value.dockerfileDigest;
  if (typeof dockerfile !== 'string' || typeof dockerfileDigest !== 'string') {
    throw effectTransportError(400, 'NanoHost image build Dockerfile input is invalid.');
  }
  const dockerfileByteLength = Buffer.byteLength(dockerfile, 'utf8');
  if (dockerfileByteLength > DOCKERFILE_INPUT_MAX_BYTES) {
    throw effectTransportError(413, 'NanoHost image build Dockerfile exceeds its bound.');
  }
  const parsed = AgentEnvironmentDockerfileInputSchema.safeParse({
    content: dockerfile,
    digest: dockerfileDigest,
    kind: 'dockerfile',
  });
  if (!parsed.success) {
    if (!/^sha256:[0-9a-f]{64}$/.test(dockerfileDigest) || dockerfileByteLength < 1) {
      throw effectTransportError(400, 'NanoHost image build Dockerfile input is invalid.');
    }
    throw effectTransportError(409, 'NanoHost image build Dockerfile digest disagrees.');
  }
  const contextDigest = readSha256(value.contextDigest);
  return {
    ...value,
    contextDigest,
    dockerfile: Buffer.from(parsed.data.content, 'utf8'),
    dockerfileByteLength,
    dockerfileDigest: parsed.data.digest,
    requestId,
  };
}

/**
 * Validates the fixed same-connection Dockerfile byte request.
 *
 * @param request Native private request carrying exact empty JSON and request identity.
 * @returns Matching deterministic image-build request identity.
 * @throws A 400, 409, or 500 transport error for noncanonical carriage or read failure.
 */
async function readImageBuildInputRequest(request: Request): Promise<string> {
  if (request.headers.get('content-type') !== 'application/json') {
    throw effectTransportError(400, 'NanoHost image build input content type is invalid.');
  }
  const openKitHeaders: string[] = [];
  request.headers.forEach((_value, name) => {
    if (name.startsWith('x-openkit-')) {
      openKitHeaders.push(name);
    }
  });
  if (openKitHeaders.length !== 1 || openKitHeaders[0] !== FILE_DATA_HEADERS.requestId) {
    throw effectTransportError(400, 'NanoHost image build input headers are noncanonical.');
  }
  const requestId = request.headers.get(FILE_DATA_HEADERS.requestId) ?? '';
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw effectTransportError(409, 'NanoHost image build input has no matching request.');
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && declaredLength !== '2') {
    throw effectTransportError(400, 'NanoHost image build input body is noncanonical.');
  }
  let body: Buffer;
  try {
    body = Buffer.from(await request.arrayBuffer());
  } catch {
    throw effectTransportError(500, 'NanoHost image build input body read failed.');
  }
  if (Buffer.compare(body, Buffer.from('{}')) !== 0) {
    throw effectTransportError(400, 'NanoHost image build input body is noncanonical.');
  }
  return requestId;
}

/**
 * Creates one bounded raw response and releases its shared file-data reservation on completion.
 *
 * @param body Complete verified bytes retained by the current effect owner.
 * @param headers Exact operation-specific raw response headers.
 * @param release Releases the single application file-data reservation once.
 * @returns Raw response whose application chunks never exceed 65,536 bytes.
 * @throws A redacted 500 transport error when the response stream cannot be created.
 */
function createChunkedFileDataResponse(
  body: Uint8Array,
  headers: Readonly<Record<string, string>>,
  release: () => void
): Response {
  let offset = 0;
  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      release();
    }
  };
  try {
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel: releaseOnce,
        pull(controller) {
          if (offset === body.byteLength) {
            controller.close();
            releaseOnce();
            return;
          }
          const end = Math.min(offset + FILE_DATA_CHUNK_BYTES, body.byteLength);
          controller.enqueue(body.subarray(offset, end));
          offset = end;
        },
      }),
      { headers, status: 200 }
    );
  } catch {
    releaseOnce();
    throw effectTransportError(500, 'NanoHost file-data response stream failed.');
  }
}

/**
 * Validates one raw import command and preserves its exact bytes.
 * @param value Internal fixed-effect input.
 * @param requestId Deterministic effect identity.
 * @returns Canonical raw import command.
 * @throws A 400 or 409 transport error when metadata or bytes disagree.
 */
function requireReferenceImportCommand(
  value: Readonly<Record<string, unknown>>,
  requestId: string
): Readonly<{
  body: Buffer;
  byteLength: number;
  relativePath: string;
  requestId: string;
  sandboxId: string;
  sha256: string;
  slot: string;
}> {
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'backendSessionId',
          'body',
          'byteLength',
          'leaseId',
          'packageSnapshotId',
          'relativePath',
          'requestId',
          'sandboxId',
          'sha256',
          'slot',
        ].includes(key)
    )
  ) {
    throw effectTransportError(400, 'NanoHost effect command contains an unowned field.');
  }
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw effectTransportError(400, 'NanoHost file effect requestId is invalid.');
  }
  const bodyValue = value.body;
  const body = Buffer.isBuffer(bodyValue)
    ? bodyValue
    : bodyValue instanceof Uint8Array
      ? Buffer.from(bodyValue)
      : null;
  const byteLength = readCanonicalByteLength(value.byteLength);
  const relativePath = readRelativePath(value.relativePath);
  const sandboxId = readBoundedIdentity(value.sandboxId, 'sandbox');
  const sha256 = readSha256(value.sha256);
  const slot = readSlot(value.slot);
  if (
    !body ||
    body.byteLength !== byteLength ||
    `sha256:${createHash('sha256').update(body).digest('hex')}` !== sha256
  ) {
    throw effectTransportError(409, 'NanoHost import bytes do not match their identity.');
  }
  return { body, byteLength, relativePath, requestId, sandboxId, sha256, slot };
}

/**
 * Reads one bounded internal lineage identity without accepting path syntax.
 * @param value Candidate identity value.
 * @param name Diagnostic identity class.
 * @returns Validated identity.
 * @throws A 400 transport error for invalid input.
 */
function readBoundedIdentity(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes('/') ||
    value.includes('\\') ||
    [...value].some((character) => (character.codePointAt(0) ?? 0) <= 31)
  ) {
    throw effectTransportError(400, `NanoHost file-data ${name} identity is invalid.`);
  }
  return value;
}

/**
 * Reads and validates the five exact raw file-data headers.
 * @param headers Native request headers.
 * @returns Canonical file result identity and request id.
 * @throws A 400, 409, or 413 transport error for contradictory metadata.
 */
function readFileDataHeaders(headers: Headers): NanoHostFileResultIdentity & {
  readonly requestId: string;
} {
  if (headers.get('content-type') !== FILE_DATA_CONTENT_TYPE) {
    throw effectTransportError(400, 'NanoHost file-data content type is invalid.');
  }
  const requestId = headers.get(FILE_DATA_HEADERS.requestId) ?? '';
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw effectTransportError(400, 'NanoHost file effect requestId is invalid.');
  }
  const encodedPath = headers.get(FILE_DATA_HEADERS.relativePath) ?? '';
  const relativePath = decodeRelativePath(encodedPath);
  const byteLengthText = headers.get(FILE_DATA_HEADERS.byteLength) ?? '';
  const contentLengthText = headers.get('content-length') ?? '';
  const byteLength = readCanonicalByteLengthText(byteLengthText);
  if (contentLengthText !== byteLengthText) {
    throw effectTransportError(409, 'NanoHost file-data content length disagrees.');
  }
  return {
    byteLength,
    relativePath,
    requestId,
    sha256: readSha256(headers.get(FILE_DATA_HEADERS.sha256)),
    slot: readSlot(headers.get(FILE_DATA_HEADERS.slot)),
  };
}

/**
 * Requires one raw result to match its accepted path-only export command.
 * @param pending Accepted pending export.
 * @param metadata Verified raw result metadata.
 * @throws A 409 or 413 transport error when lineage, proof, or bounds disagree.
 */
function requirePendingFileExport(
  pending: PendingNanoHostEffect,
  metadata: NanoHostFileResultIdentity & { readonly requestId: string }
): void {
  if (!pending.accepted || pending.requestId !== metadata.requestId || !pending.command) {
    throw effectTransportError(409, 'NanoHost file export is not the accepted pending command.');
  }
  if (
    pending.command.slot !== metadata.slot ||
    pending.command.relativePath !== metadata.relativePath ||
    (pending.command.purpose !== 'artifact-submission' &&
      pending.command.terminalBarrierProved !== true)
  ) {
    throw effectTransportError(409, 'NanoHost file export metadata disagrees with its command.');
  }
  const maximum = readCanonicalByteLength(pending.command.maxByteLength);
  if (metadata.byteLength > maximum) {
    throw effectTransportError(413, 'NanoHost file export exceeds its bound.');
  }
}

/** Streams one raw export into fsynced request-private staging and verifies its identity. */
async function stageFileExport(
  request: Request,
  metadata: Pick<NanoHostFileResultIdentity, 'byteLength' | 'sha256'>,
  signal?: AbortSignal
): Promise<{ readonly directory: string; readonly path: string }> {
  let directory = '';
  let file: Awaited<ReturnType<typeof open>> | null = null;
  const digest = createHash('sha256');
  let observed = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    void reader?.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    directory = await mkdtemp(join(tmpdir(), 'openkit-nanocore-file-export-'));
    const partialPath = join(directory, '.partial');
    const finalPath = join(directory, 'complete');
    file = await open(partialPath, 'wx', 0o600);
    reader = request.body?.getReader();
    if (!reader && metadata.byteLength !== 0) {
      throw effectTransportError(409, 'NanoHost file export body is incomplete.');
    }
    while (reader) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      for (let offset = 0; offset < chunk.value.byteLength; offset += FILE_DATA_CHUNK_BYTES) {
        const slice = chunk.value.subarray(offset, offset + FILE_DATA_CHUNK_BYTES);
        observed += slice.byteLength;
        if (observed > FILE_DATA_MAX_BYTES || observed > metadata.byteLength) {
          throw effectTransportError(413, 'NanoHost file export exceeds its bound.');
        }
        digest.update(slice);
        await file.write(slice);
      }
    }
    signal?.throwIfAborted();
    if (observed !== metadata.byteLength || `sha256:${digest.digest('hex')}` !== metadata.sha256) {
      throw effectTransportError(409, 'NanoHost file export digest or length disagrees.');
    }
    await file.sync();
    await file.close();
    await rename(partialPath, finalPath);
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    signal?.removeEventListener('abort', cancel);
    reader?.releaseLock();
    return { directory, path: finalPath };
  } catch (error) {
    signal?.removeEventListener('abort', cancel);
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    await file?.close().catch(() => undefined);
    if (directory) {
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }
    const status = (error as { readonly status?: unknown } | null)?.status;
    if (status === 400 || status === 409 || status === 413) {
      throw error;
    }
    throw effectTransportError(500, 'NanoHost file export staging failed.');
  }
}

/**
 * Returns whether a raw export is an exact already-complete duplicate.
 * @param left Previously completed identity, when present.
 * @param right Candidate redelivery identity.
 * @returns Whether every immutable field is identical.
 */
function sameFileResult(
  left: NanoHostFileResultIdentity | undefined,
  right: NanoHostFileResultIdentity
): boolean {
  return Boolean(
    left &&
      left.byteLength === right.byteLength &&
      left.relativePath === right.relativePath &&
      left.sha256 === right.sha256 &&
      left.slot === right.slot
  );
}

/**
 * Reads one canonical bounded byte length from an internal command.
 * @param value Candidate numeric length.
 * @returns Exact safe integer within the V1 file bound.
 * @throws A 413 transport error when invalid or oversized.
 */
function readCanonicalByteLength(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > FILE_DATA_MAX_BYTES
  ) {
    throw effectTransportError(413, 'NanoHost file-data byte length exceeds its bound.');
  }
  return value as number;
}

/**
 * Reads one canonical decimal bounded byte length from a raw header.
 * @param value Candidate decimal header text.
 * @returns Exact safe integer within the V1 file bound.
 * @throws A 400 or 413 transport error when invalid.
 */
function readCanonicalByteLengthText(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw effectTransportError(400, 'NanoHost file-data byte length is invalid.');
  }
  return readCanonicalByteLength(Number(value));
}

/**
 * Reads one canonical lowercase SHA-256 identity.
 * @param value Candidate digest.
 * @returns Canonical prefixed digest.
 * @throws A 400 transport error for any other spelling.
 */
function readSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw effectTransportError(400, 'NanoHost file-data digest is invalid.');
  }
  return value;
}

/**
 * Reads one declared package slot without accepting path syntax.
 * @param value Candidate slot id.
 * @returns Validated slot id.
 * @throws A 400 transport error for invalid syntax.
 */
function readSlot(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw effectTransportError(400, 'NanoHost file-data slot is invalid.');
  }
  return value;
}

/**
 * Reads one normalized relative path from an internal command.
 * @param value Candidate relative path.
 * @returns Validated normalized relative path.
 * @throws A 400 transport error for unsafe path syntax.
 */
function readRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !isNormalizedRelativePath(value)) {
    throw effectTransportError(400, 'NanoHost file-data relative path is invalid.');
  }
  return value;
}

/**
 * Encodes a normalized path segment-by-segment with canonical uppercase escapes.
 * @param value Validated relative path.
 * @returns Canonical wire spelling.
 * @throws A 400 transport error when the path cannot fit the bound.
 */
function encodeRelativePath(value: string): string {
  const encoded = readRelativePath(value)
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(/%[0-9a-f]{2}/g, (part) => part.toUpperCase())
    )
    .join('/');
  if (Buffer.byteLength(encoded, 'utf8') > 4096) {
    throw effectTransportError(400, 'NanoHost file-data relative path is invalid.');
  }
  return encoded;
}

/**
 * Decodes and verifies the canonical wire spelling of one relative path.
 * @param value Encoded wire path.
 * @returns Validated decoded relative path.
 * @throws A 400 transport error for malformed or noncanonical encoding.
 */
function decodeRelativePath(value: string): string {
  let decoded: string;
  try {
    decoded = value
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    throw effectTransportError(400, 'NanoHost file-data relative path is invalid.');
  }
  if (encodeRelativePath(decoded) !== value) {
    throw effectTransportError(400, 'NanoHost file-data relative path is noncanonical.');
  }
  return decoded;
}

/**
 * Returns whether a string is one safe normalized UTF-8 slot-relative path.
 * @param value Candidate relative path.
 * @returns Whether every path segment is safe and normalized.
 */
function isNormalizedRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    }) &&
    value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

/**
 * Creates one private transport rejection carrying its exact HTTP status.
 * @param status Fixed private response status.
 * @param message Bounded private diagnostic.
 * @returns Tagged error consumed only by the private route projection.
 */
function effectTransportError(status: 400 | 409 | 413 | 500, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Sends and closes one rejected native H2 stream before an invalid surplus body can be admitted.
 *
 * @param environment Native Hono Node adapter bindings for the accepted physical connection.
 * @param status Exact private transport rejection status.
 * @returns Adapter sentinel response proving the native response was already sent.
 */
function closeRejectedNativeFileStream(environment: unknown, status: 409): Response {
  const bindings = environment as
    | {
        readonly incoming?: { readonly stream?: { close(code?: number): void } };
        readonly outgoing?: { end(): void; writeHead(status: number, headers: object): void };
      }
    | undefined;
  if (!bindings?.outgoing || !bindings.incoming?.stream) {
    return privateEffectError(effectTransportError(status, 'NanoHost file export retry rejected.'));
  }
  bindings.outgoing.writeHead(status, { 'content-length': '0' });
  bindings.outgoing.end();
  bindings.incoming.stream.close(0);
  return new Response(null, {
    headers: { 'x-hono-already-sent': '1' },
    status,
  });
}

/**
 * Reads one semantic request body under its existing family ceiling.
 *
 * @param request Native outer-session request.
 * @param maximumBytes Exact owning-family byte ceiling.
 * @returns Complete body bytes forwarded unchanged to the existing route owner.
 * @throws A 413 transport error when the declared or observed body is oversized.
 */
async function readBoundedSemanticBody(
  request: Request,
  maximumBytes: number
): Promise<ArrayBuffer> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    throw effectTransportError(413, 'NanoHost semantic route body exceeds its bound.');
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > maximumBytes) {
    throw effectTransportError(413, 'NanoHost semantic route body exceeds its bound.');
  }
  return body;
}

/** Reads one bounded JSON object without accepting control-plane bulk bytes. */
async function readBoundedJsonObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > CONTROL_BODY_MAX_BYTES) {
    throw new Error('NanoHost effect body exceeds its bound.');
  }
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NanoHost effect body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

/** Reads collection control bytes within the owner ceiling and rejects duplicate decoded core keys. */
async function readWorkspaceCollectionJson(
  request: Request,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Workspace collection result body is absent.');
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512 * 1024) throw new Error('Workspace collection result exceeds its bound.');
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Workspace collection result must be an object.');
  const rootCore = new Set([
    'requestId',
    'outcome',
    'cause',
    'head',
    'previousHead',
    'acceptedBase',
    'unstable',
  ]);
  const pairCore = new Set(['tree', 'manifest']);
  const frames: Array<{
    object: boolean;
    expectKey: boolean;
    field: string | null;
    core: Set<string> | null;
    seen: Set<string> | null;
  }> = [];
  // jsonc-parser declares SyntaxKind as an ambient const enum, unavailable with verbatimModuleSyntax. These are its fixed scanner codes, not a new wire vocabulary.
  const SyntaxKind = {
    OpenBraceToken: 1,
    CloseBraceToken: 2,
    OpenBracketToken: 3,
    CloseBracketToken: 4,
    CommaToken: 5,
    StringLiteral: 10,
    EOF: 17,
  } as const;
  const scanner = createScanner(text, true);
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    const parent = frames.at(-1);
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      const core =
        frames.length === 0
          ? rootCore
          : frames.length === 1 &&
              parent?.field &&
              ['head', 'previousHead', 'acceptedBase'].includes(parent.field)
            ? pairCore
            : null;
      if (parent) parent.field = null;
      frames.push({
        object: token === SyntaxKind.OpenBraceToken,
        expectKey: true,
        field: null,
        core,
        seen: core ? new Set() : null,
      });
    } else if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken)
      frames.pop();
    else if (token === SyntaxKind.CommaToken && parent?.object) parent.expectKey = true;
    else if (token === SyntaxKind.StringLiteral && parent?.object && parent.expectKey) {
      const name = scanner.getTokenValue();
      parent.expectKey = false;
      parent.field = name;
      if (parent.core?.has(name)) {
        if (parent.seen?.has(name))
          throw new Error('Workspace collection result duplicates a core member.');
        parent.seen?.add(name);
      }
    }
  }
  return value as Record<string, unknown>;
}

/** Reads the opaque native HTTP/2 connection from one route context. */
function requirePhysicalConnection(environment: unknown): object {
  const physicalConnection = readNanoHostPhysicalConnectionContext(
    (environment as { readonly incoming?: unknown } | undefined)?.incoming
  );
  if (!physicalConnection) {
    throw new Error('NanoHost physical connection context is required.');
  }
  return physicalConnection;
}

/** Returns a bounded private transport error without exposing runtime inputs. */
function privateEffectError(error: unknown): Response {
  if (error instanceof WorkerImageSettlementDeferred) return new Response(null, { status: 503 });
  const message = error instanceof Error ? error.message : 'NanoHost effect request failed.';
  const explicitStatus = (error as { readonly status?: unknown } | null)?.status;
  const status =
    explicitStatus === 400 ||
    explicitStatus === 409 ||
    explicitStatus === 413 ||
    explicitStatus === 500
      ? explicitStatus
      : message.includes('exceeds its bound')
        ? 413
        : message.includes('JSON') ||
            message.includes('empty object') ||
            message.includes('requestId')
          ? 400
          : 409;
  return asApiError(message, 'nanohost_transport_effect_rejected', status);
}

/** Rejects unbound, candidate, and fenced physical connections. */
function requireAuthoritativeSession(
  authority: NanoHostTransportSessionAuthority,
  physicalConnection: object
): void {
  if (!authority.mayCarryWork(physicalConnection)) {
    throw new Error('NanoHost physical connection is not authoritative or has been fenced.');
  }
}

/** Reads the known image outcome before durable write or replay comparison. */
function imageSettlementOutcome(
  result: Readonly<Record<string, unknown>>
): WorkerImageSettlement['outcome'] {
  if (result.failureCode === 'effect_failed')
    return { kind: 'failure', failureCode: 'effect_failed' };
  if (typeof result.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(result.digest)) {
    throw new WorkerImageSettlementConflict();
  }
  return { kind: 'success', imageDigest: result.digest };
}

/** Reuses only an identical durable preparation outcome, without dispatching its command again. */
function settledImageResult(
  known: WorkerImageSettlement,
  identity: WorkerImageSettlementIdentity,
  requestId: string,
  operation: string
): { digest: string } {
  const expected = WorkerImageSettlementSchema.parse({
    ...identity,
    requestId,
    operation,
    outcome: known.outcome,
  });
  if (JSON.stringify(known) !== JSON.stringify(expected)) throw new WorkerImageSettlementConflict();
  if (known.outcome.kind === 'failure')
    throw effectTransportError(500, 'NanoHost effect failed: effect_failed.');
  return { digest: known.outcome.imageDigest };
}

/** Strips descriptive effect-result additions before receipt identity or any consumer sees them. */
function readNanoHostEffectResult(
  operation: NanoHostEffectOperation,
  result: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  if (Object.hasOwn(result, 'failureCode')) {
    if (
      ['digest', 'state', 'sandboxId', 'accepted', 'integrationReady'].some((name) =>
        Object.hasOwn(result, name)
      )
    )
      throw effectTransportError(409, 'NanoHost effect failure conflicts with success fields.');
    return resultFields(result, ['requestId', 'failureCode']);
  }
  switch (operation) {
    case 'image.acquire':
    case 'image.build':
      return resultFields(result, ['requestId', 'digest']);
    case 'sandbox.delete':
    case 'bridge.close':
      return resultFields(result, ['requestId', 'sandboxId', 'state']);
    case 'bridge.open':
      return resultFields(result, ['requestId', 'accepted', 'integrationReady', 'state']);
    case 'reference.import':
      return resultFields(result, ['requestId', 'byteLength', 'reference']);
    case 'file.export':
      return resultFields(result, ['requestId', 'state', 'reasonCode']);
    case 'storage.purge':
      return resultFields(result, ['requestId', 'state', 'storageRef']);
    case 'storage.inspect': {
      const core = resultFields(result, [
        'requestId',
        'attachment',
        'capacity',
        'layoutDigest',
        'scopeDigest',
        'state',
        'storageRef',
        'targets',
      ]);
      if (core.attachment !== null && core.attachment !== undefined)
        core.attachment = resultFields(core.attachment, ['generation', 'sandboxId']);
      core.capacity = resultFields(core.capacity, ['availableBytes', 'totalBytes']);
      if (Array.isArray(core.targets))
        core.targets = core.targets.map((target) =>
          resultFields(target, ['initialized', 'target', 'volumeRef'])
        );
      return core;
    }
    case 'sandbox.create': {
      const core = resultFields(result, ['requestId', 'sandboxId', 'state', 'storage']);
      if (core.storage !== undefined) {
        const storage = resultFields(core.storage, [
          'attachmentGeneration',
          'layoutDigest',
          'scopeDigest',
          'storageRef',
          'targets',
        ]);
        if (Array.isArray(storage.targets))
          storage.targets = storage.targets.map((target) =>
            resultFields(target, ['initialized', 'target', 'volumeRef'])
          );
        core.storage = storage;
      }
      return core;
    }
    case 'image.inspect': {
      const core = resultFields(result, [
        'requestId',
        'digest',
        'platform',
        'storageLayout',
        'environmentDefaults',
      ]);
      if (core.platform !== undefined)
        core.platform = resultFields(core.platform, ['architecture', 'os']);
      if (core.storageLayout !== undefined) {
        const layout = resultFields(core.storageLayout, [
          'family',
          'gid',
          'uid',
          'version',
          'workingDirectory',
          'targets',
        ]);
        if (Array.isArray(layout.targets))
          layout.targets = layout.targets.map((target) => resultFields(target, ['target']));
        core.storageLayout = layout;
      }
      if (core.environmentDefaults !== undefined)
        core.environmentDefaults = resultFields(core.environmentDefaults, [
          'defaultsDigest',
          'values',
        ]);
      return core;
    }
    case 'workspace.collect':
      // Its existing wire reader already admitted the collection core above.
      return { ...result };
  }
}

/** Selects only known descriptive fields without inventing missing required values. */
function resultFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw effectTransportError(409, 'NanoHost effect result object is invalid.');
  return Object.fromEntries(Object.entries(value).filter(([name]) => fields.includes(name)));
}

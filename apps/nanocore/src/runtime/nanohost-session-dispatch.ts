import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentEnvironmentDockerfileInputSchema,
  DOCKERFILE_INPUT_MAX_BYTES,
} from '@openkit/config-schema';
import type { Hono } from 'hono';

import { asApiError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  isNanoHostPhysicalConnectionContext,
  type NanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import type { CoreDb } from '../storage/db.js';
import {
  dispatchNanoHostHarnessOperation,
  type NanoHostHarnessCommand,
  type NanoHostHarnessResult,
  settleNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import { upsertNanoHostRuntimeTarget } from './nanohost-runtime-target.js';

const CONTROL_BODY_MAX_BYTES = 1024 * 1024;
/** Exact outer-session inference request ceiling preserved from its semantic owner. */
const INFERENCE_BODY_MAX_BYTES = 2 * 1024 * 1024;
/** Exact outer-session capability request ceiling. */
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
  'file.export',
  'reference.import',
] as const;

/** One fixed NanoHost-owned runtime effect operation. */
export type NanoHostEffectOperation = (typeof NANO_HOST_EFFECT_OPERATIONS)[number];

/** Exact private command/result paths for the closed NanoHost effect vocabulary. */
const NANO_HOST_EFFECT_PATHS = {
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
  readonly input: Readonly<Record<string, unknown>>;
  readonly kind: NanoHostEffectOperation | string;
  /** Deterministic opaque effect identity produced from durable attempt lineage. */
  readonly requestId?: string;
}

/** One exact accepted effect identity reconstructed without replay authority. */
export interface NanoHostResultOnlyExpectation {
  readonly kind: 'bridge.close' | 'sandbox.delete';
  readonly requestId: string;
}

/** One exact retained result matched to its reconstructed effect identity. */
export interface NanoHostResultOnlySettlement {
  readonly kind: NanoHostResultOnlyExpectation['kind'];
  readonly result: unknown;
}

/** Dependencies for authoritative session dispatch. */
export interface CreateNanoHostSessionDispatchInput {
  /** Optional direct handler used by lower-level dispatcher checks. */
  readonly effectHandler?: (request: NanoHostSessionEffectRequest) => Promise<unknown>;
  /** Optional semantic-route handler used by the shared outer session. */
  readonly routeHandler?: (request: NanoHostSessionRouteRequest) => Promise<unknown>;
  readonly sessionAuthority: NanoHostTransportSessionAuthority;
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
    runtimeTarget?: {
      readonly coreDb: CoreDb;
      readonly deploymentId: string;
      readonly identityId: string;
      readonly targetId: string;
    }
  ): Promise<void>;
  /** Dispatches one existing semantic route on the current generation. */
  route(physicalConnection: object, request: NanoHostSessionRouteRequest): Promise<unknown>;
}

/** One process-local pending effect owned by the dispatcher. */
interface PendingNanoHostEffect {
  acceptedConnection?: object;
  command: Readonly<Record<string, unknown>> | null;
  /** Rejects the existing caller promise for one acknowledged definite failure. */
  readonly reject: (error: Error) => void;
  readonly requestId: string;
  readonly resolve: (result: unknown) => void;
  accepted: boolean;
  imageBuildInputServed?: boolean;
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
  readonly harnessCommandDispatched?: ((command: NanoHostHarnessCommand) => void) | undefined;
  /** Live runtime owner that advances the exact settled Harness operation. */
  readonly harnessResultSettled?: ((result: NanoHostHarnessResult) => void) | undefined;
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
  const readyPhysicalConnections = new WeakSet<object>();

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
        let command: Readonly<Record<string, unknown>>;
        if (operation === 'reference.import') {
          command = requireReferenceImportCommand(request.input, requestId);
        } else if (operation === 'image.build') {
          command = requireImageBuildCommand(request.input, requestId);
        } else if (operation === 'bridge.open') {
          command = requireBridgeOpenCommand(request.input, requestId);
        } else if (operation === 'file.export') {
          command = requireFileExportCommand(request.input, requestId);
        } else {
          command = { ...request.input, requestId };
        }
        if (pendingEffects.has(operation)) {
          throw new Error(`NanoHost effect ${operation} already has a pending command.`);
        }
        completedEffects.delete(operation);
        return new Promise<unknown>((resolve, reject) => {
          pendingEffects.set(operation, {
            accepted: false,
            command,
            reject,
            requestId,
            resolve,
          });
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
        if (
          !['bridge.close', 'sandbox.delete'].includes(expectation.kind) ||
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
            reject,
            requestId: expectation.requestId,
            resolve: (value) => resolve(value as NanoHostResultOnlySettlement),
            resultOnlyGroup: group,
          });
        }
      });
      void resultPromise.catch(() => undefined);
      return resultPromise;
    },

    async poll(physicalConnection, operation) {
      requireAuthoritativeSession(input.sessionAuthority, physicalConnection);
      if (!readyPhysicalConnections.has(physicalConnection)) {
        throw new Error('NanoHost physical connection has not completed durable readiness.');
      }
      const pendingResultOnly = [...pendingEffects.values()].find(
        (candidate) => candidate.resultOnlyGroup
      );
      if (pendingResultOnly) {
        const unknown = effectTransportError(
          409,
          'NanoHost accepted effect outcome is unknown; successor connection fenced.'
        );
        removePendingEffectGroup(pendingEffects, operation, pendingResultOnly);
        pendingResultOnly.reject(unknown);
        input.sessionAuthority.closePhysicalConnection(physicalConnection);
        throw unknown;
      }
      const pending = pendingEffects.get(operation);
      if (!pending) {
        return null;
      }
      if (pending.accepted && pending.acceptedConnection !== physicalConnection) {
        const unknown = effectTransportError(
          409,
          'NanoHost accepted effect outcome is unknown; successor connection fenced.'
        );
        removePendingEffectGroup(pendingEffects, operation, pending);
        pending.reject(unknown);
        input.sessionAuthority.closePhysicalConnection(physicalConnection);
        throw unknown;
      }
      if (pending.accepted) {
        return null;
      }
      if (!pending.command) {
        throw new Error('NanoHost effect command is unavailable.');
      }
      pending.accepted = true;
      pending.acceptedConnection = physicalConnection;
      const command = { ...pending.command };
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
      if (Buffer.compare(Buffer.from(body), Buffer.from('{}')) !== 0) {
        throw new Error('NanoHost readiness body must be the exact empty object.');
      }
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
        predecessorFenced: true,
        ready: true,
        targetId: runtimeTarget.targetId,
      });
      readyPhysicalConnections.add(physicalConnection);
    },

    async result(physicalConnection, operation, result) {
      requireAuthoritativeSession(input.sessionAuthority, physicalConnection);
      const requestId = readRequestId(result);
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
      if (operation === 'file.export' && !isExactFileAbsence) {
        throw effectTransportError(409, 'NanoHost file export JSON result is invalid.');
      }
      const resultBody = Object.fromEntries(
        Object.entries(result).filter(([name]) => name !== 'requestId')
      );
      const resultJson = JSON.stringify(resultBody);
      const pending = pendingEffects.get(operation);
      if (!pending) {
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
      if (isExactFileAbsence && pending.command?.presence !== 'optional') {
        throw effectTransportError(409, 'NanoHost required file export cannot be absent.');
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

      pendingEffects.delete('file.export');
      completedEffects.set('file.export', {
        fileResult: metadata,
        redeliveredConnection: physicalConnection,
        requestId: metadata.requestId,
        resultJson: JSON.stringify(metadata),
      });
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

/** Removes one ordinary pending effect or every member of its result-only correlation set. */
function removePendingEffectGroup(
  pendingEffects: Map<NanoHostEffectOperation, PendingNanoHostEffect>,
  operation: NanoHostEffectOperation,
  pending: PendingNanoHostEffect
): void {
  if (!pending.resultOnlyGroup) {
    pendingEffects.delete(operation);
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
          if (Object.keys(value).length !== 1 || value.schemaVersion !== 2) {
            throw new Error('NanoHost private Harness poll body is invalid.');
          }
          const command = dispatchNanoHostHarnessOperation(input.coreDb, {
            sandboxIntegrationBindingRef,
          });
          if (command) {
            input.harnessCommandDispatched?.(command);
          }
          return command ? context.json(command, 200) : context.body(null, 204);
        }
        const result = value as unknown as NanoHostHarnessResult;
        settleNanoHostHarnessOperation(input.coreDb, {
          sandboxIntegrationBindingRef,
          result,
          timestamp: new Date().toISOString(),
        });
        input.harnessResultSettled?.(result);
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
        const body = await readBoundedJsonObject(context.req.raw);
        if (Object.keys(body).length !== 0) {
          throw new Error('NanoHost effect poll body must be an empty object.');
        }
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
      try {
        const physicalConnection = requirePhysicalConnection(context.env);
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
        const result = await readBoundedJsonObject(context.req.raw);
        await input.dispatch.result(physicalConnection, operation, result);
        return context.body(null, 204);
      } catch (error) {
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
  const requestId = request.requestId ?? readRequestId(request.input);
  return { operation: request.kind, requestId };
}

/** Returns whether a string is one of the eight fixed effect operations. */
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
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw effectTransportError(400, 'NanoHost file export requestId is invalid.');
  }
  if (value.presence !== 'required' && value.presence !== 'optional') {
    throw effectTransportError(400, 'NanoHost file export presence is invalid.');
  }
  return { ...value, requestId };
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
    Object.keys(result).length !== 3 ||
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
    pending.command.terminalBarrierProved !== true
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
  metadata: NanoHostFileResultIdentity
): Promise<{ readonly directory: string; readonly path: string }> {
  let directory = '';
  let file: Awaited<ReturnType<typeof open>> | null = null;
  const digest = createHash('sha256');
  let observed = 0;
  try {
    directory = await mkdtemp(join(tmpdir(), 'openkit-nanocore-file-export-'));
    const partialPath = join(directory, '.partial');
    const finalPath = join(directory, 'complete');
    file = await open(partialPath, 'wx', 0o600);
    const reader = request.body?.getReader();
    if (!reader && metadata.byteLength !== 0) {
      throw effectTransportError(409, 'NanoHost file export body is incomplete.');
    }
    while (reader) {
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
    return { directory, path: finalPath };
  } catch (error) {
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

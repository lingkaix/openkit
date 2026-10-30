import {
  WORKER_CONTROL_EVENT_APPEND_MAX_BYTES,
  WorkerCanonicalEventRecordReaderSchema,
  WorkerCanonicalTerminalEventDataReaderSchema,
  WorkerCapabilityCallSummaryReaderSchema,
  WorkerControlHeartbeatRequestReaderSchema,
  WorkerControlRequestEnvelopeReaderSchema,
  WorkerControlSupplyRefreshAckBodyReaderSchema,
} from '@openkit/worker-protocol';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { asInvalidRequestError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { CoreDb } from '../storage/db.js';
import { listSchedulerExecutionAttemptsForTurn } from './execution-attempt-records.js';
import {
  type NanoHostExecutionAttemptRecord,
  requireNanoHostExecutionAttempt,
} from './nanohost-attempt-records.js';
import {
  type WorkerControlGateway,
  WorkerControlGatewayError,
  type WorkerControlLineage,
} from './worker-control-gateway.js';
import { recordWorkerControlRejectedEvidence } from './worker-control-rejected-evidence.js';
import {
  asWorkerControlApiError,
  type ParsedJsonRequest,
  parseBoundedJsonRequest,
  WorkerControlLineageRequestSchema,
} from './worker-http.js';

const WorkerControlArtifactNoticeRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  sequence: z.number().int().nonnegative(),
  artifact: z.object({
    title: z.string().min(1),
    path: z.string().min(1),
    mediaType: z.string().min(1).nullable().optional(),
    digest: z.string().min(1).nullable().optional(),
    collectionHint: z.string().min(1).nullable().optional(),
  }),
});
const WorkerControlEventAppendRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  record: WorkerCanonicalEventRecordReaderSchema,
});
const WORKER_CONTROL_REQUEST_MAX_BYTES = 64 * 1024;

/**
 * Registers the sandbox-authenticated direct worker-control routes.
 *
 * @param dependencies Worker control HTTP dependencies owned by the app composition root.
 */
export function registerWorkerControlRoutes({
  app,
  coreDb,
  workerControlGateway,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly workerControlGateway: WorkerControlGateway;
}): void {
  app.post('/api/worker-control/heartbeat', async (c) => {
    const arrivedAt = new Date().toISOString();
    const parsed = await parseWorkerControlRequest(c, WorkerControlHeartbeatRequestReaderSchema);

    if (!parsed.success) {
      observeControlRequest(
        coreDb,
        undefined,
        'heartbeat',
        null,
        arrivedAt
      )(parsed.response.status, 'invalid_request');
      return parsed.response;
    }

    const diagnose = observeControlRequest(
      coreDb,
      parsed.data.lineage,
      'heartbeat',
      parsed.data.sequence,
      arrivedAt
    );
    const authentication = workerControlTokenHashAuthentication(c);
    try {
      const response = c.json(
        workerControlGateway.recordHeartbeat({
          ...parsed.data,
          ...authentication.input,
        })
      );
      diagnose(response.status);
      return response;
    } catch (error) {
      diagnose(
        error instanceof WorkerControlGatewayError ? error.status : 500,
        error instanceof WorkerControlGatewayError ? error.code : 'internal_error'
      );
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: authentication.authenticatedLineage(),
        operation: 'heartbeat',
        route: '/api/worker-control/heartbeat',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/artifacts', async (c) => {
    const arrivedAt = new Date().toISOString();
    const parsed = await parseWorkerControlRequest(c, WorkerControlArtifactNoticeRequestSchema);

    if (!parsed.success) {
      observeControlRequest(
        coreDb,
        undefined,
        'artifact_notice',
        null,
        arrivedAt
      )(parsed.response.status, 'invalid_request');
      return parsed.response;
    }

    const diagnose = observeControlRequest(
      coreDb,
      parsed.data.lineage,
      'artifact_notice',
      parsed.data.sequence,
      arrivedAt
    );
    const authentication = workerControlTokenHashAuthentication(c);
    try {
      const response = c.json({
        artifact: workerControlGateway.recordArtifactNotice({
          artifact: parsed.data.artifact,
          ...authentication.input,
          lineage: parsed.data.lineage,
          sequence: parsed.data.sequence,
        }),
      });
      diagnose(response.status);
      return response;
    } catch (error) {
      diagnose(
        error instanceof WorkerControlGatewayError ? error.status : 500,
        error instanceof WorkerControlGatewayError ? error.code : 'internal_error'
      );
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: authentication.authenticatedLineage(),
        operation: 'artifact_notice',
        route: '/api/worker-control/artifacts',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/events/append', async (c) => {
    const arrivedAt = new Date().toISOString();
    const parsed = await parseWorkerControlEventAppendRequest(c);

    if (!parsed.success) {
      observeControlRequest(
        coreDb,
        undefined,
        'event_append',
        null,
        arrivedAt
      )(parsed.response.status, 'invalid_request');
      return parsed.response;
    }

    const diagnose = observeControlRequest(
      coreDb,
      parsed.data.lineage,
      'event_append',
      parsed.data.record.sequence,
      arrivedAt
    );
    const authentication = workerControlTokenHashAuthentication(c);
    try {
      const accepted = workerControlGateway.appendEvent({
        ...authentication.input,
        lineage: parsed.data.lineage,
        record: parsed.data.record,
      });
      const response = c.json(accepted instanceof Promise ? await accepted : accepted);
      diagnose(response.status);
      return response;
    } catch (error) {
      diagnose(
        error instanceof WorkerControlGatewayError ? error.status : 500,
        error instanceof WorkerControlGatewayError ? error.code : 'internal_error'
      );
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: authentication.authenticatedLineage(),
        operation: 'event_append',
        route: '/api/worker-control/events/append',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/final-status', async (c) => {
    const arrivedAt = new Date().toISOString();
    const parsed = await parseWorkerControlEnvelope(c);

    if (!parsed.success) {
      observeControlRequest(
        coreDb,
        undefined,
        'final_status',
        null,
        arrivedAt
      )(parsed.response.status, 'invalid_request');
      return parsed.response;
    }

    const diagnose = observeControlRequest(
      coreDb,
      parsed.data.lineage,
      'final_status',
      parsed.data.sequence,
      arrivedAt
    );

    if (parsed.data.operation !== 'final_status') {
      diagnose(400, 'invalid_request');
      return asInvalidRequestError(new Error('Worker control operation must be final_status.'));
    }

    const body = WorkerCanonicalTerminalEventDataReaderSchema.safeParse(parsed.data.body);

    if (!body.success) {
      diagnose(400, 'invalid_request');
      return asInvalidRequestError(body.error);
    }

    const authentication = workerControlTokenHashAuthentication(c);
    try {
      const response = c.json(
        workerControlGateway.recordFinalStatus({
          ...authentication.input,
          ...(body.data.diagnostics ? { diagnostics: body.data.diagnostics } : {}),
          evidenceManifestDigests: body.data.evidenceManifestDigests,
          lineage: parsed.data.lineage,
          sequence: parsed.data.sequence,
          status: body.data.status,
          stopReason: body.data.stopReason,
        })
      );
      diagnose(response.status);
      return response;
    } catch (error) {
      diagnose(
        error instanceof WorkerControlGatewayError ? error.status : 500,
        error instanceof WorkerControlGatewayError ? error.code : 'internal_error'
      );
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: authentication.authenticatedLineage(),
        operation: 'final_status',
        route: '/api/worker-control/final-status',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/supply-refresh-ack', async (c) => {
    const arrivedAt = new Date().toISOString();
    const parsed = await parseWorkerControlEnvelope(c);

    if (!parsed.success) {
      observeControlRequest(
        coreDb,
        undefined,
        'supply_refresh_ack',
        null,
        arrivedAt
      )(parsed.response.status, 'invalid_request');
      return parsed.response;
    }

    const diagnose = observeControlRequest(
      coreDb,
      parsed.data.lineage,
      'supply_refresh_ack',
      parsed.data.sequence,
      arrivedAt
    );

    if (parsed.data.operation !== 'supply_refresh_ack') {
      diagnose(400, 'invalid_request');
      return asInvalidRequestError(
        new Error('Worker control operation must be supply_refresh_ack.')
      );
    }

    const body = WorkerControlSupplyRefreshAckBodyReaderSchema.safeParse(parsed.data.body);

    if (!body.success) {
      diagnose(400, 'invalid_request');
      return asInvalidRequestError(body.error);
    }

    const authentication = workerControlTokenHashAuthentication(c);
    try {
      const supplyRefreshAck = workerControlGateway.recordSupplyRefreshAck({
        ...authentication.input,
        lineage: parsed.data.lineage,
        message: body.data.message ?? null,
        refreshId: body.data.refreshId,
        sequence: parsed.data.sequence,
        status: body.data.status,
      });

      const response = c.json({
        supplyRefreshAck,
      });
      diagnose(response.status);
      return response;
    } catch (error) {
      diagnose(
        error instanceof WorkerControlGatewayError ? error.status : 500,
        error instanceof WorkerControlGatewayError ? error.code : 'internal_error'
      );
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: authentication.authenticatedLineage(),
        operation: 'supply_refresh_ack',
        route: '/api/worker-control/supply-refresh-ack',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/capability-summary', async (c) => {
    const arrivedAt = new Date().toISOString();
    const parsed = await parseWorkerControlEnvelope(c);

    if (!parsed.success) {
      observeControlRequest(
        coreDb,
        undefined,
        'capability_summary',
        null,
        arrivedAt
      )(parsed.response.status, 'invalid_request');
      return parsed.response;
    }

    const diagnose = observeControlRequest(
      coreDb,
      parsed.data.lineage,
      'capability_summary',
      parsed.data.sequence,
      arrivedAt
    );

    if (parsed.data.operation !== 'capability_summary') {
      diagnose(400, 'invalid_request');
      return asInvalidRequestError(
        new Error('Worker control operation must be capability_summary.')
      );
    }

    const body = WorkerCapabilityCallSummaryReaderSchema.safeParse(parsed.data.body);

    if (!body.success) {
      diagnose(400, 'invalid_request');
      return asInvalidRequestError(body.error);
    }

    const authentication = workerControlTokenHashAuthentication(c);
    try {
      const response = c.json({
        response: workerControlGateway.recordCapabilitySummary({
          ...authentication.input,
          lineage: parsed.data.lineage,
          summary: body.data,
        }),
      });
      diagnose(response.status);
      return response;
    } catch (error) {
      diagnose(
        error instanceof WorkerControlGatewayError ? error.status : 500,
        error instanceof WorkerControlGatewayError ? error.code : 'internal_error'
      );
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: authentication.authenticatedLineage(),
        operation: 'capability_summary',
        route: '/api/worker-control/capability-summary',
      });
      return asWorkerControlApiError(error);
    }
  });
}

/** Captures pre-acceptance lease timing and emits only fixed route outcomes and identifiers. */
function observeControlRequest(
  coreDb: CoreDb | undefined,
  lineage: WorkerControlLineage | undefined,
  operation: string,
  sequence: number | null,
  arrivedAt: string
): (status: number, code?: string) => void {
  let lease: NanoHostExecutionAttemptRecord | undefined;
  try {
    lease =
      coreDb && lineage
        ? listSchedulerExecutionAttemptsForTurn(coreDb, lineage)
            .map((attempt) => requireNanoHostExecutionAttempt(coreDb, attempt.attemptId))
            .find(
              (candidate) =>
                candidate.agentSessionId === lineage.agentSessionId &&
                candidate.inputRef === lineage.packageSnapshotId
            )
        : undefined;
    lease = lease && coreDb ? requireNanoHostExecutionAttempt(coreDb, lease.attemptId) : undefined;
  } catch {
    // Diagnostic lookup cannot change acceptance or substitute for the gateway's authority check.
  }
  const workerDeadline = lease
    ? lease.lastAcceptedHeartbeatAt
      ? lease.heartbeatDeadline
      : lease.startupDeadline
    : null;
  const deadline =
    lease && lease.deadline !== null && workerDeadline
      ? lease.deadline < workerDeadline
        ? lease.deadline
        : workerDeadline
      : null;
  return (status, code) => {
    try {
      console.error(
        JSON.stringify({
          event: 'worker.control.request',
          operation,
          sequence,
          turnId: lease && lease.turnId.length <= 160 ? lease.turnId : null,
          agentSessionId: lease && lease.agentSessionId.length <= 160 ? lease.agentSessionId : null,
          attemptId: lease?.attemptId ?? null,
          attemptPhase: lease?.phase ?? null,
          lastAcceptedHeartbeatAt: lease?.lastAcceptedHeartbeatAt ?? null,
          lastWorkerSequence: lease?.lastWorkerSequence ?? null,
          deadlineAt: deadline,
          arrivedAt,
          deadlineDeltaMs: deadline ? Date.parse(arrivedAt) - Date.parse(deadline) : null,
          deadlineKind:
            lease && deadline
              ? deadline === lease.deadline
                ? 'attempt'
                : lease.lastAcceptedHeartbeatAt
                  ? 'heartbeat'
                  : 'startup'
              : null,
          code: code ?? null,
          outcome: status < 400 ? 'accepted' : 'refused',
          status,
        })
      );
    } catch {
      /* Diagnostic sink failure has no execution authority. */
    }
  };
}

/**
 * Stores product-safe evidence only after gateway authentication proved the request lineage.
 *
 * @param input Rejection metadata from a worker-control route.
 */
function quarantineWorkerControlRejection(input: {
  readonly coreDb: CoreDb | undefined;
  readonly error: unknown;
  readonly lineage: WorkerControlLineage | undefined;
  readonly operation: string;
  readonly route: string;
}): void {
  if (
    !input.coreDb ||
    !input.lineage ||
    !(input.error instanceof WorkerControlGatewayError) ||
    input.error.code === 'worker_control_reconnect_required'
  ) {
    return;
  }

  recordWorkerControlRejectedEvidence(input.coreDb, {
    errorCode: input.error.code,
    httpStatus: input.error.status,
    lineage: input.lineage,
    message: input.error.message,
    operation: input.operation,
    rejectedAt: new Date().toISOString(),
    route: input.route,
  });
}

/**
 * Selects the worker-control family and captures proof from the existing gateway admission.
 *
 * @param c Worker-control HTTP request context.
 * @returns Gateway authentication input and the proved lineage available to rejection handling.
 */
function workerControlTokenHashAuthentication(c: Context): {
  readonly input: {
    readonly authorization: string | null;
    readonly tokenFamily: 'worker-control';
    readonly onAuthenticated: (lineage: WorkerControlLineage) => void;
  };
  readonly authenticatedLineage: () => WorkerControlLineage | undefined;
} {
  let authenticatedLineage: WorkerControlLineage | undefined;

  return {
    input: {
      authorization: c.req.header('authorization') ?? null,
      tokenFamily: 'worker-control',
      onAuthenticated: (lineage) => {
        authenticatedLineage = { ...lineage };
      },
    },
    authenticatedLineage: () => authenticatedLineage,
  };
}

/**
 * Parses one bounded simple worker-control request.
 *
 * @param c Hono request context.
 * @param schema Schema used to validate the request.
 * @returns Parsed request data, or an error response.
 */
async function parseWorkerControlRequest<T>(
  c: Context,
  schema: z.ZodType<T>
): Promise<ParsedJsonRequest<T>> {
  return parseBoundedJsonRequest(
    c,
    schema,
    WORKER_CONTROL_REQUEST_MAX_BYTES,
    'Worker control request'
  );
}

/**
 * Parses one bounded worker-control request envelope.
 *
 * @param c Hono request context.
 * @returns Parsed envelope data, or an error response.
 */
async function parseWorkerControlEnvelope(
  c: Context
): Promise<ParsedJsonRequest<z.infer<typeof WorkerControlRequestEnvelopeReaderSchema>>> {
  return parseBoundedJsonRequest(
    c,
    WorkerControlRequestEnvelopeReaderSchema,
    WORKER_CONTROL_REQUEST_MAX_BYTES,
    'Worker control envelope'
  );
}

/**
 * Parses one bounded worker-control event append request.
 *
 * @param c Hono request context.
 * @returns Parsed event append request data, or an error response.
 */
async function parseWorkerControlEventAppendRequest(
  c: Context
): Promise<ParsedJsonRequest<z.infer<typeof WorkerControlEventAppendRequestSchema>>> {
  return parseBoundedJsonRequest(
    c,
    WorkerControlEventAppendRequestSchema,
    WORKER_CONTROL_EVENT_APPEND_MAX_BYTES,
    'Worker control event append payload'
  );
}

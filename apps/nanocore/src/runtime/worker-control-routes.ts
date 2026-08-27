import {
  WorkerCanonicalEventRecordSchema,
  WorkerCanonicalTerminalEventDataSchema,
  WorkerCapabilityCallSummarySchema,
  WorkerControlHeartbeatRequestSchema,
  WorkerControlRequestEnvelopeSchema,
} from '@openkit/worker-protocol';
import type { Context, Hono } from 'hono';
import { z } from 'zod';

import { asInvalidRequestError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import { recordSchedulerSupplyRefreshAck } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
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
  }),
});
const WorkerControlCommandPollRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
});
const WorkerControlCommandAckRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  commandId: z.string().min(1),
});
const WorkerControlEventAppendRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  record: WorkerCanonicalEventRecordSchema,
});
const WorkerControlSupplyRefreshAckBodySchema = z
  .object({
    refreshId: z.string().min(1),
    status: z.enum(['applied', 'rejected', 'unsupported']),
    message: z.string().min(1).nullable().optional(),
  })
  .strict();
const WORKER_CONTROL_REQUEST_MAX_BYTES = 64 * 1024;
const WORKER_CONTROL_EVENT_APPEND_MAX_BYTES = 256 * 1024;

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
    const parsed = await parseWorkerControlRequest(c, WorkerControlHeartbeatRequestSchema);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      return c.json({
        heartbeat: workerControlGateway.recordHeartbeat({
          ...workerControlTokenHashAuthentication(c),
          ...parsed.data,
        }),
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'heartbeat',
        route: '/api/worker-control/heartbeat',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/artifacts', async (c) => {
    const parsed = await parseWorkerControlRequest(c, WorkerControlArtifactNoticeRequestSchema);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      return c.json({
        artifact: workerControlGateway.recordArtifactNotice({
          artifact: parsed.data.artifact,
          ...workerControlTokenHashAuthentication(c),
          lineage: parsed.data.lineage,
          sequence: parsed.data.sequence,
        }),
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'artifact_notice',
        route: '/api/worker-control/artifacts',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/commands/poll', async (c) => {
    const parsed = await parseWorkerControlRequest(c, WorkerControlCommandPollRequestSchema);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      return c.json(
        workerControlGateway.pollCommands({
          ...workerControlTokenHashAuthentication(c),
          lineage: parsed.data.lineage,
        })
      );
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'command_poll',
        route: '/api/worker-control/commands/poll',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/commands/ack', async (c) => {
    const parsed = await parseWorkerControlRequest(c, WorkerControlCommandAckRequestSchema);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      return c.json({
        command: workerControlGateway.acknowledgeCommand({
          ...workerControlTokenHashAuthentication(c),
          commandId: parsed.data.commandId,
          lineage: parsed.data.lineage,
        }),
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'command_ack',
        route: '/api/worker-control/commands/ack',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/events/append', async (c) => {
    const parsed = await parseWorkerControlEventAppendRequest(c);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      return c.json(
        workerControlGateway.appendEvent({
          ...workerControlTokenHashAuthentication(c),
          lineage: parsed.data.lineage,
          record: parsed.data.record,
        })
      );
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'event_append',
        route: '/api/worker-control/events/append',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/final-status', async (c) => {
    const parsed = await parseWorkerControlEnvelope(c);

    if (!parsed.success) {
      return parsed.response;
    }

    if (parsed.data.operation !== 'final_status') {
      return asInvalidRequestError(new Error('Worker control operation must be final_status.'));
    }

    const body = WorkerCanonicalTerminalEventDataSchema.safeParse(parsed.data.body);

    if (!body.success) {
      return asInvalidRequestError(body.error);
    }

    try {
      return c.json(
        workerControlGateway.recordFinalStatus({
          ...workerControlTokenHashAuthentication(c),
          ...(body.data.diagnostics ? { diagnostics: body.data.diagnostics } : {}),
          evidenceManifestDigests: body.data.evidenceManifestDigests,
          lineage: parsed.data.lineage,
          sequence: parsed.data.sequence,
          status: body.data.status,
          stopReason: body.data.stopReason,
        })
      );
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'final_status',
        route: '/api/worker-control/final-status',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/supply-refresh-ack', async (c) => {
    const parsed = await parseWorkerControlEnvelope(c);

    if (!parsed.success) {
      return parsed.response;
    }

    if (parsed.data.operation !== 'supply_refresh_ack') {
      return asInvalidRequestError(
        new Error('Worker control operation must be supply_refresh_ack.')
      );
    }

    const body = WorkerControlSupplyRefreshAckBodySchema.safeParse(parsed.data.body);

    if (!body.success) {
      return asInvalidRequestError(body.error);
    }

    try {
      const supplyRefreshAck = workerControlGateway.recordSupplyRefreshAck({
        ...workerControlTokenHashAuthentication(c),
        lineage: parsed.data.lineage,
        message: body.data.message ?? null,
        refreshId: body.data.refreshId,
        sequence: parsed.data.sequence,
        status: body.data.status,
      });

      if (coreDb) {
        recordSchedulerSupplyRefreshAck(coreDb, {
          acknowledgedAt: supplyRefreshAck.acknowledgedAt,
          agentSessionId: parsed.data.lineage.agentSessionId,
          message: supplyRefreshAck.message,
          packageSnapshotId: parsed.data.lineage.packageSnapshotId,
          refreshId: supplyRefreshAck.refreshId,
          sequence: supplyRefreshAck.sequence,
          status: supplyRefreshAck.status,
          threadId: parsed.data.lineage.threadId,
          turnId: parsed.data.lineage.turnId,
          workspaceId: parsed.data.lineage.workspaceId,
        });
      }

      return c.json({
        supplyRefreshAck,
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'supply_refresh_ack',
        route: '/api/worker-control/supply-refresh-ack',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/capability-summary', async (c) => {
    const parsed = await parseWorkerControlEnvelope(c);

    if (!parsed.success) {
      return parsed.response;
    }

    if (parsed.data.operation !== 'capability_summary') {
      return asInvalidRequestError(
        new Error('Worker control operation must be capability_summary.')
      );
    }

    const body = WorkerCapabilityCallSummarySchema.safeParse(parsed.data.body);

    if (!body.success) {
      return asInvalidRequestError(body.error);
    }

    try {
      return c.json({
        response: workerControlGateway.recordCapabilitySummary({
          ...workerControlTokenHashAuthentication(c),
          lineage: parsed.data.lineage,
          summary: body.data,
        }),
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'capability_summary',
        route: '/api/worker-control/capability-summary',
      });
      return asWorkerControlApiError(error);
    }
  });
}

/**
 * Stores product-safe evidence when worker-control verification rejects a parsed request.
 *
 * @param input Rejection metadata from a worker-control route.
 */
function quarantineWorkerControlRejection(input: {
  readonly coreDb: CoreDb | undefined;
  readonly error: unknown;
  readonly lineage: WorkerControlLineage;
  readonly operation: string;
  readonly route: string;
}): void {
  if (
    !input.coreDb ||
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
 * Selects the worker-control hash family for one semantic route request.
 *
 * @param c Worker-control HTTP request context.
 * @returns Authorization input explicitly bound to the worker-control family.
 */
function workerControlTokenHashAuthentication(c: Context): {
  readonly authorization: string | null;
  readonly tokenFamily: 'worker-control';
} {
  return {
    authorization: c.req.header('authorization') ?? null,
    tokenFamily: 'worker-control',
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
): Promise<ParsedJsonRequest<z.infer<typeof WorkerControlRequestEnvelopeSchema>>> {
  return parseBoundedJsonRequest(
    c,
    WorkerControlRequestEnvelopeSchema,
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

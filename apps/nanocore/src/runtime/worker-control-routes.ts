import {
  WorkerCanonicalEventRecordSchema,
  WorkerCapabilityCallSummarySchema,
  WorkerControlRequestEnvelopeSchema,
} from '@openkit/worker-protocol';
import type { Context, Hono } from 'hono';
import { z } from 'zod';

import { asInvalidRequestError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { FsStore } from '../lib/store.js';
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

const WorkerControlHeartbeatRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  sequence: z.number().int().nonnegative(),
  status: z.enum([
    'starting',
    'running',
    'idle',
    'awaiting_command',
    'stopping',
    'completed',
    'failed',
  ]),
  message: z.string().min(1).nullable().optional(),
});
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
const WorkerControlTerminalResultRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  terminalCommandId: z.string().min(1),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative().nullable().optional(),
});
const WorkerControlEventAppendRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  record: WorkerCanonicalEventRecordSchema,
});
const WorkerControlFinalStatusBodySchema = z
  .object({
    status: z.enum([
      'blocked',
      'cancelled',
      'completed',
      'degraded',
      'failed',
      'interrupted',
      'lost',
    ]),
    stopReason: z.string().min(1).nullable().optional(),
    evidenceManifestDigests: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();
const WorkerControlSupplyRefreshAckBodySchema = z
  .object({
    refreshId: z.string().min(1),
    status: z.enum(['applied', 'rejected', 'unsupported']),
    message: z.string().min(1).nullable().optional(),
  })
  .strict();
const WorkerControlKnowledgeProposalSummaryBodySchema = z
  .object({
    proposalId: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

const WORKER_CONTROL_REQUEST_MAX_BYTES = 64 * 1024;
const WORKER_CONTROL_EVENT_APPEND_MAX_BYTES = 256 * 1024;
const WORKER_CONTROL_TERMINAL_RESULT_MAX_BYTES = 1024 * 1024;

/**
 * Registers the sandbox-authenticated worker control relay routes.
 *
 * @param dependencies Worker control HTTP dependencies owned by the app composition root.
 */
export function registerWorkerControlRoutes({
  app,
  authenticateWorkerPackageOwner,
  coreDb,
  workerControlGateway,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly authenticateWorkerPackageOwner: (input: {
    readonly authorization: string | null;
    readonly lineage: WorkerControlLineage;
  }) => { readonly store: FsStore };
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
          authorization: c.req.header('authorization') ?? null,
          lineage: parsed.data.lineage,
          message: parsed.data.message ?? null,
          sequence: parsed.data.sequence,
          status: parsed.data.status,
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
          authorization: c.req.header('authorization') ?? null,
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
          authorization: c.req.header('authorization') ?? null,
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
          authorization: c.req.header('authorization') ?? null,
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

  app.post('/api/worker-control/terminal-results', async (c) => {
    const parsed = await parseWorkerControlTerminalResultRequest(c);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      return c.json({
        terminalResult: workerControlGateway.recordTerminalResult({
          authorization: c.req.header('authorization') ?? null,
          durationMs: parsed.data.durationMs ?? null,
          exitCode: parsed.data.exitCode,
          lineage: parsed.data.lineage,
          stderr: parsed.data.stderr,
          stdout: parsed.data.stdout,
          terminalCommandId: parsed.data.terminalCommandId,
        }),
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'terminal_result',
        route: '/api/worker-control/terminal-results',
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
          authorization: c.req.header('authorization') ?? null,
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

    const body = WorkerControlFinalStatusBodySchema.safeParse(parsed.data.body);

    if (!body.success) {
      return asInvalidRequestError(body.error);
    }

    try {
      return c.json(
        workerControlGateway.appendEvent({
          authorization: c.req.header('authorization') ?? null,
          lineage: parsed.data.lineage,
          record: WorkerCanonicalEventRecordSchema.parse({
            event: {
              data: {
                evidenceManifestDigests: body.data.evidenceManifestDigests ?? {},
                stopReason: body.data.stopReason ?? body.data.status,
              },
              type: body.data.status === 'completed' ? 'turn.completed' : 'turn.failed',
            },
            kind: 'event',
            lineage: parsed.data.lineage,
            schemaVersion: parsed.data.schemaVersion,
            sequence: parsed.data.sequence,
          }),
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
        authorization: c.req.header('authorization') ?? null,
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
          authorization: c.req.header('authorization') ?? null,
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

  app.post('/api/worker-control/knowledge-proposal-summary', async (c) => {
    const parsed = await parseWorkerControlEnvelope(c);

    if (!parsed.success) {
      return parsed.response;
    }

    if (parsed.data.operation !== 'knowledge_proposal_summary') {
      return asInvalidRequestError(
        new Error('Worker control operation must be knowledge_proposal_summary.')
      );
    }

    const body = WorkerControlKnowledgeProposalSummaryBodySchema.safeParse(parsed.data.body);

    if (!body.success) {
      return asInvalidRequestError(body.error);
    }

    try {
      const { store } = authenticateWorkerPackageOwner({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      const priorSummary = workerControlGateway
        .getSessionSnapshot(parsed.data.lineage.packageSnapshotId)
        ?.knowledgeProposalSummaries.find((summary) => summary.sequence === parsed.data.sequence);
      const existingProposal = store.getKnowledgeProposal(body.data.proposalId);

      if (
        existingProposal &&
        (!priorSummary || existingProposal.workspaceId !== parsed.data.lineage.workspaceId)
      ) {
        throw new WorkerControlGatewayError(
          'worker_control_knowledge_proposal_conflict',
          `Worker knowledge proposal id is already owned: ${body.data.proposalId}`,
          409
        );
      }

      const knowledgeProposalSummary = workerControlGateway.recordKnowledgeProposalSummary({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
        proposalId: body.data.proposalId,
        sequence: parsed.data.sequence,
        summary: body.data.summary,
        title: body.data.title,
      });

      if (!existingProposal) {
        store.createKnowledgeProposal({
          createdAt: knowledgeProposalSummary.receivedAt,
          id: body.data.proposalId,
          status: 'pending',
          summary: body.data.summary,
          title: body.data.title,
          updatedAt: knowledgeProposalSummary.receivedAt,
          workspaceId: parsed.data.lineage.workspaceId,
        });
      }

      return c.json({ knowledgeProposalSummary });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'knowledge_proposal_summary',
        route: '/api/worker-control/knowledge-proposal-summary',
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
  if (!input.coreDb || !(input.error instanceof WorkerControlGatewayError)) {
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

/**
 * Parses one bounded worker-control terminal result request.
 *
 * @param c Hono request context.
 * @returns Parsed terminal result request data, or an error response.
 */
async function parseWorkerControlTerminalResultRequest(
  c: Context
): Promise<ParsedJsonRequest<z.infer<typeof WorkerControlTerminalResultRequestSchema>>> {
  return parseBoundedJsonRequest(
    c,
    WorkerControlTerminalResultRequestSchema,
    WORKER_CONTROL_TERMINAL_RESULT_MAX_BYTES,
    'Worker control terminal result payload'
  );
}

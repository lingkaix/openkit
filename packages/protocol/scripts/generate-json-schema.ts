import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
  ActorRefSchema,
  AgentSessionSchema,
  ApiErrorSchema,
  ApprovalRequestSchema,
  ArtifactSchema,
  AuditEventSchema,
  CapabilityCallSchema,
  MetaResponseSchema,
  SseEventEnvelopeSchema,
  StopReasonSchema,
  ThreadSchema,
  TurnSchema,
  UsageRecordSchema,
  WorkspaceRecordSchema,
} from '../src/index.js';

/**
 * Writes selected protocol schemas as JSON Schema files.
 */
async function main(): Promise<void> {
  const outputDir = path.resolve(process.cwd(), 'generated/json-schema');

  await mkdir(outputDir, { recursive: true });

  const schemaMap = {
    'actor-ref.schema.json': ActorRefSchema,
    'workspace.schema.json': WorkspaceRecordSchema,
    'thread.schema.json': ThreadSchema,
    'turn.schema.json': TurnSchema,
    'stop-reason.schema.json': StopReasonSchema,
    'artifact.schema.json': ArtifactSchema,
    'approval.schema.json': ApprovalRequestSchema,
    'agent-session.schema.json': AgentSessionSchema,
    'capability-call.schema.json': CapabilityCallSchema,
    'usage-record.schema.json': UsageRecordSchema,
    'audit-event.schema.json': AuditEventSchema,
    'event.schema.json': SseEventEnvelopeSchema,
    'error.schema.json': ApiErrorSchema,
    'meta.schema.json': MetaResponseSchema,
  } as const;

  for (const [filename, schema] of Object.entries(schemaMap)) {
    const jsonSchema = z.toJSONSchema(schema);
    await writeFile(path.join(outputDir, filename), JSON.stringify(jsonSchema, null, 2));
  }
}

await main();

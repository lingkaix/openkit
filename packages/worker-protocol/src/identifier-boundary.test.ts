import { describe, expect, it } from 'vitest';
import {
  HarnessResumeSchema,
  HarnessSessionOpenQueuedBodySchema,
  HarnessTurnStartQueuedBodySchema,
} from './harness-control.js';
import { WorkerCapabilityCallSummarySchema, WorkerLineageSchema } from './index.js';

const uuid7 = '01890f3e-0000-7000-8000-000000000001';
const uuid5 = '01890f3e-0000-5000-8000-000000000001';
const fields = [
  { kind: 'as', schema: HarnessResumeSchema.shape.locator },
  { kind: 'cap', schema: WorkerCapabilityCallSummarySchema.shape.capabilityCallId },
  { kind: 'ws', schema: WorkerLineageSchema.shape.workspaceId },
  { kind: 'th', schema: WorkerLineageSchema.shape.threadId },
  { kind: 'tu', schema: WorkerLineageSchema.shape.turnId },
  { kind: 'as', schema: WorkerLineageSchema.shape.agentSessionId },
  { kind: 'as', schema: HarnessSessionOpenQueuedBodySchema.shape.agentSessionId },
  { kind: 'th', schema: HarnessSessionOpenQueuedBodySchema.shape.threadId },
  { kind: 'ws', schema: HarnessSessionOpenQueuedBodySchema.shape.workspaceId },
  { kind: 'tu', schema: HarnessTurnStartQueuedBodySchema.shape.turnId },
];

describe('Worker and Harness Core identity boundaries', () => {
  it.each(fields)('uses the shared $kind grammar without adopting a native identity', ({
    kind,
    schema,
  }) => {
    expect(schema.safeParse(`${kind}_${uuid7}`).success).toBe(true);
    expect(schema.safeParse(`${kind}_${uuid5}`).success).toBe(kind !== 'as');
    for (const value of [
      uuid7,
      `${kind}_legacy`,
      `native_${uuid7}`,
      `${kind}_${uuid7.replace('-8000-', '-c000-')}`,
      `${kind}_${uuid7}\n`,
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });
});

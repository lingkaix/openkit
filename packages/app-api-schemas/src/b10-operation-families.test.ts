import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ADMINISTRATION_ENTRY_OPERATION_DEFINITIONS,
  APP_UPDATE_OPERATION_DEFINITIONS,
  operationModelInput,
  WORKER_ENVIRONMENT_OPERATION_DEFINITIONS,
} from './operation-definitions.js';

describe('B10 family declarations', () => {
  it('composes seven Worker environment, two administration and three App-update operations', () => {
    expect(Object.keys(WORKER_ENVIRONMENT_OPERATION_DEFINITIONS)).toHaveLength(7);
    expect(Object.keys(ADMINISTRATION_ENTRY_OPERATION_DEFINITIONS)).toHaveLength(2);
    expect(Object.keys(APP_UPDATE_OPERATION_DEFINITIONS)).toHaveLength(3);
  });

  it('preserves strict preparation and recovery inputs, defaults and omitted identity views', () => {
    const prepareSchema =
      WORKER_ENVIRONMENT_OPERATION_DEFINITIONS['worker-environment.prepare'].inputSchema;
    const recoverSchema =
      WORKER_ENVIRONMENT_OPERATION_DEFINITIONS['worker-environment.recover'].inputSchema;
    const requestId = '11111111-1111-4111-8111-111111111111';
    const digest = `sha256:${'a'.repeat(64)}`;
    const recover = {
      administrationThreadId: 'thread_admin',
      requestId,
      recoverFrom: { artifactId: 'artifact_authored', artifactVersion: 1, contentDigest: digest },
    };
    const prepare = {
      administrationThreadId: 'thread_admin',
      requestId,
      configuration: { fileId: 'agents/codex.agent.jsonc', expectedRevision: digest },
      declaration: { kind: 'reference', pullPolicy: 'never', ref: digest },
      target: { kind: 'agent', agentId: 'codex' },
    };
    expect(prepareSchema.parse(prepare)).toEqual({ ...prepare, replaceNow: null });
    expect(recoverSchema.parse(recover)).toEqual(recover);
    for (const [schema, value] of [
      [prepareSchema, prepare],
      [recoverSchema, recover],
    ] as const) {
      const { requestId: _requestId, ...modelInput } = value;
      expect(operationModelInput(schema, ['requestId']).safeParse(modelInput).success).toBe(true);
      expect(schema.safeParse({ ...value, mode: 'prepare' }).success).toBe(false);
      expect(schema.safeParse({ ...value, rawSecret: 'private' }).success).toBe(false);
    }
    expect(prepareSchema.safeParse({ ...prepare, recoverFrom: recover.recoverFrom }).success).toBe(
      false
    );
    for (const field of ['configuration', 'declaration', 'target', 'replaceNow'] as const) {
      expect(
        recoverSchema.safeParse({
          ...recover,
          [field]: field === 'replaceNow' ? null : prepare[field as keyof typeof prepare],
        }).success
      ).toBe(false);
    }
    const emitted = z.toJSONSchema(prepareSchema);
    expect(emitted.required).toEqual(
      expect.arrayContaining(['configuration', 'declaration', 'target'])
    );
    expect(emitted.required).not.toContain('replaceNow');
    expect(z.toJSONSchema(recoverSchema).additionalProperties).toBe(false);
    const fixtureLiteral = `okt_${'a'.repeat(48)}`;
    expect(
      prepareSchema.safeParse({ ...prepare, target: { kind: 'agent', agentId: fixtureLiteral } })
        .success
    ).toBe(true);
    expect(
      recoverSchema.safeParse({
        ...recover,
        recoverFrom: { ...recover.recoverFrom, artifactId: fixtureLiteral },
      }).success
    ).toBe(true);
    expect(
      operationModelInput(recoverSchema, ['requestId']).safeParse({
        administrationThreadId: 'thread_admin',
        recoverFrom: { ...recover.recoverFrom, artifactId: fixtureLiteral },
      }).success
    ).toBe(true);
  });

  it('keeps the host-owned receipt id required on the status read', () => {
    const schema = APP_UPDATE_OPERATION_DEFINITIONS['app-update.status'].inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ requestId: '11111111-1111-4111-8111-111111111111' }).success).toBe(
      true
    );
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WorkerObservationData, WorkerObservationDataSchema } from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
import type { WorkerAdapterPrepareInput, WorkerNativeProcessResult } from '../adapter-registry.js';
import { piAdapter } from './pi.js';

/**
 * Creates one isolated Pi adapter input.
 *
 * @returns Adapter input with one Shim-selected LLM route.
 */
function piInput(): WorkerAdapterPrepareInput {
  const root = mkdtempSync(join(tmpdir(), 'openkit-pi-adapter-'));

  return {
    runtimeCapture: {
      captureCoverage: { scope: 'server', value: 'off' },
      packageSnapshotId: 'aep_test',
      credentialValues: [],
      emit: async () => undefined,
    },
    childEnvironment: {
      ANTHROPIC_API_KEY: 'provider-credential-value',
      PATH: process.env.PATH ?? '',
    },
    controlRoot: join(root, 'control'),
    llmRoute: {
      credentialVisibility: 'environment',
      endpoint: {
        kind: 'provider-compatible',
        upstream: { kind: 'direct-provider' },
      },
      id: 'worker-inference',
      model: 'claude-sonnet-4-5',
      providerInstanceId: 'anthropic',
    },
    sessionDirectory: join(root, 'session'),
    stateRoot: join(root, 'state'),
    turnInput: 'Review the implementation.',
    workingDirectory: '/workspace/repository',
  };
}

/**
 * Creates one Pi process result from native JSON events.
 *
 * @param records Native event records.
 * @param overrides Native termination overrides.
 * @returns Bounded process output presented to adapter collection.
 */
function nativeResult(
  records: ReadonlyArray<Record<string, unknown> | string>,
  overrides: Partial<Pick<WorkerNativeProcessResult, 'exitCode' | 'interrupted' | 'signal'>> = {}
): WorkerNativeProcessResult {
  return {
    exitCode: 0,
    interrupted: false,
    signal: null,
    stderr: '',
    stdout: Buffer.from(
      `${records
        .map((record) => (typeof record === 'string' ? record : JSON.stringify(record)))
        .join('\n')}\n`
    ),
    ...overrides,
  };
}

/**
 * Creates one pinned Pi terminal assistant message.
 *
 * @param stopReason Native assistant stop reason.
 * @returns Complete assistant message repeated by terminal lifecycle records.
 */
function assistantMessage(stopReason = 'stop'): Record<string, unknown> {
  return {
    api: 'anthropic-messages',
    content: [
      { text: ' First', type: 'text' },
      { thinking: 'not final output', type: 'thinking' },
      { text: ' answer. ', type: 'text' },
    ],
    model: 'claude-sonnet-4-5',
    provider: 'anthropic',
    role: 'assistant',
    stopReason,
    timestamp: 1,
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 1,
      output: 1,
      totalTokens: 2,
    },
  };
}

/**
 * Creates the exact successful Pi terminal correlation tail.
 *
 * @param message Completed assistant message.
 * @returns Message, turn, agent, and settlement events in native order.
 */
function settledEvents(message: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    { message, type: 'message_end' },
    { message, toolResults: [], type: 'turn_end' },
    { messages: [message], type: 'agent_end', willRetry: false },
    { type: 'agent_settled' },
  ];
}

describe('Pi worker adapter', () => {
  it.each([
    'on',
    'off',
  ] as const)('streams admitted text and actual tool results with capture %s, without claiming child support', async (value) => {
    const input = piInput();
    const recorded: Array<{ record: WorkerObservationData; body?: Uint8Array }> = [];
    const plan = await piAdapter.prepare({
      ...input,
      runtimeCapture: {
        ...input.runtimeCapture,
        captureCoverage: { scope: 'server', value },
        emit: async (record, body) => {
          recorded.push({
            record: WorkerObservationDataSchema.parse(record),
            ...(body ? { body } : {}),
          });
        },
      },
    });
    const result = { content: [{ type: 'text', text: '  tool 💡\n' }], details: { exitCode: 0 } };
    await plan.writeStdout!(
      nativeResult([
        { type: 'message_start' },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: '  live 💡\n' },
        },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'unpublished-canary' },
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'bash',
          args: { command: 'true' },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'bash',
          isError: false,
          result,
        },
      ]).stdout
    );
    const tools = recorded.filter(
      ({ record, body }) => record.fact.kind === 'tool' && (value === 'off' || body !== undefined)
    );
    expect(tools.map(({ record }) => record.fact.phase)).toEqual(['started', 'completed']);
    expect(tools[0]?.record.fact.callRef).toBe(tools[1]?.record.fact.callRef);
    expect(recorded.filter(({ record }) => record.fact.coverage === 'unsupported')).toHaveLength(2);
    expect(
      recorded.some(({ body }) => body && Buffer.from(body).toString() === '  live 💡\n')
    ).toBe(false);
    await plan.finalize!();
    if (value === 'on')
      expect(recorded.map(({ body }) => body && Buffer.from(body).toString())).toEqual(
        expect.arrayContaining(['  live 💡\n', JSON.stringify(result)])
      );
    else expect(recorded.every(({ body }) => body === undefined)).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain('unpublished-canary');
    await plan.finalize!();
  });
  it('prepares the pinned JSON command with every ambient resource path disabled', async () => {
    const input = piInput();
    const plan = await piAdapter.prepare(input);

    expect(plan.argv).toEqual([
      'pi',
      '--mode',
      'json',
      '--no-approve',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--offline',
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-4-5',
      input.turnInput,
    ]);
    expect(plan.captureStdout).toBe(true);
    expect(plan.environment).toMatchObject({
      ANTHROPIC_API_KEY: 'provider-credential-value',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    });
    expect(plan.environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(plan.environment).not.toHaveProperty('OPENAI_BASE_URL');
    expect(plan.environment).not.toHaveProperty('OPENKIT_WORKER_INFERENCE_TOKEN');
    expect(plan.environment.PI_CODING_AGENT_DIR).toContain(input.stateRoot);
    expect(plan.argv).not.toContain('openshell-placeholder-value');
    expect(plan.argv).not.toContain('--api-key');
    expect(plan).not.toHaveProperty('configArtifacts');
  });

  it.each([
    {
      change: (input: WorkerAdapterPrepareInput) => ({
        ...input,
        llmRoute: { ...input.llmRoute, model: 'unproved-model' },
      }),
      name: 'an unproved provider and model pair',
    },
    {
      change: (input: WorkerAdapterPrepareInput) => ({
        ...input,
        childEnvironment: { PATH: process.env.PATH ?? '' },
      }),
      name: 'a missing direct-provider credential',
    },
    {
      change: (input: WorkerAdapterPrepareInput) => ({
        ...input,
        childEnvironment: {
          OPENAI_API_KEY: 'wrong-provider-credential',
          PATH: process.env.PATH ?? '',
        },
      }),
      name: 'the wrong direct provider credential',
    },
    {
      change: (input: WorkerAdapterPrepareInput) => ({
        ...input,
        childEnvironment: {
          ANTHROPIC_API_KEY: 'provider-credential-value',
          OPENKIT_WORKER_INFERENCE_TOKEN: 'extra-relay-authority',
          PATH: process.env.PATH ?? '',
        },
      }),
      name: 'extra relay authority on the direct-provider route',
    },
    {
      change: (input: WorkerAdapterPrepareInput) => ({
        ...input,
        childEnvironment: {
          OPENKIT_WORKER_INFERENCE_TOKEN: 'relay-placeholder',
          PATH: process.env.PATH ?? '',
        },
        llmRoute: {
          credentialVisibility: 'placeholder' as const,
          endpoint: {
            kind: 'openai-compatible' as const,
            upstream: { kind: 'nanocore-gateway' as const },
          },
          id: 'worker-inference',
          model: 'claude-sonnet-4-5',
          providerInstanceId: 'anthropic',
        },
      }),
      name: 'placeholder NanoCore-gateway authority',
    },
  ])('rejects $name before launch', async ({ change }) => {
    await expect(piAdapter.prepare(change(piInput()))).rejects.toThrow(/unsupported/i);
  });

  it('accepts ordered text only after exact final settlement correlation', async () => {
    const launchPlan = await piAdapter.prepare(piInput());
    const retryMessage = assistantMessage('error');
    const processResult = nativeResult([
      { type: 'session', version: 3 },
      { message: retryMessage, type: 'message_end' },
      { message: retryMessage, toolResults: [], type: 'turn_end' },
      { messages: [retryMessage], type: 'agent_end', willRetry: true },
      ...settledEvents(assistantMessage()),
      { type: 'future_runtime_event' },
    ]);

    await expect(piAdapter.collect({ launchPlan, processResult })).resolves.toMatchObject({
      assistantText: 'First answer.',
      status: 'completed',
    });
  });

  it.each([
    { events: ['{not-json'], name: 'malformed JSON' },
    { events: [{ type: 'agent_settled' }], name: 'missing final assistant content' },
    {
      events: settledEvents({
        ...assistantMessage(),
        content: [{ text: '   ', type: 'text' }],
      }),
      name: 'empty final assistant content',
    },
    {
      events: settledEvents(assistantMessage()).slice(0, -1),
      name: 'missing agent_settled',
    },
    {
      events: [...settledEvents(assistantMessage()), { type: 'agent_settled' }],
      name: 'multiple agent_settled records',
    },
    {
      events: [
        ...settledEvents(assistantMessage()),
        ...settledEvents({
          ...assistantMessage(),
          content: [{ text: 'unsettled later answer', type: 'text' }],
        }).slice(0, -1),
      ],
      name: 'an unsettled run after the final settlement',
    },
    {
      events: [
        { message: assistantMessage(), type: 'message_end' },
        { message: { ...assistantMessage(), model: 'different-model' }, type: 'turn_end' },
        { messages: [assistantMessage()], type: 'agent_end', willRetry: false },
        { type: 'agent_settled' },
      ],
      name: 'contradictory terminal correlation',
    },
    {
      events: settledEvents({
        ...assistantMessage(),
        model: 'different-model',
        provider: 'different-provider',
      }),
      name: 'a terminal provider and model different from the requested route',
    },
    {
      events: settledEvents(assistantMessage()).map((event) =>
        event.type === 'agent_end' ? { ...event, willRetry: true } : event
      ),
      name: 'a retry-intermediate agent end',
    },
    { events: settledEvents(assistantMessage('length')), name: 'a length stop reason' },
    { events: settledEvents(assistantMessage('toolUse')), name: 'a tool-use stop reason' },
    { events: settledEvents(assistantMessage('error')), name: 'an error stop reason' },
    { events: settledEvents(assistantMessage('aborted')), name: 'an aborted stop reason' },
    {
      events: settledEvents(assistantMessage()),
      expectedStatus: 'interrupted',
      name: 'a shared interrupt',
      overrides: { interrupted: true, signal: 'SIGTERM' as const },
    },
    {
      events: settledEvents(assistantMessage()),
      name: 'a non-zero native exit',
      overrides: { exitCode: 1 },
    },
  ])('fails closed on $name', async ({ events, expectedStatus = 'failed', overrides }) => {
    const launchPlan = await piAdapter.prepare(piInput());

    await expect(
      piAdapter.collect({ launchPlan, processResult: nativeResult(events, overrides) })
    ).resolves.toMatchObject({ assistantText: null, status: expectedStatus });
  });

  it('fails closed on invalid UTF-8 inside otherwise valid terminal JSON', async () => {
    const launchPlan = await piAdapter.prepare(piInput());
    const processResult = nativeResult(settledEvents(assistantMessage()));
    const stdout = Buffer.concat([
      Buffer.from('{"note":"'),
      Buffer.from([0xff]),
      Buffer.from('","type":"future_runtime_event"}\n'),
      Buffer.from(processResult.stdout),
    ]);

    await expect(
      piAdapter.collect({ launchPlan, processResult: { ...processResult, stdout } })
    ).resolves.toMatchObject({ assistantText: null, status: 'failed' });
  });
});

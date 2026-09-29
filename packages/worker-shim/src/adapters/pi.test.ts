import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
      OPENKIT_WORKER_INFERENCE_TOKEN: 'inference-credential-value',
      PATH: process.env.PATH ?? '',
    },
    controlRoot: join(root, 'control'),
    llmRoute: {
      credentialVisibility: 'placeholder',
      endpoint: {
        kind: 'openai-compatible',
        upstream: { kind: 'nanocore-gateway' },
      },
      id: 'worker-inference',
      model: 'grok',
      providerInstanceId: 'gateway',
      modelParameters: {
        contextWindow: 360000,
        maxOutputTokens: 32000,
        inputModalities: ['text', 'image'],
        reasoning: true,
      },
    },
    sessionDirectory: join(root, 'session'),
    stateRoot: join(root, 'state'),
    turnInput: 'Review the implementation.',
    workingDirectory: '/workspace/repository',
  };
}

/** Opens one fresh Pi control binding and prepares its first Turn. */
async function openAndPreparePi(input: WorkerAdapterPrepareInput) {
  await piAdapter.openSession({ controlRoot: input.controlRoot, stateRoot: input.stateRoot });
  return piAdapter.prepareTurn(input);
}

/** Returns the exact session path bound through one Pi launch plan. */
function piSessionPath(argv: readonly string[]): string {
  const index = argv.indexOf('--session');
  const path = argv[index + 1];
  if (index < 0 || !path) throw new Error('Pi launch plan is missing --session.');
  return path;
}

/** Writes one minimal pinned Pi session header at the selected retained path. */
function writePiSession(path: string, cwd: string, id = 'pi-session-1'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-09-29T00:00:00.000Z', cwd })}\n`
  );
}

/** Collects one Pi Turn through the continuity interface. */
async function collectPiTurn(
  input: WorkerAdapterPrepareInput,
  launchPlan: Awaited<ReturnType<typeof piAdapter.prepareTurn>>,
  processResult: WorkerNativeProcessResult
) {
  if (
    processResult.exitCode === 0 &&
    !processResult.interrupted &&
    !existsSync(piSessionPath(launchPlan.argv))
  ) {
    writePiSession(piSessionPath(launchPlan.argv), input.workingDirectory);
  }
  return piAdapter.collectTurn({
    controlRoot: input.controlRoot,
    launchPlan,
    processResult,
    stateRoot: input.stateRoot,
  });
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
    api: 'openai-completions',
    content: [
      { text: ' First', type: 'text' },
      { thinking: 'not final output', type: 'thinking' },
      { text: ' answer. ', type: 'text' },
    ],
    model: 'grok',
    provider: 'openkit-worker-inference',
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
  it('opens one exact retained session, resumes it in a fresh process, and closes only control authority', async () => {
    const first = piInput();
    mkdirSync(first.sessionDirectory, { recursive: true });
    await expect(
      piAdapter.openSession({ controlRoot: first.controlRoot, stateRoot: first.stateRoot })
    ).resolves.toEqual({
      nativeHandle: null,
      nativeHandleDigest: null,
      nativeHandleState: 'pending',
    });
    const initialPlan = await piAdapter.prepareTurn(first);
    const retainedPath = piSessionPath(initialPlan.argv);
    expect(existsSync(retainedPath)).toBe(false);
    expect(retainedPath.startsWith(`${first.stateRoot}/`)).toBe(true);
    writePiSession(retainedPath, first.workingDirectory);

    const collected = await collectPiTurn(
      first,
      initialPlan,
      nativeResult(settledEvents(assistantMessage()))
    );
    expect(collected).toMatchObject({ nativeHandleState: 'ready', status: 'completed' });
    expect(collected.nativeHandle).toBeTruthy();
    expect(collected.nativeHandleDigest).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      piAdapter.inspectSession({ controlRoot: first.controlRoot, stateRoot: first.stateRoot })
    ).resolves.toEqual({
      nativeHandleDigest: collected.nativeHandleDigest,
      nativeHandleState: 'ready',
    });

    // The admitted identity is path + header ID + cwd; identical replacement needs no inode tracker.
    writePiSession(retainedPath, first.workingDirectory);
    const resumedPlan = await piAdapter.prepareTurn({
      ...first,
      llmRoute: { ...first.llmRoute, model: 'changed-model' },
      nativeTurnDirectory: join(first.sessionDirectory, 'second-turn'),
    });
    expect(piSessionPath(resumedPlan.argv)).toBe(retainedPath);
    expect(resumedPlan.argv[resumedPlan.argv.indexOf('--model') + 1]).toBe('changed-model');
    await expect(
      collectPiTurn(
        first,
        resumedPlan,
        nativeResult(settledEvents({ ...assistantMessage(), model: 'changed-model' }))
      )
    ).resolves.toMatchObject({
      nativeHandleDigest: collected.nativeHandleDigest,
      nativeHandleState: 'ready',
      status: 'completed',
    });
    const retainedBytes = readFileSync(retainedPath);

    await expect(
      piAdapter.closeSession({
        controlRoot: first.controlRoot,
        sessionDirectory: first.sessionDirectory,
      })
    ).resolves.toEqual({ privateState: 'absent' });
    expect(existsSync(first.controlRoot)).toBe(false);
    expect(existsSync(first.sessionDirectory)).toBe(false);
    expect(readFileSync(retainedPath)).toEqual(retainedBytes);

    const successor = {
      ...first,
      controlRoot: join(dirname(first.stateRoot), 'successor-control'),
      sessionDirectory: join(dirname(first.stateRoot), 'successor-session'),
    };
    await piAdapter.openSession({
      controlRoot: successor.controlRoot,
      stateRoot: successor.stateRoot,
    });
    const successorPlan = await piAdapter.prepareTurn(successor);
    expect(piSessionPath(successorPlan.argv)).not.toBe(retainedPath);
    expect(existsSync(piSessionPath(successorPlan.argv))).toBe(false);
  });

  it('rejects a present pending session path instead of letting Pi initialize or reuse it', async () => {
    const input = piInput();
    const initialPlan = await openAndPreparePi(input);
    const retainedPath = piSessionPath(initialPlan.argv);
    writePiSession(retainedPath, input.workingDirectory);

    await expect(piAdapter.prepareTurn(input)).rejects.toThrow(/absent/i);
    expect(readFileSync(retainedPath, 'utf8')).toContain('pi-session-1');
  });

  it('rejects private control that selects a path outside its admitted work-slot root', async () => {
    const input = piInput();
    await piAdapter.openSession({ controlRoot: input.controlRoot, stateRoot: input.stateRoot });
    const controlPath = join(input.controlRoot, 'pi-session.json');
    const control = JSON.parse(readFileSync(controlPath, 'utf8'));
    const outside = join(dirname(input.stateRoot), 'outside-session.jsonl');
    writeFileSync(controlPath, JSON.stringify({ ...control, path: outside }));

    await expect(piAdapter.prepareTurn(input)).rejects.toThrow(/outside/i);
    expect(existsSync(outside)).toBe(false);
  });

  it('rejects an existing sessions-directory symlink without changing conflicting bytes', async () => {
    const input = piInput();
    const outside = join(dirname(input.stateRoot), 'outside-sessions');
    mkdirSync(input.stateRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep'), 'outside bytes');
    symlinkSync(outside, join(input.stateRoot, 'sessions'));

    await expect(
      piAdapter.openSession({ controlRoot: input.controlRoot, stateRoot: input.stateRoot })
    ).rejects.toThrow(/ancestor/i);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('outside bytes');
    expect(existsSync(input.controlRoot)).toBe(false);
  });

  it('rejects a ready session reached through a replaced binding-directory symlink', async () => {
    const input = piInput();
    const plan = await openAndPreparePi(input);
    const retainedPath = piSessionPath(plan.argv);
    writePiSession(retainedPath, input.workingDirectory);
    await collectPiTurn(input, plan, nativeResult(settledEvents(assistantMessage())));
    const bindingRoot = dirname(retainedPath);
    const preservedRoot = `${bindingRoot}-preserved`;
    const outsideRoot = join(dirname(input.stateRoot), 'outside-binding');
    renameSync(bindingRoot, preservedRoot);
    mkdirSync(outsideRoot, { recursive: true });
    writePiSession(join(outsideRoot, 'session.jsonl'), input.workingDirectory);
    writeFileSync(join(outsideRoot, 'keep'), 'conflicting bytes');
    symlinkSync(outsideRoot, bindingRoot);

    await expect(piAdapter.prepareTurn(input)).rejects.toThrow(/header proof/i);
    expect(readFileSync(join(preservedRoot, 'session.jsonl'))).toEqual(
      readFileSync(join(outsideRoot, 'session.jsonl'))
    );
    expect(readFileSync(join(outsideRoot, 'keep'), 'utf8')).toBe('conflicting bytes');
  });

  it.each([
    {
      name: 'missing state',
      mutate: (path: string) => rmSync(path),
    },
    {
      name: 'empty state',
      mutate: (path: string) => writeFileSync(path, ''),
    },
    {
      name: 'malformed header',
      mutate: (path: string) => writeFileSync(path, '{not-json}\n'),
    },
    {
      name: 'wrong session id',
      mutate: (path: string, input: WorkerAdapterPrepareInput) =>
        writePiSession(path, input.workingDirectory, 'different-session'),
    },
    {
      name: 'wrong cwd',
      mutate: (path: string) => writePiSession(path, '/workspace/other'),
    },
    {
      name: 'symlink state',
      mutate: (path: string, input: WorkerAdapterPrepareInput) => {
        const target = join(dirname(path), 'replacement.jsonl');
        writePiSession(target, input.workingDirectory);
        rmSync(path);
        symlinkSync(target, path);
      },
    },
    {
      name: 'FIFO state',
      mutate: (path: string) => {
        rmSync(path);
        const created = spawnSync('mkfifo', [path]);
        if (created.status !== 0) throw new Error('Failed to create Pi FIFO test fixture.');
      },
    },
  ])('rejects ready handle identity with $name before spawn', async ({ mutate }) => {
    const input = piInput();
    const plan = await openAndPreparePi(input);
    const retainedPath = piSessionPath(plan.argv);
    writePiSession(retainedPath, input.workingDirectory);
    await collectPiTurn(input, plan, nativeResult(settledEvents(assistantMessage())));
    mutate(retainedPath, input);

    await expect(piAdapter.prepareTurn(input)).rejects.toThrow(/session/i);
  });

  it('keeps a failed first Turn pending while preserving native bytes for closeout', async () => {
    const input = piInput();
    const plan = await openAndPreparePi(input);
    const retainedPath = piSessionPath(plan.argv);
    writePiSession(retainedPath, input.workingDirectory);
    const retainedBytes = readFileSync(retainedPath);

    await expect(
      collectPiTurn(input, plan, nativeResult([{ type: 'agent_settled' }]))
    ).resolves.toMatchObject({ nativeHandleState: 'unknown', status: 'failed' });
    await expect(
      piAdapter.inspectSession({ controlRoot: input.controlRoot, stateRoot: input.stateRoot })
    ).resolves.toEqual({ nativeHandleDigest: null, nativeHandleState: 'pending' });
    expect(readFileSync(retainedPath)).toEqual(retainedBytes);
  });

  it('projects only the admitted Gateway model into ephemeral native configuration', async () => {
    const input = piInput();
    const retained = join(input.stateRoot, 'pi');
    mkdirSync(retained, { recursive: true });
    writeFileSync(join(retained, 'models.json'), '{"retained":"unchanged"}');
    const prepared = {
      ...input,
      childEnvironment: { OPENKIT_WORKER_INFERENCE_TOKEN: 'private-inference-canary' },
      llmRoute: {
        ...input.llmRoute,
        credentialVisibility: 'placeholder',
        endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
        model: 'grok',
        providerInstanceId: 'gateway',
      },
    };
    const plan = await openAndPreparePi(prepared);
    const configRoot = plan.environment.PI_CODING_AGENT_DIR!;
    expect(configRoot).not.toContain(input.stateRoot);
    const configBytes = readFileSync(join(configRoot, 'models.json'), 'utf8');
    expect(configBytes).not.toContain('private-inference-canary');
    expect(configBytes).toContain('$OPENKIT_WORKER_INFERENCE_TOKEN');
    expect(JSON.parse(configBytes).providers['openkit-worker-inference']).toMatchObject({
      baseUrl: 'http://127.0.0.1:17892/inference/v1',
      api: 'openai-completions',
      models: [{ id: 'grok' }],
    });
    expect(readFileSync(join(retained, 'models.json'), 'utf8')).toBe('{"retained":"unchanged"}');
  });

  it.each([
    'on',
    'off',
  ] as const)('streams admitted text and actual tool results with capture %s, without claiming child support', async (value) => {
    const input = piInput();
    const recorded: Array<{ record: WorkerObservationData; body?: Uint8Array }> = [];
    const prepared = {
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
    };
    const plan = await openAndPreparePi(prepared);
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
    const plan = await openAndPreparePi(input);
    const sessionPath = piSessionPath(plan.argv);

    expect(plan.argv).toEqual([
      'pi',
      '--mode',
      'json',
      '--no-approve',
      '--session',
      sessionPath,
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--offline',
      '--provider',
      'openkit-worker-inference',
      '--model',
      'grok',
      input.turnInput,
    ]);
    expect(plan.captureStdout).toBe(true);
    expect(plan.environment).toMatchObject({
      OPENKIT_WORKER_INFERENCE_TOKEN: 'inference-credential-value',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    });
    expect(plan.environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(plan.environment).not.toHaveProperty('OPENAI_BASE_URL');
    expect(plan.environment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(plan.environment.PI_CODING_AGENT_DIR).toContain(input.controlRoot);
    expect(plan.argv).not.toContain('openshell-placeholder-value');
    expect(plan.argv).not.toContain('--api-key');
    expect(plan).not.toHaveProperty('configArtifacts');
  });

  it.each([
    {
      name: 'environment credential visibility',
      change: (input: WorkerAdapterPrepareInput) => ({
        ...input,
        llmRoute: { ...input.llmRoute, credentialVisibility: 'environment' as const },
      }),
    },
    {
      name: 'non-Gateway upstream',
      change: (input: WorkerAdapterPrepareInput) => ({
        ...input,
        llmRoute: {
          ...input.llmRoute,
          endpoint: {
            kind: 'openai-compatible' as const,
            upstream: { kind: 'backend-local' as const },
          },
        },
      }),
    },
    ...[
      { contextWindow: 0 },
      { maxOutputTokens: -1 },
      { maxOutputTokens: 360001 },
      { reasoning: undefined },
      { inputModalities: ['image'] },
      { inputModalities: ['text', 'audio'] },
      { inputModalities: ['text', 'video'] },
      { inputModalities: ['text', 'pdf'] },
    ].map((change) => ({
      name: `unsupported model parameters ${JSON.stringify(change)}`,
      change: (input: WorkerAdapterPrepareInput) => ({
        ...input,
        llmRoute: {
          ...input.llmRoute,
          modelParameters: {
            ...input.llmRoute.modelParameters,
            ...change,
          } as WorkerAdapterPrepareInput['llmRoute']['modelParameters'],
        },
      }),
    })),
    {
      name: 'direct provider authority',
      change: (input: WorkerAdapterPrepareInput) => ({
        ...input,
        llmRoute: {
          ...input.llmRoute,
          endpoint: {
            kind: 'provider-compatible' as const,
            upstream: { kind: 'direct-provider' as const },
          },
        },
      }),
    },
    {
      name: 'missing inference credential',
      change: (input: WorkerAdapterPrepareInput) => ({ ...input, childEnvironment: {} }),
    },
    {
      name: 'missing effective model parameters',
      change: (input: WorkerAdapterPrepareInput) => ({
        ...input,
        llmRoute: { ...input.llmRoute, modelParameters: undefined },
      }),
    },
    {
      name: 'caller endpoint',
      change: (input: WorkerAdapterPrepareInput) => ({
        ...input,
        llmRoute: {
          ...input.llmRoute,
          endpoint: { ...input.llmRoute.endpoint, workerBaseUrl: 'https://other.invalid' },
        },
      }),
    },
  ])('rejects $name before launch', async ({ change }) => {
    await expect(openAndPreparePi(change(piInput()))).rejects.toThrow(/unsupported/i);
  });

  it('creates fresh configuration per attempt and preserves admitted non-default model identity', async () => {
    const base = piInput();
    const input = { ...base, llmRoute: { ...base.llmRoute, model: 'other-logical-model' } };
    const first = await openAndPreparePi(input);
    const next = await piAdapter.prepareTurn(input);
    expect(next.environment.PI_CODING_AGENT_DIR).not.toBe(first.environment.PI_CODING_AGENT_DIR);
    const message = { ...assistantMessage(), model: 'other-logical-model' };
    await expect(
      collectPiTurn(input, next, nativeResult(settledEvents(message)))
    ).resolves.toMatchObject({ status: 'completed' });
    await expect(
      collectPiTurn(input, next, nativeResult(settledEvents(assistantMessage())))
    ).resolves.toMatchObject({ status: 'failed', stopReason: 'pi-route-mismatch' });
  });

  it('fails preparation when the ephemeral directory cannot be written', async () => {
    const input = piInput();
    writeFileSync(input.sessionDirectory, 'occupied');
    await expect(
      openAndPreparePi({ ...input, nativeTurnDirectory: input.sessionDirectory })
    ).rejects.toThrow();
    expect(readFileSync(input.sessionDirectory, 'utf8')).toBe('occupied');
  });

  it('accepts ordered text only after exact final settlement correlation', async () => {
    const input = piInput();
    const launchPlan = await openAndPreparePi(input);
    const retryMessage = assistantMessage('error');
    const processResult = nativeResult([
      { type: 'session', version: 3 },
      { message: retryMessage, type: 'message_end' },
      { message: retryMessage, toolResults: [], type: 'turn_end' },
      { messages: [retryMessage], type: 'agent_end', willRetry: true },
      ...settledEvents(assistantMessage()),
      { type: 'future_runtime_event' },
    ]);

    await expect(collectPiTurn(input, launchPlan, processResult)).resolves.toMatchObject({
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
    const input = piInput();
    const launchPlan = await openAndPreparePi(input);

    await expect(
      collectPiTurn(input, launchPlan, nativeResult(events, overrides))
    ).resolves.toMatchObject({ assistantText: null, status: expectedStatus });
  });

  it('fails closed on invalid UTF-8 inside otherwise valid terminal JSON', async () => {
    const input = piInput();
    const launchPlan = await openAndPreparePi(input);
    const processResult = nativeResult(settledEvents(assistantMessage()));
    const stdout = Buffer.concat([
      Buffer.from('{"note":"'),
      Buffer.from([0xff]),
      Buffer.from('","type":"future_runtime_event"}\n'),
      Buffer.from(processResult.stdout),
    ]);

    await expect(
      collectPiTurn(input, launchPlan, { ...processResult, stdout })
    ).resolves.toMatchObject({ assistantText: null, status: 'failed' });
  });
});

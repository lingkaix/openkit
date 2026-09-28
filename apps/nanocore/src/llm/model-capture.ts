import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { redactInternalAgentText } from '../internal-agents/redaction.js';
import type { FsStore } from '../lib/store.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  type AdmittedWorkBody,
  appendWorkObservation,
  readWorkObservationTurnBinding,
  type WorkObservationDraft,
} from '../storage/work-observations.js';
import type { ModelSemanticEvent } from './model-semantic-content.js';
import { digestLlmSystemPrompt } from './system-prompt-digest.js';

/** Exact trusted entry-owned Turn and logical call; never populated from provider metadata alone. */
export interface ModelCaptureContext {
  readonly workspaceDb: WorkspaceDb;
  readonly threadId: string;
  readonly turnId: string;
  readonly corr: string;
  readonly attempt?: number;
  readonly capabilityCallId?: string;
  readonly runtimeOriginRef?: string | null;
}

/** Local retention failure, deliberately distinct from retryable provider errors. */
export class ModelCaptureError extends Error {
  public readonly code = 'model_capture_unavailable';
  public constructor() {
    super('Model observation retention is unavailable.');
    this.name = 'ModelCaptureError';
  }
}

/**
 * Runs one model effect with the exact admitted Turn binding and owns any Workspace database it opens.
 * Optional internal-agent environment metadata commits before the effect, independently of full I/O capture.
 *
 * @param input Store-owned Turn, optional borrowed database and exact internal-agent prompt/Tool inputs.
 * @param run Model effect that receives the trusted context.
 * @returns The model effect's result.
 * @throws ModelCaptureError when durable lineage, coverage or required environment retention cannot be verified.
 */
export async function withTurnModelCapture<T>(
  input: {
    readonly store: FsStore;
    readonly turn: ReturnType<FsStore['createTurn']>;
    readonly workspaceDb?: WorkspaceDb;
    readonly environment?: {
      readonly systemPrompt: string;
      readonly tools: readonly {
        readonly name: string;
        readonly inputSchema: Readonly<Record<string, unknown>>;
      }[];
    };
  },
  run: (capture: Omit<ModelCaptureContext, 'corr'>) => Promise<T>
): Promise<T> {
  const { store, turn, workspaceDb } = input;
  const dataRoot = store.getDataRoot();
  if (
    !dataRoot ||
    (workspaceDb &&
      (workspaceDb.dataRoot !== dataRoot || workspaceDb.workspaceId !== turn.workspaceId))
  ) {
    throw new ModelCaptureError();
  }
  try {
    store.getTurn(turn.workspaceId, turn.threadId, turn.id);
  } catch {
    throw new ModelCaptureError();
  }
  let captureDb: WorkspaceDb;
  try {
    captureDb = workspaceDb ?? openWorkspaceDb(dataRoot, turn.workspaceId);
  } catch {
    throw new ModelCaptureError();
  }
  try {
    try {
      if (!workspaceDb) applyScopedMigrations(captureDb);
      const binding = readWorkObservationTurnBinding(captureDb, {
        threadId: turn.threadId,
        turnId: turn.id,
      });
      if (!binding.coverage) {
        throw new ModelCaptureError();
      }
      if (input.environment) {
        if (binding.turn.startedAt === null) throw new ModelCaptureError();
        const { version } = JSON.parse(
          readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
        );
        // Admission time and identity let the existing writer deduplicate exact re-entry and reject rebinding.
        appendWorkObservation(captureDb, {
          threadId: turn.threadId,
          turnId: turn.id,
          observation: {
            id: `env:${turn.id}`,
            ts: binding.turn.startedAt,
            type: 'env.bound',
            obs: 'core',
            ret: 'turn-evidence',
            payload: {
              version,
              workspaceId: captureDb.workspaceId,
              systemPromptDigest: digestLlmSystemPrompt({
                endpoint: 'responses',
                request: { instructions: input.environment.systemPrompt },
              }),
              tools: input.environment.tools.map(({ name, inputSchema }) => ({
                name,
                inputSchemaDigest: createHash('sha256')
                  .update(JSON.stringify(inputSchema))
                  .digest('hex'),
              })),
            },
          },
          bodies: [],
        });
      }
    } catch {
      throw new ModelCaptureError();
    }
    return await run({ workspaceDb: captureDb, threadId: turn.threadId, turnId: turn.id });
  } finally {
    if (!workspaceDb) captureDb.sqlite.close();
  }
}

/** Binds persisted admission and appends admitted semantic bytes through the sole Core writer. */
export class ModelCapture {
  private readonly enabled: boolean;
  private readonly attemptId = randomUUID();
  private readonly requestId = `${this.attemptId}:0`;
  private sequence = 0;
  private pending: { observation: WorkObservationDraft; bodies: readonly AdmittedWorkBody[] }[] =
    [];
  private pendingBytes = 0;
  private unitFailure: 'credential-excluded' | 'limit-exceeded' | 'capture-failed' | undefined;

  /** Validates the exact persisted Turn before any governed model effect. */
  public constructor(
    private readonly context: ModelCaptureContext,
    private readonly secrets: readonly string[],
    private readonly providerRef: string
  ) {
    try {
      const binding = readWorkObservationTurnBinding(context.workspaceDb, context);
      if (!binding.coverage) throw new ModelCaptureError();
      this.enabled = binding.coverage.value === 'on';
    } catch {
      throw new ModelCaptureError();
    }
  }

  /** Records a pre-adapter semantic request without cache keys, metadata or private carriers. */
  public request(request: unknown): void {
    const input = record(request);
    const reasoning = record(input.reasoning);
    this.record('request', 'request', () => admittedModelRequest(request), {
      providerRef: this.providerRef,
      model: input.model,
      systemPromptDigest: digestLlmSystemPrompt({
        endpoint: Array.isArray(input.messages) ? 'chat_completions' : 'responses',
        request,
      }),
      // Absence is not a default; explicit null and zero remain requested values.
      sampling: select(
        {
          temperature: input.temperature,
          topP: input.top_p,
          maxOutputTokens:
            input.max_output_tokens !== undefined
              ? input.max_output_tokens
              : input.max_completion_tokens !== undefined
                ? input.max_completion_tokens
                : input.max_tokens,
          reasoningEffort:
            reasoning.effort !== undefined ? reasoning.effort : input.reasoning_effort,
          reasoningSummary: reasoning.summary,
          reasoningContext: reasoning.context,
        },
        [
          'temperature',
          'topP',
          'maxOutputTokens',
          'reasoningEffort',
          'reasoningSummary',
          'reasoningContext',
        ]
      ),
    });
  }

  /** Defers original event bytes until the bounded assistant message passes a whole-unit scan. */
  public event(event: ModelSemanticEvent): void {
    this.record(
      'response',
      event.type,
      () => event,
      typeof event.reportedModel === 'string' ? { reportedModel: event.reportedModel } : {},
      true
    );
    if (['done', 'error', 'interrupted', 'failed', 'truncated'].includes(event.type)) {
      if (!this.unitFailure) {
        const deltas = new Map<string, string[]>();
        for (const pending of this.pending) {
          const value = JSON.parse(new TextDecoder().decode(pending.bodies[0]!.bytes));
          if (typeof value.delta === 'string') {
            const key =
              value.type === 'text_delta' ? 'assistant' : `${value.type}:${value.contentIndex}`;
            const parts = deltas.get(key) ?? [];
            parts.push(value.delta);
            deltas.set(key, parts);
          }
        }
        if (
          [...deltas.values()].some((parts) =>
            containsExcludedCredential(parts.join(''), this.secrets)
          )
        )
          this.rejectPending('credential-excluded');
        else for (const pending of this.pending) this.append(pending.observation, pending.bodies);
      }
      this.pending = [];
      this.pendingBytes = 0;
      this.unitFailure = undefined;
    }
  }

  /** Discards a whole incomplete message without publishing any original fragment. */
  private rejectPending(reason: 'credential-excluded' | 'limit-exceeded' | 'capture-failed'): void {
    this.unitFailure = reason;
    for (const pending of this.pending) this.gap(pending.observation, reason);
    this.pending = [];
    this.pendingBytes = 0;
  }

  /** Commits structural metadata even when full capture is off or content admission fails. */
  private record(
    direction: 'request' | 'response',
    event: string,
    content: () => unknown,
    metadata: Record<string, unknown> = {},
    defer = false
  ): void {
    const id = `${this.attemptId}:${this.sequence++}`;
    const ts = new Date().toISOString();
    let bytes: Uint8Array | undefined;
    let state: Record<string, string> = { state: this.enabled ? 'expected' : 'off' };
    if (this.enabled && defer && this.unitFailure) {
      state = { state: 'unavailable', reason: this.unitFailure };
    } else if (this.enabled) {
      try {
        const admitted = content();
        const serialized = JSON.stringify(admitted);
        if (containsExcludedCredential(admitted, this.secrets)) {
          state = { state: 'unavailable', reason: 'credential-excluded' };
        } else {
          const encoded = new TextEncoder().encode(serialized);
          if (encoded.byteLength > 16 * 1024 * 1024)
            state = { state: 'unavailable', reason: 'limit-exceeded' };
          else bytes = encoded;
        }
      } catch {
        state = { state: 'unavailable', reason: 'capture-failed' };
      }
    }
    if (defer && bytes && this.pendingBytes + bytes.byteLength > 16 * 1024 * 1024) {
      bytes = undefined;
      state = { state: 'unavailable', reason: 'limit-exceeded' };
    }
    if (defer && state.state === 'unavailable' && !this.unitFailure)
      this.rejectPending(
        state.reason as 'credential-excluded' | 'limit-exceeded' | 'capture-failed'
      );
    const observation: WorkObservationDraft = {
      id,
      ts,
      type: 'model.observed',
      obs: 'gateway' as const,
      corr: this.context.corr,
      ret: 'turn-evidence' as const,
      ...(direction === 'response' ? { parent: this.requestId } : {}),
      ...(this.context.capabilityCallId
        ? {
            refs: [
              {
                kind: 'capability-call',
                scope: { workspaceId: this.context.workspaceDb.workspaceId },
                locator: this.context.capabilityCallId,
                edge: 'association' as const,
              },
            ],
          }
        : {}),
      payload: {
        direction,
        event,
        attempt: this.context.attempt ?? 0,
        runtimeOriginRef: this.context.runtimeOriginRef ?? null,
        ...metadata,
        content: state,
      },
    };
    if (containsExcludedCredential(metadata, this.secrets)) {
      this.gap(observation, 'credential-excluded');
      return;
    }
    const bodies = bytes
      ? [
          {
            id: 'semantic',
            bytes,
            mediaType: 'application/json',
            boundary: 'gateway-admitted-semantic-v1',
          },
        ]
      : [];
    this.append(observation, bodies, defer);
    if (defer && bytes) {
      this.pending.push({ observation, bodies });
      this.pendingBytes += bytes.byteLength;
    }
  }

  /** Commits metadata immediately; deferred bytes remain solely in bounded process memory. */
  private append(
    observation: WorkObservationDraft,
    bodies: readonly AdmittedWorkBody[],
    defer = false
  ): void {
    try {
      appendWorkObservation(this.context.workspaceDb, {
        threadId: this.context.threadId,
        turnId: this.context.turnId,
        observation,
        bodies,
        ...(defer ? { deferBodyPublication: true } : {}),
      });
    } catch {
      this.gap(observation, 'capture-failed');
    }
  }

  /** Records a failed or excluded publication against the exact original observation. */
  private gap(
    observation: WorkObservationDraft,
    reason: 'credential-excluded' | 'limit-exceeded' | 'capture-failed'
  ): void {
    try {
      appendWorkObservation(this.context.workspaceDb, {
        threadId: this.context.threadId,
        turnId: this.context.turnId,
        observation: {
          ...observation,
          id: `${observation.id}:gap:${reason}`,
          parent: observation.id,
          type: 'model.capture-gap',
          payload: {
            direction: observation.payload.direction,
            event: observation.payload.event,
            attempt: this.context.attempt ?? 0,
            content: { state: 'unavailable', reason },
          },
        },
        bodies: [],
      });
    } catch {
      throw new ModelCaptureError();
    }
  }
}

/** Positive-selects admitted request fields while preserving exact content strings and Tool JSON. */
export function admittedModelRequest(value: unknown): Record<string, unknown> {
  const request = record(value);
  const result = select(request, [
    'model',
    'stream',
    'instructions',
    'temperature',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'max_output_tokens',
    'parallel_tool_calls',
    'stop',
    'response_format',
    'text',
  ]);
  if (request.reasoning !== undefined)
    result.reasoning = select(record(request.reasoning), ['effort', 'summary', 'context']);
  if (request.reasoning_effort !== undefined) result.reasoning_effort = request.reasoning_effort;
  if (Array.isArray(request.messages))
    result.messages = request.messages.map(admittedInput).filter((item) => item !== null);
  if (typeof request.input === 'string') result.input = request.input;
  else if (Array.isArray(request.input))
    result.input = request.input.map(admittedInput).filter((item) => item !== null);
  if (Array.isArray(request.tools)) result.tools = request.tools.map(admittedTool);
  if (typeof request.tool_choice === 'string') result.tool_choice = request.tool_choice;
  else if (request.tool_choice) {
    const choice = record(request.tool_choice);
    result.tool_choice = {
      ...select(choice, ['type', 'name']),
      ...(choice.function ? { function: select(record(choice.function), ['name']) } : {}),
    };
  }
  return result;
}

/** Selects message and Tool input fields; private reasoning items and carriers are never copied. */
function admittedInput(value: unknown): Record<string, unknown> | null {
  const input = record(value);
  if (['reasoning', 'compaction'].includes(String(input.type))) return null;
  const result = select(input, [
    'type',
    'role',
    'id',
    'name',
    'namespace',
    'call_id',
    'tool_call_id',
    'arguments',
    'input',
    'output',
    'status',
    'phase',
    'execution',
  ]);
  if (typeof input.content === 'string' || input.content === null) result.content = input.content;
  else if (Array.isArray(input.content))
    result.content = input.content.flatMap((value) => {
      const part = record(value);
      if (['text', 'input_text', 'output_text'].includes(String(part.type)))
        return [select(part, ['type', 'text'])];
      if (['image_url', 'input_image'].includes(String(part.type)))
        return [
          {
            ...select(part, ['type', 'detail']),
            image_url:
              typeof part.image_url === 'string'
                ? part.image_url
                : select(record(part.image_url), ['url', 'detail']),
          },
        ];
      return [];
    });
  if (Array.isArray(input.tool_calls))
    result.tool_calls = input.tool_calls.map((value) => {
      const call = record(value);
      return {
        ...select(call, ['type', 'id']),
        function: select(record(call.function), ['name', 'arguments']),
      };
    });
  if (Array.isArray(input.tools)) result.tools = input.tools.map(admittedTool);
  return result;
}

/** Selects Tool definitions, retaining the admitted argument schema as authored JSON. */
function admittedTool(value: unknown): Record<string, unknown> {
  const tool = record(value);
  return {
    ...select(tool, [
      'type',
      'name',
      'description',
      'parameters',
      'strict',
      'format',
      'defer_loading',
      'execution',
    ]),
    ...(tool.function
      ? { function: select(record(tool.function), ['name', 'description', 'parameters', 'strict']) }
      : {}),
    ...(Array.isArray(tool.tools) ? { tools: tool.tools.map(admittedTool) } : {}),
  };
}

/** Rejects the entire body on known exact or common secret-shaped content; this is not universal DLP. */
function containsExcludedCredential(value: unknown, secrets: readonly string[]): boolean {
  const variants = secrets
    .filter(Boolean)
    .flatMap((secret) => [
      secret,
      encodeURIComponent(secret),
      new URLSearchParams({ value: secret }).toString().slice('value='.length),
    ]);
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const entry = pending.pop();
    if (typeof entry === 'string') {
      // Decode JSON string escapes for admission only; retained bytes are never transformed.
      const decoded = entry.replace(
        /\\u([0-9a-f]{4})|\\(["\\/bfnrt])/gi,
        (_match, unicode: string | undefined, escaped: string) =>
          unicode
            ? String.fromCharCode(Number.parseInt(unicode, 16))
            : (JSON.parse(`"\\${escaped}"`) as string)
      );
      if (
        variants.some((secret) => entry.includes(secret) || decoded.includes(secret)) ||
        redactInternalAgentText(entry) !== entry ||
        redactInternalAgentText(decoded) !== decoded
      )
        return true;
    } else if (entry && typeof entry === 'object' && !seen.has(entry)) {
      seen.add(entry);
      pending.push(...Object.keys(entry), ...Object.values(entry));
    }
  }
  return false;
}

/** Copies only named semantic fields, never arbitrary transport extensions. */
function select(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])
  );
}

/** Narrows a candidate semantic object without trusting its prototype or arbitrary fields. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

import { randomUUID } from 'node:crypto';
import type { GatewayConfig } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { finishCapabilityCall, startCapabilityCall } from '../capability/usage-ledger.js';
import { admitModelRequest } from '../context/model-request-admission.js';
import type { FsStore } from '../lib/store.js';
import { trackLocalTitleAbort } from '../local-ai/title-abort.js';
import { ControlStoreWorkerError } from '../storage/control-store-worker-error.js';
import type { WorkspaceDb } from '../storage/db.js';
import { dispatchLogicalModel } from './gateway-routes.js';
import { recordInternalLlmGatewayUsage } from './gateway-usage.js';
import { resolveLogicalModel } from './logical-models.js';
import {
  type OpenAICompatibleChatCompletionRequest,
  type OpenAICompatibleChatCompletionResponse,
  OpenAICompatibleProviderError,
} from './openai-compatible-client.js';
import type {
  LLMGatewayDispatchContext,
  LLMGatewayProviderDispatcher,
} from './provider-dispatcher.js';

/** Prompt measured in bench.md section 3. */
export const TITLE_SYSTEM_PROMPT = `Summarize the user's message into a short, natural title (3-6 words in English, or 6-14 characters in Chinese).
Rules:
1. Match the user's language: if the message contains Chinese, write a Chinese title (keeping English technical terms like Gateway, SQLite, OAuth intact); if the message is purely English, write an English title in normal words with spaces.
2. Never use snake_case or kebab-case.
3. Output ONLY the title, no quotes, no punctuation at the end.
Examples:
User: 帮我看看为什么 worker container 启动的时候挂载 volume 失败了
Title: 排查 Worker 容器挂载失败
User: Fix the memory leak in the WebSocket heartbeat timer when a client disconnects abruptly.
Title: Fix WebSocket Heartbeat Memory Leak`;

/** Admission window for a title call. There is no local exemption. */
export const TITLE_CONTEXT_TOKENS = 6144;

/** Output reserve passed to admitModelRequest. */
export const TITLE_OUTPUT_RESERVE = 32;

/** Title attempt budget, including time waiting for the single llama slot. */
export const TITLE_DEADLINE_MS = 10_000;

/** Product input cap, in Unicode code points. */
export const TITLE_INPUT_CODE_POINTS = 500;

/** Sanitizer reject cap, in Unicode code points. */
export const TITLE_MAX_CODE_POINTS = 80;

/** Replaces createChatCompletion inside the one dispatch path. */
export type TitleCompletion = (
  provider: Parameters<LLMGatewayProviderDispatcher['createChatCompletion']>[0],
  request: OpenAICompatibleChatCompletionRequest,
  context: LLMGatewayDispatchContext
) => Promise<OpenAICompatibleChatCompletionResponse>;

/** Owners a fresh create uses to run one title call. */
export interface TitleGenerationRuntime {
  runtimeConfig(): {
    gatewayConfig: GatewayConfig;
    providerRegistry: Parameters<typeof resolveLogicalModel>[1];
  };
  repositoryWorkspaceDb(workspaceId: string): WorkspaceDb;
  dispatcher: Pick<LLMGatewayProviderDispatcher, 'createChatCompletion'>;
  resolveGatewayProvider: Parameters<typeof dispatchLogicalModel>[0]['resolveGatewayProvider'];
  providerSubscriptionAccountManager?: NonNullable<
    Parameters<typeof dispatchLogicalModel>[0]['providerSubscriptionAccountManager']
  >;
  providerCredentialConfigured?: Parameters<typeof resolveLogicalModel>[4];
}

/** Facts captured when the thread was created. */
export interface FreshThreadTitle {
  readonly store: FsStore;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly initialName: string;
  readonly sourceText: string;
  readonly actor: ActorRef;
  readonly runtime?: TitleGenerationRuntime;
  readonly complete?: TitleCompletion;
}

let bound: TitleGenerationRuntime | undefined;

/** Installs the process Gateway used by fresh creates. Tests pass a runtime directly. */
export function bindTitleGeneration(runtime: TitleGenerationRuntime | undefined): void {
  bound = runtime;
}

/** First 500 code points of the product input. */
export function titleSource(text: string): string {
  return [...text].slice(0, TITLE_INPUT_CODE_POINTS).join('');
}

/**
 * Strips one think block, one leading Title:, markdown marks, surrounding quotes,
 * and trailing punctuation, then collapses whitespace.
 *
 * @returns The title, or null when the result is empty or longer than 80 code points.
 */
export function sanitizeTitle(raw: string): string | null {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/^Title:\s*/i, '');
  text = text.replace(/[*#`]/g, '');
  text = text.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '');
  const chars = [...text];
  while (chars.length > 0) {
    const last = chars[chars.length - 1] ?? '';
    if (last === '_' || last === '-' || !/^\p{P}$/u.test(last)) break;
    chars.pop();
  }
  text = chars.join('').replace(/\s+/g, ' ').trim();
  if (text.length === 0 || [...text].length > TITLE_MAX_CODE_POINTS) return null;
  return text;
}

/**
 * Starts one title call after a fresh create has committed.
 * No configured title model, and no bound runtime, does not call.
 * A definite native revision refusal permits one guarded re-read/write; other failures keep the current title.
 */
export function scheduleThreadTitle(input: FreshThreadTitle): void {
  const runtime = input.runtime ?? bound;
  if (!runtime) return;
  if (!runtime.runtimeConfig().gatewayConfig.titleLogicalModelId) return;
  void generateThreadTitle({ ...input, runtime }).catch(() => undefined);
}

/**
 * Runs one title through admission, the shared dispatcher, and one terminal finish.
 *
 * @param input Fresh thread plus an optional completion hook that replaces createChatCompletion.
 */
export async function generateThreadTitle(input: FreshThreadTitle): Promise<void> {
  const runtime = input.runtime ?? bound;
  if (!runtime) return;
  const logicalModelId = runtime.runtimeConfig().gatewayConfig.titleLogicalModelId;
  if (!logicalModelId) return;
  const capped = titleSource(input.sourceText);
  const messages = [
    { role: 'system' as const, content: TITLE_SYSTEM_PROMPT },
    { role: 'user' as const, content: `User: ${capped}\nTitle:` },
  ];
  const deadline = AbortSignal.timeout(TITLE_DEADLINE_MS);
  const caller = new AbortController();
  const signal = AbortSignal.any([deadline, caller.signal]);
  const workspaceDb = runtime.repositoryWorkspaceDb(input.workspaceId);
  let callId: string | undefined;
  let finished = false;
  const finish = async (status: 'succeeded' | 'failed' | 'timed-out' | 'aborted') => {
    if (!callId || finished) return;
    finished = true;
    await finishCapabilityCall({ workspaceDb, callId, status });
  };
  try {
    const snapshot = runtime.runtimeConfig();
    const logicalModel = resolveLogicalModel(
      snapshot.gatewayConfig,
      snapshot.providerRegistry,
      logicalModelId,
      runtime.providerSubscriptionAccountManager,
      runtime.providerCredentialConfigured
    );
    if (!logicalModel) throw new Error('Title logical model is not available.');
    const call = await startCapabilityCall({
      workspaceDb,
      workspaceId: input.workspaceId,
      authorityActor: input.actor,
      threadId: input.threadId,
      family: 'llm',
      operation: 'llm.title_generation',
      capabilityId: 'llm.chat_completions',
      providerRef: logicalModelId,
      serviceRef: 'llm-gateway',
      redactionClass: 'metadata-only',
      summary: 'Thread title.',
      requestId: randomUUID(),
      sourceIds: [],
    });
    callId = call.id;
    const response = await dispatchLogicalModel<OpenAICompatibleChatCompletionResponse>({
      ledger: { workspaceDb, call },
      logicalModel,
      signal,
      resolveGatewayProvider: runtime.resolveGatewayProvider,
      ...(runtime.providerSubscriptionAccountManager
        ? { providerSubscriptionAccountManager: runtime.providerSubscriptionAccountManager }
        : {}),
      attempt: async ({ provider, providerModel, subscriptionModels, execution }) => {
        const request: OpenAICompatibleChatCompletionRequest = {
          model: providerModel,
          messages,
          temperature: 0,
          max_tokens: 32,
        };
        admitModelRequest({
          payload: request,
          contextWindowTokens: TITLE_CONTEXT_TOKENS,
          outputReserveTokens: TITLE_OUTPUT_RESERVE,
        });
        const context: LLMGatewayDispatchContext = {
          ...(subscriptionModels ? { models: subscriptionModels } : {}),
          onUsage: async (usage) => {
            await execution.addUsageRecordIds(
              await recordInternalLlmGatewayUsage({
                workspaceDb,
                call,
                logicalModelId,
                providerId: provider.id,
                providerModel,
                usage,
                succeeded: false,
              })
            );
          },
          transport: { signal },
        };
        const complete =
          input.complete ??
          ((nextProvider, nextRequest, nextContext) =>
            runtime.dispatcher.createChatCompletion(nextProvider, nextRequest, nextContext));
        const release = provider.baseUrl
          ? trackLocalTitleAbort(provider.baseUrl, caller)
          : () => undefined;
        try {
          return await complete(provider, request, context);
        } finally {
          release();
        }
      },
    });
    const content = response.choices[0]?.message.content ?? '';
    const title = sanitizeTitle(typeof content === 'string' ? content : '');
    if (title) {
      try {
        await input.store.updateThread(
          input.workspaceId,
          input.threadId,
          { name: title },
          undefined,
          { status: 'active', name: input.initialName }
        );
      } catch (error) {
        if (
          error instanceof ControlStoreWorkerError &&
          error.code === 'precondition' &&
          error.commit === 'not-committed'
        ) {
          try {
            // Handoff publication can advance the revision after the fast model's first read.
            // Only the exact captured automatic name remains eligible; the write repeats this guard.
            const current = input.store.getThread(input.workspaceId, input.threadId);
            if (current.status === 'active' && current.name === input.initialName) {
              await input.store.updateThread(
                input.workspaceId,
                input.threadId,
                { name: title },
                undefined,
                { status: 'active', name: input.initialName }
              );
            }
          } catch {
            try {
              console.warn(
                JSON.stringify({ event: 'thread.title.update-refused', threadId: input.threadId })
              );
            } catch {
              // A diagnostic sink failure cannot fail the completed model call.
            }
          }
        }
      }
    }
    await finish('succeeded');
  } catch (error) {
    await finish(titleFinishStatus(error, signal)).catch(() => undefined);
  } finally {
    workspaceDb.sqlite.close();
  }
}

function titleFinishStatus(
  error: unknown,
  signal: AbortSignal
): 'failed' | 'timed-out' | 'aborted' {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timed-out';
  if (
    error instanceof OpenAICompatibleProviderError &&
    (error.status === 408 || error.status === 504)
  ) {
    return 'timed-out';
  }
  const reason = signal.reason;
  if (signal.aborted && reason instanceof DOMException && reason.name === 'TimeoutError') {
    return 'timed-out';
  }
  if (signal.aborted) return 'aborted';
  return 'failed';
}

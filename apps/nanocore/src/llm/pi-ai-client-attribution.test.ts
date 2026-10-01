import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { REASONING_ATTRIBUTION_LIMIT, ReasoningAttribution } from './reasoning-attribution.js';

/** Creates a real pi-ai runtime with a synthetic provider that exposes received history. */
function fixture() {
  const faux = fauxProvider({
    api: 'openai-responses',
    provider: 'openai-codex',
    models: [
      { id: 'gpt-test', reasoning: true },
      { id: 'gpt-other', reasoning: true },
    ],
  });
  const models = createModels();
  const history: unknown[] = [];
  const capsule = {
    id: `rs_${crypto.randomUUID()}`,
    type: 'reasoning',
    encrypted_content: 'opaque-ciphertext',
    content: null,
    summary: [{ type: 'summary_text', text: 'Readable reasoning.' }],
  };
  const block = {
    ...fauxThinking('Readable reasoning.'),
    thinkingSignature: JSON.stringify(capsule),
  };
  const message = fauxAssistantMessage([block, fauxText('Answer.')]);
  Object.assign(faux.provider, {
    stream: (_model: unknown, context: TranscriptContext) => {
      history.push(context.messages);
      const events = createAssistantMessageEventStream();
      events.push({ type: 'start', partial: { ...message, content: [] } });
      events.push({
        type: 'thinking_end',
        contentIndex: 0,
        content: block.thinking,
        partial: message,
      });
      events.push({ type: 'text_end', contentIndex: 1, content: 'Answer.', partial: message });
      events.push({ type: 'done', reason: 'stop', message });
      events.end(message);
      return events;
    },
  });
  models.setProvider(faux.provider);
  const provider = {
    id: 'account-a',
    adapterId: 'openai-codex',
    subscriptionProviderId: 'openai-codex',
    backend: 'pi-ai',
    apiKey: null,
    requiresApiKey: false,
    baseUrl: null,
    models: ['gpt-test', 'gpt-other'],
    gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
  } as unknown as ResolvedLLMProviderConfig;
  return { capsule, history, models, provider };
}

/** Builds a reasoning/tool history with an fc_ identity tied to the capsule. */
function replay(capsule: Record<string, unknown>) {
  return {
    model: 'gpt-test',
    input: [
      capsule,
      {
        type: 'function_call',
        id: 'fc_paired',
        call_id: 'call_paired',
        name: 'check',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'call_paired', output: 'ok' },
    ],
    tools: [{ type: 'function', name: 'check', parameters: { type: 'object', properties: {} } }],
  };
}

describe('pi-ai reasoning attribution', () => {
  it('hands external capsules off as readable assistant text and drops the paired fc_ id', async () => {
    const { capsule, history, models, provider } = fixture();
    await new PiAiGatewayClient().createResponses(provider, replay(capsule), undefined, {}, models);
    const bytes = JSON.stringify(history.at(-1));
    expect(bytes).toContain('Readable reasoning.');
    expect(bytes).not.toContain('opaque-ciphertext');
    expect(bytes).not.toContain('thinkingSignature');
    expect(bytes).not.toContain('fc_paired');
    expect(bytes).toContain('call_paired');
  });
  it.each([
    'restart',
    'eviction',
  ])('uses readable handoff after %s even for the original member', async (loss) => {
    const { history, models, provider } = fixture();
    const association = new ReasoningAttribution();
    const client = new PiAiGatewayClient({ reasoningAttribution: association });
    const response = await client.createResponses(
      provider,
      { model: 'gpt-test', input: 'hello' },
      undefined,
      {},
      models
    );
    if (loss === 'eviction') {
      for (let index = 0; index < REASONING_ATTRIBUTION_LIMIT; index++)
        association.record(`rs_other_${index}`, { providerId: provider.id, modelId: 'gpt-test' });
    }
    const restarted =
      loss === 'restart'
        ? new PiAiGatewayClient({ reasoningAttribution: new ReasoningAttribution() })
        : client;
    await restarted.createResponses(provider, replay(response.output![0]!), undefined, {}, models);
    const bytes = JSON.stringify(history.at(-1));
    expect(bytes).toContain('Readable reasoning.');
    expect(bytes).not.toContain('opaque-ciphertext');
    expect(bytes).not.toContain('thinkingSignature');
    expect(bytes).not.toContain('fc_paired');
  });
  it('matches two logical-model dispatches using the same profile and native model across clients', async () => {
    const { history, models, provider } = fixture();
    // Logical route ids are resolved above the client; both dispatches arrive with this same native id.
    const first = await new PiAiGatewayClient().createResponses(
      provider,
      { model: 'gpt-test', input: 'first logical model' },
      undefined,
      {},
      models
    );
    await new PiAiGatewayClient().createResponses(
      provider,
      replay(first.output![0]!),
      undefined,
      {},
      models
    );
    expect(JSON.stringify(history.at(-1))).toContain('opaque-ciphertext');
    expect(JSON.stringify(history.at(-1))).toContain('fc_paired');
  });
  it.each([
    [[]],
    [[{ type: 'summary_text', text: '  ' }]],
  ])('omits unattributed empty/redacted thinking (%j)', async (summary) => {
    const { history, models, provider, capsule } = fixture();
    await new PiAiGatewayClient().createResponses(
      provider,
      replay({ ...capsule, summary }),
      undefined,
      {},
      models
    );
    const bytes = JSON.stringify(history.at(-1));
    expect(bytes).not.toContain('opaque-ciphertext');
    expect(bytes).not.toContain('thinkingSignature');
    expect(bytes).not.toContain('fc_paired');
    expect(bytes).not.toContain('"type":"thinking"');
  });
  it.each([
    false,
    true,
  ])('preserves only same-profile/native-model round trips (stream=%s)', async (stream) => {
    const { capsule, history, models, provider } = fixture();
    const client = new PiAiGatewayClient();
    const request = { model: 'gpt-test', input: 'hello' };
    const response = stream
      ? JSON.parse(
          (
            await new Response(
              await client.createResponsesStream(provider, request, undefined, {}, models)
            ).text()
          )
            .split('\n')
            .find((line) => line.includes('"type":"response.completed"'))!
            .slice(6)
        ).response
      : await client.createResponses(provider, request, undefined, {}, models);
    expect(response.output[0]).toEqual({ ...capsule, status: 'completed' });
    await client.createResponses(provider, replay(response.output[0]), undefined, {}, models);
    expect(JSON.stringify(history.at(-1))).toContain('opaque-ciphertext');
    expect(JSON.stringify(history.at(-1))).toContain('fc_paired');
    await client.createResponses(
      { ...provider, id: 'account-b' },
      replay(response.output[0]),
      undefined,
      {},
      models
    );
    expect(JSON.stringify(history.at(-1))).not.toContain('opaque-ciphertext');
    expect(JSON.stringify(history.at(-1))).not.toContain('fc_paired');
    await client.createResponses(
      provider,
      { ...replay(response.output[0]), model: 'gpt-other' },
      undefined,
      {},
      models
    );
    expect(JSON.stringify(history.at(-1))).not.toContain('opaque-ciphertext');
  });
});

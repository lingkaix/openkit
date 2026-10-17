import { MAX_WORKER_RAW_OUTPUT_BYTES } from '@openkit/worker-protocol';

/** Trusted source positions before stock parsing, public conversion, or retry discard. */
export interface RawModelOutputPosition {
  readonly partId: number;
  readonly field: 'text' | 'tool-arguments' | 'reasoning';
  readonly fromBytePosition: number;
  readonly bytePosition: number;
}

/** The source cannot prove exact emitted fields; its dependent inference must stop. */
export class RawOutputObservationUnavailableError extends Error {
  constructor() {
    super('Exact Worker raw output observation is unavailable.');
  }
}

/** Observes only provider-native content fields. Opaque reasoning, signatures, usage, tool results and framing never enter accounting. A terminal snapshot advances the same source part instead of becoming another emission. Generated argument objects without their original text are refused rather than reserialized. */
export function createRawProviderOutputObserver(
  api: string,
  observe: (position: RawModelOutputPosition) => void
): (event: unknown) => void {
  if (
    ![
      'openai-completions',
      'openai-responses',
      'openai-codex-responses',
      'azure-openai-responses',
      'anthropic-messages',
      'bedrock-converse-stream',
      'mistral-conversations',
      'google-generative-ai',
      'google-vertex',
      'pi-messages',
    ].includes(api)
  )
    throw new RawOutputObservationUnavailableError();
  const parts = new Map<string, { id: number; text: string; bytes: number; sequence?: number }>();
  const toolParts = new Set<number>();
  let generation = '';
  let nextPartId = 0;
  const setGeneration = (value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 4096)
      throw new RawOutputObservationUnavailableError();
    generation = value;
  };

  const field = (
    identity: unknown[],
    kind: RawModelOutputPosition['field'],
    value: unknown,
    snapshot = false,
    sequence?: number
  ) => {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value))
      throw new RawOutputObservationUnavailableError();
    const key = JSON.stringify([generation, identity, kind]);
    let part = parts.get(key);
    if (!part) {
      if (parts.size >= 4096 || Buffer.byteLength(key, 'utf8') > 8192)
        throw new RawOutputObservationUnavailableError();
      part = { id: nextPartId++, text: '', bytes: 0 };
      parts.set(key, part);
    }
    if (sequence !== undefined && part.sequence !== undefined && sequence <= part.sequence) return;
    if (snapshot && !value.startsWith(part.text)) throw new RawOutputObservationUnavailableError();
    const bytes = Buffer.byteLength(value, 'utf8');
    const position = snapshot ? bytes : part.bytes + bytes;
    observe({
      partId: part.id,
      field: kind,
      fromBytePosition: snapshot ? 0 : part.bytes,
      bytePosition: position,
    });
    // The durable observer refuses overflow first; this local comparison state stays bounded too.
    if (position > MAX_WORKER_RAW_OUTPUT_BYTES) throw new RawOutputObservationUnavailableError();
    part.text = snapshot ? value : part.text + value;
    part.bytes = position;
    if (sequence !== undefined) part.sequence = sequence;
  };

  const responsesItem = (value: unknown, index: number) => {
    const item = record(value);
    if (!item) return;
    if (item.type === 'message') {
      for (const [contentIndex, value] of array(item.content).entries()) {
        const content = record(value);
        if (content?.type === 'output_text' || content?.type === 'text')
          field([index, contentIndex], 'text', content.text, true);
        else if (content?.type === 'refusal')
          field([index, contentIndex], 'text', content.refusal, true);
      }
    } else if (item.type === 'function_call')
      field([index], 'tool-arguments', item.arguments, true);
    else if (item.type === 'custom_tool_call') field([index], 'tool-arguments', item.input, true);
    else if (item.type === 'reasoning') {
      for (const [contentIndex, value] of array(item.summary).entries())
        field([index, contentIndex, 'summary'], 'reasoning', record(value)?.text, true);
      for (const [contentIndex, value] of array(item.content).entries())
        field([index, contentIndex, 'reasoning'], 'reasoning', record(value)?.text, true);
    } else if (item.type === 'tool_search_call' && item.execution === 'client') {
      throw new RawOutputObservationUnavailableError();
    }
  };

  return (value) => {
    const event = record(value);
    if (!event) throw new RawOutputObservationUnavailableError();
    if (api === 'openai-completions' || api === 'mistral-conversations') {
      if (typeof event.id === 'string') setGeneration(event.id);
      for (const choiceValue of array(event.choices)) {
        const choice = record(choiceValue);
        const delta = record(choice?.delta);
        if (!delta) continue;
        if (!generation) throw new RawOutputObservationUnavailableError();
        const choiceIndex = ordinal(choice?.index ?? 0);
        if (typeof delta.content === 'string') field([choiceIndex], 'text', delta.content);
        else
          for (const [index, contentValue] of array(delta.content).entries()) {
            if (typeof contentValue === 'string') {
              field([choiceIndex, index], 'text', contentValue);
              continue;
            }
            const content = record(contentValue);
            if (content?.type === 'text') field([choiceIndex, index], 'text', content.text);
            if (content?.type === 'thinking')
              for (const [partIndex, part] of array(content.thinking).entries())
                field([choiceIndex, index, partIndex], 'reasoning', record(part)?.text);
          }
        for (const name of ['reasoning_content', 'reasoning', 'reasoning_text']) {
          if (typeof delta[name] === 'string' && delta[name]) {
            field([choiceIndex], 'reasoning', delta[name]);
            break;
          }
        }
        for (const toolValue of array(delta.tool_calls ?? delta.toolCalls)) {
          const tool = record(toolValue);
          const index = ordinal(tool?.index ?? 0);
          field(
            [choiceIndex, index],
            'tool-arguments',
            record(tool?.function)?.arguments ?? record(tool?.custom)?.input
          );
        }
        field([choiceIndex, 'refusal'], 'text', delta.refusal);
        field(
          [choiceIndex, 'legacy-function'],
          'tool-arguments',
          record(delta.function_call)?.arguments
        );
      }
      return;
    }
    if (api.includes('responses')) {
      const response = record(event.response);
      if (event.type === 'response.created') setGeneration(response?.id);
      const type = typeof event.type === 'string' ? event.type : '';
      if (
        type === 'response.output_text.delta' ||
        type === 'response.output_text.done' ||
        type === 'response.refusal.delta' ||
        type === 'response.refusal.done' ||
        type === 'response.function_call_arguments.delta' ||
        type === 'response.function_call_arguments.done' ||
        type === 'response.custom_tool_call_input.delta' ||
        type === 'response.custom_tool_call_input.done' ||
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning_summary_text.done' ||
        type === 'response.reasoning_text.delta' ||
        type === 'response.reasoning_text.done'
      ) {
        if (!generation) throw new RawOutputObservationUnavailableError();
        const index = ordinal(event.output_index);
        const snapshot = type.endsWith('.done');
        const sequence =
          event.sequence_number === undefined ? undefined : ordinal(event.sequence_number);
        if (type.includes('output_text') || type.includes('refusal'))
          field(
            [index, ordinal(event.content_index ?? 0)],
            'text',
            snapshot ? (event.text ?? event.refusal) : event.delta,
            snapshot,
            sequence
          );
        else if (type.includes('reasoning'))
          field(
            [
              index,
              ordinal(event.summary_index ?? event.content_index ?? 0),
              type.includes('summary') ? 'summary' : 'reasoning',
            ],
            'reasoning',
            snapshot ? event.text : event.delta,
            snapshot,
            sequence
          );
        else
          field(
            [index],
            'tool-arguments',
            snapshot ? (event.arguments ?? event.input) : event.delta,
            snapshot,
            sequence
          );
      } else if (type === 'response.output_item.done') {
        if (!generation) throw new RawOutputObservationUnavailableError();
        responsesItem(event.item, ordinal(event.output_index));
      } else if (
        type === 'response.completed' ||
        type === 'response.incomplete' ||
        type === 'response.failed'
      ) {
        if (!generation && array(response?.output).length)
          throw new RawOutputObservationUnavailableError();
        for (const [index, item] of array(response?.output).entries()) responsesItem(item, index);
      }
      return;
    }
    if (api === 'anthropic-messages') {
      if (event.type === 'message_start') {
        const message = record(event.message);
        if (typeof message?.id !== 'string') throw new RawOutputObservationUnavailableError();
        setGeneration(message.id);
        toolParts.clear();
      }
      if (event.type === 'content_block_start') {
        if (!generation) throw new RawOutputObservationUnavailableError();
        const index = ordinal(event.index);
        const block = record(event.content_block);
        if (block?.type === 'text') field([index], 'text', block.text, true);
        if (block?.type === 'thinking') field([index], 'reasoning', block.thinking, true);
        if (block?.type === 'tool_use') {
          toolParts.add(index);
          if (Object.keys(record(block.input) ?? {}).length)
            throw new RawOutputObservationUnavailableError();
        }
      }
      if (event.type === 'content_block_delta') {
        if (!generation) throw new RawOutputObservationUnavailableError();
        const delta = record(event.delta);
        const index = ordinal(event.index);
        if (delta?.type === 'text_delta') field([index], 'text', delta.text);
        if (delta?.type === 'thinking_delta') field([index], 'reasoning', delta.thinking);
        if (delta?.type === 'input_json_delta') {
          field([index], 'tool-arguments', delta.partial_json);
          if (typeof delta.partial_json === 'string' && delta.partial_json) toolParts.delete(index);
        }
      }
      if (event.type === 'content_block_stop' && toolParts.has(ordinal(event.index)))
        throw new RawOutputObservationUnavailableError();
      return;
    }
    if (api === 'bedrock-converse-stream') {
      const start = record(event.contentBlockStart);
      if (record(start?.start)?.toolUse) toolParts.add(ordinal(start?.contentBlockIndex));
      const block = record(event.contentBlockDelta);
      const delta = record(block?.delta);
      if (delta) {
        const index = ordinal(block?.contentBlockIndex);
        field([index], 'text', delta.text);
        field([index], 'tool-arguments', record(delta.toolUse)?.input);
        if (typeof record(delta.toolUse)?.input === 'string' && record(delta.toolUse)?.input)
          toolParts.delete(index);
        field([index], 'reasoning', record(delta.reasoningContent)?.text);
      }
      const stop = record(event.contentBlockStop);
      if (stop && toolParts.has(ordinal(stop.contentBlockIndex)))
        throw new RawOutputObservationUnavailableError();
      return;
    }
    if (api === 'google-generative-ai' || api === 'google-vertex') {
      if (typeof event.responseId === 'string') setGeneration(event.responseId);
      for (const [candidateIndex, candidateValue] of array(event.candidates).entries()) {
        for (const [index, partValue] of array(
          record(record(candidateValue)?.content)?.parts
        ).entries()) {
          const part = record(partValue);
          if (part?.functionCall) throw new RawOutputObservationUnavailableError();
          field([candidateIndex, index], part?.thought === true ? 'reasoning' : 'text', part?.text);
        }
      }
      return;
    }
    // pi-messages already carries original field deltas before stock conversion.
    const index = event.contentIndex === undefined ? 0 : ordinal(event.contentIndex);
    if (event.type === 'text_delta') field([index], 'text', event.delta);
    // This API declares redaction only at completion. Do not acknowledge an unproved reasoning delta.
    if (event.type === 'thinking_delta') throw new RawOutputObservationUnavailableError();
    if (event.type === 'toolcall_delta') field([index], 'tool-arguments', event.delta);
    if (
      event.type === 'toolcall_end' &&
      !parts.has(JSON.stringify([generation, [index], 'tool-arguments']))
    )
      throw new RawOutputObservationUnavailableError();
    if (event.type === 'text_end') field([index], 'text', event.content, true);
    if (event.type === 'thinking_end' && event.redacted !== true)
      field([index], 'reasoning', event.content, true);
  };
}

/** Validates a source-owned ordinal without deriving identity from content. */
function ordinal(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new RawOutputObservationUnavailableError();
  return value as number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';

/** Admitted UTF-8 JSON semantic content, without provider configuration or private carriers. */
export type ModelSemanticEvent = Readonly<Record<string, unknown>> & { readonly type: string };

/** Selects outward text and Tool calls; reasoning, signatures, diagnostics and usage are excluded. */
export function admittedModelMessage(message: AssistantMessage): ModelSemanticEvent {
  return {
    type: 'message',
    stopReason: message.stopReason,
    content: message.content.flatMap((block): Record<string, unknown>[] => {
      if (block.type === 'text')
        return [{ type: 'text', text: block.text, ...admittedTextIdentity(block.textSignature) }];
      if (block.type === 'toolCall') {
        return [
          {
            type: 'toolCall',
            id: block.id,
            name: block.name,
            arguments: block.arguments,
            ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
          },
        ];
      }
      return [];
    }),
  };
}

/** Selects only public native message identity and phase, never the private signature carrier. */
function admittedTextIdentity(signature: string | undefined): Record<string, unknown> {
  try {
    const native = JSON.parse(signature ?? '') as Record<string, unknown>;
    return {
      ...(typeof native.id === 'string' ? { id: native.id } : {}),
      ...(native.phase === 'commentary' || native.phase === 'final_answer'
        ? { phase: native.phase }
        : {}),
    };
  } catch {
    return {};
  }
}

/** Selects semantic events before public conversion can defer or discard their admitted content. */
export function admittedModelEvent(event: AssistantMessageEvent): ModelSemanticEvent | null {
  switch (event.type) {
    case 'start':
      return {
        type: 'start',
        ...(event.partial.responseModel ? { reportedModel: event.partial.responseModel } : {}),
      };
    case 'text_start':
    case 'toolcall_start':
      return { type: event.type, contentIndex: event.contentIndex };
    case 'text_delta':
    case 'toolcall_delta':
      return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case 'text_end':
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        content: event.content,
        ...admittedTextIdentity(
          event.partial.content[event.contentIndex]?.type === 'text'
            ? (event.partial.content[event.contentIndex] as { textSignature?: string })
                .textSignature
            : undefined
        ),
      };
    case 'toolcall_end':
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        toolCall: {
          id: event.toolCall.id,
          name: event.toolCall.name,
          arguments: event.toolCall.arguments,
          ...(event.toolCall.namespace === undefined
            ? {}
            : { namespace: event.toolCall.namespace }),
        },
      };
    case 'done':
      return {
        type: 'done',
        message: admittedModelMessage(event.message),
        ...(event.message.responseModel ? { reportedModel: event.message.responseModel } : {}),
      };
    case 'error':
      return {
        type: 'error',
        message: admittedModelMessage(event.error),
        ...(event.error.responseModel ? { reportedModel: event.error.responseModel } : {}),
      };
    default:
      return null;
  }
}

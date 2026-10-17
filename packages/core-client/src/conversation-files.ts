import {
  CONVERSATION_FILE_MEDIA_TYPE,
  MAX_CONVERSATION_FILE_METADATA_BYTES,
  OPERATION_DEFINITIONS,
  operationHttpPath,
  SubmitConversationResponseSchema,
} from '@openkit/app-api-schemas';
import type { z } from 'zod';
import { ProtocolValidationError } from './errors.js';
import type { ClientTransport } from './transport.js';

/** Complete canonical command identity, without original bytes in JSON. */
export type ConversationFileSubmission = z.infer<
  (typeof OPERATION_DEFINITIONS)['conversation.submit']['inputSchema']
>;

/** Streams browser Blobs as ordered Turn originals on the existing operation. */
export interface ConversationFileClient {
  /** Uses the caller's exact inventory and request identity; callers can first reconcile through the ordinary JSON operation. */
  submit(
    input: ConversationFileSubmission,
    files: readonly Blob[]
  ): Promise<z.infer<typeof SubmitConversationResponseSchema>>;
}

/** Builds a Blob from bounded metadata and original Blob parts without buffering their contents. */
export function createConversationFileClient(transport: ClientTransport): ConversationFileClient {
  return {
    submit: (input, files) => {
      const metadata = OPERATION_DEFINITIONS['conversation.submit'].inputSchema.parse(input);
      if (
        !metadata.fileInputs?.length ||
        files.length !== metadata.fileInputs.length ||
        files.some((file, ordinal) => file.size !== metadata.fileInputs![ordinal]!.sizeBytes)
      )
        throw invalidInventory();
      const encoded = new TextEncoder().encode(JSON.stringify(metadata));
      if (encoded.byteLength > MAX_CONVERSATION_FILE_METADATA_BYTES) throw invalidInventory();
      const prefix = new Uint8Array(4);
      new DataView(prefix.buffer).setUint32(0, encoded.byteLength, false);
      return transport.postStream(
        operationHttpPath('conversation.submit'),
        new Blob([prefix, encoded, ...files]),
        {
          'content-type': CONVERSATION_FILE_MEDIA_TYPE,
          'x-openkit-request-id': metadata.requestId,
        },
        SubmitConversationResponseSchema
      );
    },
  };
}

/** Refuses invalid local inventory without exposing names or content. */
function invalidInventory(): ProtocolValidationError {
  return new ProtocolValidationError({
    path: ['fileInputs'],
    code: 'invalid_payload',
    message: 'Conversation file inventory is invalid or too large.',
  });
}

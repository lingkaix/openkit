import { ThreadIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';

/** Decoded audio cap for one composer.transcribe clip. */
export const COMPOSER_TRANSCRIBE_MAX_AUDIO_BYTES = 2_000_000;

/** HTTP JSON body cap for one composer.transcribe request, counted while reading. */
export const COMPOSER_TRANSCRIBE_MAX_BODY_BYTES = 2_700_000;

/** Conservative BCP-47 tag. The server never invents a language. */
const TRANSCRIPTION_LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Credentials already used by llm.gateway.use on the public Workspace surface. */
const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;

/** One clip carried as base64 in the ordinary JSON operation body. */
export const ComposerTranscribeInputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema.optional(),
    audio: z.string().min(1),
    mimeType: z.enum(['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4']),
    language: z.string().regex(TRANSCRIPTION_LANGUAGE).optional(),
  })
  .strict();

/** Transcript text for the composer draft. The operation never sends the draft. */
export const ComposerTranscribeOutputSchema = z
  .object({
    text: z.string(),
  })
  .strict();

/** Composer dictation. Admission reuses llm.gateway.use and optional Thread audience. */
export const COMPOSER_OPERATION_DEFINITIONS = {
  'composer.transcribe': {
    stability: 'release-coupled',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Transcribe one audio clip into text for the composer draft.',
    inputSchema: ComposerTranscribeInputSchema,
    outputSchema: ComposerTranscribeOutputSchema,
    credentials: publicCredentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'optional-addressed-thread', threadField: 'threadId' },
    policyOperation: 'llm.gateway.use',
    mutating: true,
  },
} satisfies Record<string, OperationDefinition>;

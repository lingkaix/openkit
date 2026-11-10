import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';

/** Supervised local backend id. */
export const LocalAiBackendIdSchema = z.enum(['sherpa-onnx-asr', 'llama-cpp', 'apple-native']);

/** Admin-visible lifecycle of one local backend. */
export const LocalAiPhaseSchema = z.enum([
  'disabled',
  'ffmpeg_missing',
  'not_downloaded',
  'downloading',
  'starting',
  'ready',
  'degraded',
  'error',
]);

/** One backend row from local-ai.status. */
export const LocalAiBackendStatusSchema = z
  .object({
    backendId: LocalAiBackendIdSchema,
    enabled: z.boolean(),
    selectedModelId: z.string().min(1).nullable(),
    phase: LocalAiPhaseSchema,
    bytesReceived: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative().nullable(),
    /** License text shown before enable. Present for the speech backend. */
    license: z.string().min(1).optional(),
    /** Pinned download size for this platform. Present when a speech runtime is pinned. */
    downloadBytes: z.number().int().nonnegative().optional(),
    message: z.string().min(1).optional(),
  })
  .strict();

/** Status of every built-in local backend. */
export const LocalAiStatusOutputSchema = z
  .object({
    backends: z.array(LocalAiBackendStatusSchema),
  })
  .strict();

/** Accepted enable. The license must be accepted in this request. */
export const LocalAiEnableInputSchema = z
  .object({
    backendId: LocalAiBackendIdSchema,
    acceptLicense: z.literal(true),
    modelId: z.string().min(1).optional(),
    threads: z.number().int().min(1).max(8).optional(),
  })
  .strict();

/** Stop one backend. Model files are removed only when deleteModels is set. */
export const LocalAiDisableInputSchema = z
  .object({
    backendId: LocalAiBackendIdSchema,
    deleteModels: z.boolean().optional(),
  })
  .strict();

/** Local AI status row. */
export type LocalAiBackendStatus = z.infer<typeof LocalAiBackendStatusSchema>;

/** Local AI status document. */
export type LocalAiStatus = z.infer<typeof LocalAiStatusOutputSchema>;

const serverAdmin = {
  credentials: ['local-user', 'user-session', 'deployment-administrator'],
  scope: { kind: 'server' },
  target: { kind: 'server' },
  policyOperation: 'api.call',
  binding: 'json',
  returnsOneTimeSecret: false,
  successStatus: 200,
} as const;

/** Server-admin lifecycle for the built-in local backends. */
export const LOCAL_AI_OPERATION_DEFINITIONS = {
  'local-ai.status': {
    stability: 'release-coupled',
    ...serverAdmin,
    description: 'Read local speech and local LLM backend status.',
    inputSchema: z.object({}).strict(),
    outputSchema: LocalAiStatusOutputSchema,
    mutating: false,
  },
  'local-ai.enable': {
    stability: 'release-coupled',
    ...serverAdmin,
    description:
      'Accept the model license, download missing speech artifacts, and start the backend.',
    inputSchema: LocalAiEnableInputSchema,
    outputSchema: LocalAiStatusOutputSchema,
    mutating: true,
  },
  'local-ai.disable': {
    stability: 'release-coupled',
    ...serverAdmin,
    description: 'Stop one local backend and drop its published endpoint.',
    inputSchema: LocalAiDisableInputSchema,
    outputSchema: LocalAiStatusOutputSchema,
    mutating: true,
  },
} satisfies Record<string, OperationDefinition>;

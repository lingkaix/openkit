import {
  AppUpdateHostErrorSchema,
  AppUpdateImageDigestSchema,
  AppUpdateRequestIdSchema,
  AppUpdateSourceSchema,
  AppUpdateStatusResponseSchema,
} from '@openkit/app-api-schemas';
import { z } from 'zod';

/** Maximum closed host-helper stdin size. */
export const APP_UPDATE_HOST_STDIN_LIMIT_BYTES = 16 * 1024;

/** Maximum durable helper receipt size. */
export const APP_UPDATE_RECEIPT_LIMIT_BYTES = 64 * 1024;

/** Closed prepare command sent to the installed host helper. */
export const AppUpdateHostPrepareCommandSchema = z
  .object({
    expectedCurrentImageId: AppUpdateImageDigestSchema,
    op: z.literal('prepare'),
    source: AppUpdateSourceSchema,
  })
  .strict();

/** Closed start command sent to the installed host helper. */
export const AppUpdateHostStartCommandSchema = z
  .object({
    maintenanceConsent: z.literal(true),
    op: z.literal('start'),
    requestId: AppUpdateRequestIdSchema,
  })
  .strict();

/** Closed status command sent to the installed host helper. */
export const AppUpdateHostStatusCommandSchema = z
  .object({
    op: z.literal('status'),
    requestId: AppUpdateRequestIdSchema,
  })
  .strict();

/** Closed helper command admitted by the App-key entry. */
export const AppUpdateHostCommandSchema = z.discriminatedUnion('op', [
  AppUpdateHostPrepareCommandSchema,
  AppUpdateHostStartCommandSchema,
  AppUpdateHostStatusCommandSchema,
]);

/** Closed helper command admitted by the App-key entry. */
export type AppUpdateHostCommand = z.infer<typeof AppUpdateHostCommandSchema>;

/**
 * Parses one closed helper command from stdin bytes.
 *
 * @param input Raw stdin bytes.
 * @returns Parsed helper command.
 */
export function parseAppUpdateHostCommand(input: Buffer): AppUpdateHostCommand {
  if (input.byteLength > APP_UPDATE_HOST_STDIN_LIMIT_BYTES) {
    throw new Error('App-update host command exceeds the 16 KiB stdin limit.');
  }

  const parsed = AppUpdateHostCommandSchema.safeParse(JSON.parse(input.toString('utf8')));
  if (!parsed.success) {
    throw new Error('App-update host command is not a closed prepare, start, or status request.');
  }
  return parsed.data;
}

/**
 * Encodes one closed helper command for SSH stdin.
 *
 * @param command Closed helper command.
 * @returns UTF-8 JSON bytes.
 */
export function encodeAppUpdateHostCommand(command: AppUpdateHostCommand): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(AppUpdateHostCommandSchema.parse(command))}\n`);
  if (encoded.byteLength > APP_UPDATE_HOST_STDIN_LIMIT_BYTES) {
    throw new Error('App-update host command exceeds the 16 KiB stdin limit.');
  }
  return encoded;
}

/**
 * Parses helper stdout as either a receipt projection or a coded host error.
 *
 * @param input Raw stdout bytes.
 * @returns Receipt projection or coded error.
 */
export function parseAppUpdateHostOutput(
  input: Buffer
):
  | { ok: true; status: z.infer<typeof AppUpdateStatusResponseSchema> }
  | { ok: false; code: string; message: string } {
  if (input.byteLength > APP_UPDATE_RECEIPT_LIMIT_BYTES) {
    return {
      ok: false,
      code: 'app_update_recovery_required',
      message: 'App-update host output exceeds the 64 KiB receipt limit.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.toString('utf8'));
  } catch {
    return {
      ok: false,
      code: 'app_update_unavailable',
      message: 'App-update host output could not be read.',
    };
  }

  const error = AppUpdateHostErrorSchema.safeParse(parsed);
  if (error.success) {
    return { ok: false, code: error.data.error.code, message: error.data.error.message };
  }

  const status = AppUpdateStatusResponseSchema.safeParse(parsed);
  if (!status.success) {
    return {
      ok: false,
      code: 'app_update_recovery_required',
      message: 'App-update host output is not a valid receipt projection.',
    };
  }
  return { ok: true, status: status.data };
}

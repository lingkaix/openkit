import { z } from 'zod';

/** Existing worker-control carriage ceiling, including the complete private JSON envelope. */
export const WORKER_CREDENTIAL_HELPER_BODY_MAX_BYTES = 1024 * 1024;
/** Native process output and SSH payload ceiling, independent of the JSON envelope overhead. */
export const WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES = 65_536;

const boundedText = z.string().max(WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES);
const nonemptyText = boundedText.min(1);
const binaryText = z
  .string()
  .max(4 * Math.ceil(WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES / 3))
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

/**
 * Closed private helper command. The admitted AEP, not these native selectors, supplies authority.
 * Store/erase are local no-cache process semantics and cannot mutate Core credentials here.
 */
export const WorkerCredentialHelperCommandSchema = z.discriminatedUnion('protocol', [
  z
    .object({
      protocol: z.literal('git'),
      operation: z.literal('get'),
      attributes: z
        .object({ protocol: nonemptyText, host: nonemptyText, path: boundedText.optional() })
        .strict(),
    })
    .strict(),
  z
    .object({ protocol: z.literal('docker'), operation: z.literal('get'), target: nonemptyText })
    .strict(),
  z.object({ protocol: z.literal('aws'), operation: z.literal('get') }).strict(),
  z
    .object({
      protocol: z.literal('kubernetes'),
      operation: z.literal('get'),
      apiVersion: z.enum([
        'client.authentication.k8s.io/v1',
        'client.authentication.k8s.io/v1beta1',
      ]),
      interactive: z.boolean(),
    })
    .strict(),
  z
    .object({
      protocol: z.literal('google'),
      operation: z.literal('get'),
      audience: nonemptyText,
      subjectTokenType: z.enum([
        'urn:ietf:params:oauth:token-type:id_token',
        'urn:ietf:params:oauth:token-type:jwt',
        'urn:ietf:params:oauth:token-type:saml2',
      ]),
    })
    .strict(),
  z.discriminatedUnion('operation', [
    z.object({ protocol: z.literal('ssh-agent'), operation: z.literal('identities') }).strict(),
    z
      .object({
        protocol: z.literal('ssh-agent'),
        operation: z.literal('sign'),
        keyBlob: binaryText.min(1),
        data: binaryText,
        flags: z.union([z.literal(0), z.literal(2), z.literal(4)]),
      })
      .strict(),
  ]),
]);

/** Validated command on the one on-demand helper carriage. */
export type WorkerCredentialHelperCommand = z.infer<typeof WorkerCredentialHelperCommandSchema>;

const completedUse = {
  receiptId: z.string().min(1),
  materialGeneration: z.number().int().positive(),
};

/**
 * Private completed-use reply, never a uniform operation result or retained record.
 * Credential objects are opaque here; the Vault consumer and native codec validate their formats.
 */
export const WorkerCredentialHelperReplySchema = z.union([
  z.object({ ...completedUse, credential: z.record(z.string(), z.unknown()) }).strict(),
  z
    .object({
      ...completedUse,
      identities: z.array(z.object({ keyBlob: binaryText.min(1), comment: boundedText }).strict()),
    })
    .strict(),
  z.object({ ...completedUse, signature: binaryText.min(1) }).strict(),
]);

/** Private material/public-identity/signature response released only after governed completion. */
export type WorkerCredentialHelperReply = z.infer<typeof WorkerCredentialHelperReplySchema>;

import { Buffer } from 'node:buffer';
import { createHash, createPrivateKey, createPublicKey, sign, timingSafeEqual } from 'node:crypto';
import type {
  AgentEnvironmentCredentialDeclaration,
  AgentEnvironmentPackage,
} from '@openkit/config-schema';
import {
  WORKER_CREDENTIAL_HELPER_BODY_MAX_BYTES,
  WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES,
  type WorkerCredentialHelperCommand,
  type WorkerCredentialHelperReply,
  WorkerCredentialHelperReplySchema,
} from '@openkit/worker-protocol';
import { z } from 'zod';
import { OperationError } from '../operation-error.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type {
  VaultGrantRecord,
  VaultInjectionReceiptRecord,
  VaultReferenceRecord,
} from '../storage/vault-native-codecs.js';
import type { VaultBackend } from './vault-backend.js';
import { createVaultUseAuditedBackend } from './vault-use-audited-backend.js';

/** Authorized inputs supplied by the existing governed binding operation, not the Worker body. */
export interface CredentialHelperUseEffectInput {
  readonly coreDb: CoreDb;
  readonly db: WorkspaceDb;
  readonly packageSnapshot: AgentEnvironmentPackage;
  readonly declaration: AgentEnvironmentCredentialDeclaration;
  readonly grant: VaultGrantRecord;
  readonly reference: VaultReferenceRecord;
  readonly planId: string;
  readonly receiptId: string;
  readonly materialVersion: number;
  readonly recheckAuthority: () => Promise<void>;
}

/** A single request-local effect; its operation result contains receipt metadata only. */
export interface GovernedCredentialHelperUse {
  readonly declarationId: string;
  readonly command: WorkerCredentialHelperCommand;
  readonly run: (input: CredentialHelperUseEffectInput) => Promise<VaultInjectionReceiptRecord>;
}

const text = z.string().min(1).max(WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES);
const timestamp = z.string().datetime({ offset: true });
const gitCredential = z.object({
  username: z.string().optional(),
  password: z.string().optional(),
});
const dockerCredential = z.object({ Username: text, Secret: text });
const awsCredential = z.object({
  Version: z.literal(1),
  AccessKeyId: text,
  SecretAccessKey: text,
  SessionToken: text.optional(),
  Expiration: timestamp.optional(),
});
const kubeCredential = z.object({
  apiVersion: z.string(),
  kind: z.literal('ExecCredential'),
  status: z
    .object({
      token: text.optional(),
      clientCertificateData: text.optional(),
      clientKeyData: text.optional(),
      expirationTimestamp: timestamp.optional(),
    })
    .superRefine((value, ctx) => {
      if (
        (!value.token && !value.clientCertificateData) ||
        (value.clientCertificateData !== undefined) !== (value.clientKeyData !== undefined)
      )
        ctx.addIssue({ code: 'custom', message: 'Credential fields are incomplete.' });
    }),
});
const googleCredential = z.discriminatedUnion('token_type', [
  z.object({
    version: z.literal(1),
    success: z.literal(true),
    token_type: z.enum([
      'urn:ietf:params:oauth:token-type:id_token',
      'urn:ietf:params:oauth:token-type:jwt',
    ]),
    id_token: text,
    expiration_time: z.number().int().nonnegative().optional(),
  }),
  z.object({
    version: z.literal(1),
    success: z.literal(true),
    token_type: z.literal('urn:ietf:params:oauth:token-type:saml2'),
    saml_response: text,
    expiration_time: z.number().int().nonnegative().optional(),
  }),
]);

/** Closed refusal: parser, backend and crypto diagnostics must never become helper output. */
function unavailable(): never {
  throw new OperationError('credential_helper_unavailable', 'Credential unavailable.', 409);
}

/** Decode only canonical base64 supplied by the closed private command schema. */
function binary(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.toString('base64') !== value ||
    bytes.length > WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES
  )
    unavailable();
  return bytes;
}

/** Interpret the public key selector and admitted flags without reading any private material. */
function signingInput(command: Extract<WorkerCredentialHelperCommand, { operation: 'sign' }>) {
  const key = binary(command.keyBlob);
  const data = binary(command.data);
  if (key.length < 4 || key.length + data.length + 13 > WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES)
    unavailable();
  const length = key.readUInt32BE(0);
  if (length > key.length - 4) unavailable();
  const type = key.subarray(4, 4 + length).toString('ascii');
  const algorithm =
    type === 'ssh-ed25519' && command.flags === 0
      ? 'ssh-ed25519'
      : type === 'ssh-rsa' && command.flags === 2
        ? 'rsa-sha2-256'
        : type === 'ssh-rsa' && command.flags === 4
          ? 'rsa-sha2-512'
          : unavailable();
  return { key, data, algorithm };
}

/** Non-secret exact request facts for the existing operation Policy insertion point. */
export function credentialHelperRequestFacts(
  command: WorkerCredentialHelperCommand
): Record<string, unknown> {
  if (command.protocol === 'ssh-agent' && command.operation === 'sign') {
    const value = signingInput(command);
    return {
      protocol: command.protocol,
      operation: command.operation,
      keyFingerprint: `sha256:${createHash('sha256').update(value.key).digest('hex')}`,
      algorithm: value.algorithm,
      dataDigest: `sha256:${createHash('sha256').update(value.data).digest('hex')}`,
      dataBytes: value.data.length,
    };
  }
  return {
    protocol: command.protocol,
    operation: command.operation,
  };
}

/** Check native selectors against the exact immutable target, never against another reference. */
export function assertCredentialHelperTarget(
  declaration: AgentEnvironmentCredentialDeclaration,
  command: WorkerCredentialHelperCommand
): void {
  if (declaration.visibility === 'external-handle' && declaration.consumer === 'ssh-agent') {
    if (command.protocol !== 'ssh-agent') unavailable();
    credentialHelperRequestFacts(command);
    return;
  }
  if (
    declaration.visibility !== 'runtime-token' ||
    declaration.consumer !== 'credential-helper' ||
    command.protocol === 'ssh-agent' ||
    declaration.helper.protocol !== command.protocol
  )
    unavailable();
  const target = declaration.helper;
  if (target.protocol === 'git' && command.protocol === 'git') {
    if (
      command.attributes.protocol !== target.scheme ||
      command.attributes.host !== target.host ||
      (target.path !== undefined && command.attributes.path !== target.path)
    )
      unavailable();
  } else if (target.protocol === 'docker' && command.protocol === 'docker') {
    if (command.target !== target.serverUrl) unavailable();
  } else if (target.protocol === 'kubernetes' && command.protocol === 'kubernetes') {
    if (command.apiVersion !== target.apiVersion) unavailable();
  } else if (target.protocol === 'google' && command.protocol === 'google') {
    if (
      command.audience !== target.audience ||
      command.subjectTokenType !== target.subjectTokenType
    )
      unavailable();
  }
}

/** Earliest known expiration only; absence stays absent and expired material is never returned. */
function expiry(
  grantExpiry: string | null,
  materialExpiry: string | undefined,
  now: string
): string | null {
  const values = [grantExpiry, materialExpiry].filter((value): value is string => value != null);
  let earliest: number | undefined;
  for (const value of values) {
    if (!timestamp.safeParse(value).success) unavailable();
    const instant = Date.parse(value);
    if (!Number.isFinite(instant) || instant <= Date.parse(now)) unavailable();
    earliest = earliest === undefined ? instant : Math.min(earliest, instant);
  }
  return earliest === undefined ? null : new Date(earliest).toISOString();
}

/** Parse and allowlist native process output before issuing a governed response. */
function processCredential(
  material: string,
  command: Exclude<WorkerCredentialHelperCommand, { protocol: 'ssh-agent' }>,
  grantExpiry: string | null,
  now: string
): { credential: Record<string, unknown>; expiresAt: string | null } {
  const raw: unknown = JSON.parse(material);
  let credential: Record<string, unknown>;
  let expiresAt = expiry(grantExpiry, undefined, now);
  switch (command.protocol) {
    case 'git': {
      const parsed = gitCredential.parse(raw);
      if (Object.values(parsed).some((value) => value !== undefined && /[\0\r\n]/.test(value)))
        unavailable();
      const output = `${Object.entries(parsed)
        .map(([key, value]) => `${key}=${value}\n`)
        .join('')}\n`;
      if (Buffer.byteLength(output) > WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES) unavailable();
      return { credential: parsed, expiresAt };
    }
    case 'docker':
      credential = dockerCredential.parse(raw);
      break;
    case 'aws': {
      const parsed = awsCredential.parse(raw);
      expiresAt = expiry(grantExpiry, parsed.Expiration, now);
      credential = { ...parsed, ...(expiresAt ? { Expiration: expiresAt } : {}) };
      break;
    }
    case 'kubernetes': {
      const parsed = kubeCredential.parse(raw);
      if (parsed.apiVersion !== command.apiVersion) unavailable();
      expiresAt = expiry(grantExpiry, parsed.status.expirationTimestamp, now);
      credential = {
        ...parsed,
        status: { ...parsed.status, ...(expiresAt ? { expirationTimestamp: expiresAt } : {}) },
      };
      break;
    }
    case 'google': {
      const parsed = googleCredential.parse(raw);
      if (parsed.token_type !== command.subjectTokenType) unavailable();
      const materialExpiry =
        parsed.expiration_time === undefined
          ? undefined
          : new Date(parsed.expiration_time * 1000).toISOString();
      expiresAt = expiry(grantExpiry, materialExpiry, now);
      const seconds = expiresAt === null ? undefined : Math.floor(Date.parse(expiresAt) / 1000);
      if (seconds !== undefined && seconds <= Math.floor(Date.parse(now) / 1000)) unavailable();
      credential = { ...parsed, ...(seconds === undefined ? {} : { expiration_time: seconds }) };
      break;
    }
  }
  if (
    Buffer.byteLength(`${JSON.stringify(credential)}\n`) > WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES
  )
    unavailable();
  return { credential, expiresAt };
}

/** Encode an SSH string; only bounded public keys or signatures reach this encoder. */
function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** Derive the native public key from the actual Core-held private key, never a caller hint. */
function publicKeyBlob(key: ReturnType<typeof createPrivateKey>): Buffer {
  const publicKey = createPublicKey(key).export({ format: 'jwk' });
  if (key.asymmetricKeyType === 'ed25519' && publicKey.x)
    return Buffer.concat([
      sshString('ssh-ed25519'),
      sshString(Buffer.from(publicKey.x, 'base64url')),
    ]);
  if (key.asymmetricKeyType === 'rsa' && publicKey.e && publicKey.n) {
    const mpint = (value: string) => {
      const bytes = Buffer.from(value, 'base64url');
      return sshString(bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
    };
    return Buffer.concat([sshString('ssh-rsa'), mpint(publicKey.e), mpint(publicKey.n)]);
  }
  return unavailable();
}

/**
 * Resolve once under the existing Vault Use/Audit owner, perform the private effect, then publish its receipt.
 * The caller must invoke this only inside the standard governed Vault binding operation.
 * @param input The operation's authenticated package, selected grant/reference and currentness check.
 * @param backend Actual app-owned unlocked Vault backend, with no request-local credential cache.
 * @param command Exact already-matched native request.
 * @returns Private reply and reference-only receipt; no key material crosses the operation result surface.
 */
export async function performCredentialHelperUse(
  input: CredentialHelperUseEffectInput,
  backend: VaultBackend,
  command: WorkerCredentialHelperCommand
): Promise<{ receipt: VaultInjectionReceiptRecord; reply: WorkerCredentialHelperReply }> {
  try {
    assertCredentialHelperTarget(input.declaration, command);
    const ownerScope = input.grant.ownerScope;
    if (ownerScope !== 'workspace' && ownerScope !== 'server') unavailable();
    if (
      input.reference.backendKind !== backend.kind ||
      input.reference.currentVersion !== input.materialVersion
    )
      unavailable();
    await input.recheckAuthority();
    const material = await createVaultUseAuditedBackend({
      backend,
      db: ownerScope === 'workspace' ? input.db : input.coreDb,
      ownerScope,
      ...(ownerScope === 'workspace'
        ? { workspaceId: input.packageSnapshot.scope.workspaceId! }
        : {}),
      consumerWorkspaceId: input.packageSnapshot.scope.workspaceId!,
      actor: input.packageSnapshot.scope.triggerActor,
      grantId: input.grant.grantId,
      planId: input.planId,
      receiptId: input.receiptId,
      agentSessionId: input.packageSnapshot.scope.agentSessionId,
      resolvingPath: 'plan',
    }).resolve({ referenceId: input.reference.referenceId, version: input.materialVersion });
    await input.recheckAuthority();
    const value =
      typeof material === 'string'
        ? material
        : new TextDecoder('utf-8', { fatal: true }).decode(material);
    if (
      Buffer.byteLength(value) >
      (command.protocol === 'ssh-agent'
        ? WORKER_CREDENTIAL_HELPER_NATIVE_MAX_BYTES
        : WORKER_CREDENTIAL_HELPER_BODY_MAX_BYTES)
    )
      unavailable();
    const now = new Date().toISOString();
    let expiresAt = expiry(input.grant.expiresAt, undefined, now);
    let reply: WorkerCredentialHelperReply;
    const completed = { receiptId: input.receiptId, materialGeneration: input.materialVersion };
    if (command.protocol === 'ssh-agent') {
      // KeyObject and PEM are request-local and never retained, returned or cached.
      const key = createPrivateKey(value);
      const publicBlob = publicKeyBlob(key);
      if (command.operation === 'identities') {
        reply = {
          ...completed,
          identities: [
            { keyBlob: publicBlob.toString('base64'), comment: input.reference.displayName },
          ],
        };
      } else {
        const request = signingInput(command);
        if (publicBlob.length !== request.key.length || !timingSafeEqual(publicBlob, request.key))
          unavailable();
        const signature = sign(
          request.algorithm === 'ssh-ed25519'
            ? null
            : request.algorithm === 'rsa-sha2-256'
              ? 'sha256'
              : 'sha512',
          request.data,
          key
        );
        reply = {
          ...completed,
          signature: Buffer.concat([sshString(request.algorithm), sshString(signature)]).toString(
            'base64'
          ),
        };
      }
    } else {
      const result = processCredential(value, command, input.grant.expiresAt, now);
      expiresAt = result.expiresAt;
      reply = { ...completed, credential: result.credential };
    }
    const validated = WorkerCredentialHelperReplySchema.parse(reply);
    if (Buffer.byteLength(JSON.stringify(validated)) > WORKER_CREDENTIAL_HELPER_BODY_MAX_BYTES)
      unavailable();
    await input.recheckAuthority();
    const receipt = await getControlStoreWorkerClient().vault(input.coreDb, 'receipt-create', {
      receiptId: input.receiptId,
      planId: input.planId,
      grantId: input.grant.grantId,
      agentSessionId: input.packageSnapshot.scope.agentSessionId,
      backendSummary: `credential-helper:${command.protocol}:${command.operation}-produced`,
      injectedAt: new Date().toISOString(),
      expiresAt,
      revocationStatus: 'active',
      workerAuthority: {
        consumer: {
          scope: input.packageSnapshot.scope,
          snapshotId: input.packageSnapshot.snapshotId,
          agent: { agentId: input.packageSnapshot.agent.agentId },
        },
        declarations: [input.declaration],
      },
    });
    await input.recheckAuthority();
    return { receipt, reply: validated };
  } catch {
    return unavailable();
  }
}

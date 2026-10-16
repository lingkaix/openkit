import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

import { HARNESS_DEFAULT_MAX_ACTIVE_TURNS } from '@openkit/worker-protocol';
import { z } from 'zod';
import { AuthoredConfigRequiredFeaturesSchema } from './schema-evolution.js';

/** Exact HTTP or HTTPS origin accepted by browser-facing server configuration. */
const HttpOriginSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  }, 'Expected an exact HTTP or HTTPS origin.');

/**
 * Core deployment mode loaded from server config.
 */
export const CoreModeSchema = z.enum(['local', 'server']);

/**
 * Core deployment mode.
 */
export type CoreMode = z.infer<typeof CoreModeSchema>;

/**
 * Operator defaults loaded from OpenKit server config.
 */
export const OpenKitConfigDefaultsSchema = z
  .object({
    defaultAgentId: z.string().min(1).optional(),
  })
  .strict();

/**
 * HTTP bind configuration for the NanoCore server.
 */
export const OpenKitServerBindSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
  })
  .strict();

/**
 * CORS configuration for the NanoCore server.
 */
export const OpenKitCorsSchema = z
  .object({
    origins: z.array(HttpOriginSchema).optional(),
  })
  .strict();

/**
 * Public server networking configuration.
 */
export const OpenKitServerRuntimeSchema = z
  .object({
    /** Free Data Root capacity retained after all admitted pending file writes; default 1,000,000,000 bytes. */
    fileReserveBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    bind: OpenKitServerBindSchema.optional(),
    cors: OpenKitCorsSchema.optional(),
    publicBaseUrl: HttpOriginSchema.optional(),
  })
  .strict();

/**
 * Auth sign-up policy configuration.
 */
export const OpenKitAuthSignupSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

/**
 * Server auth configuration.
 */
export const OpenKitAuthConfigSchema = z
  .object({
    signup: OpenKitAuthSignupSchema.optional(),
  })
  .strict();

/**
 * Vault backend selection configuration.
 */
export const OpenKitVaultConfigSchema = z
  .object({
    encryptedFile: z
      .object({
        keyFilePath: z.string().min(1).refine(isAbsolute, 'Vault key file path must be absolute.'),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Fixed file-backed credential paths for one configured NanoHost slot. */
export const OpenKitNanoHostCredentialSlotSchema = z
  .object({
    companionPath: z.string().min(1).refine(isAbsolute, 'Companion path must be absolute.'),
    secretPath: z.string().min(1).refine(isAbsolute, 'Secret path must be absolute.'),
  })
  .strict()
  .refine(
    (value) => value.companionPath !== value.secretPath,
    'NanoHost credential secret and companion paths must be distinct.'
  );

/** Dedicated native HTTP/2 listener bind for one configured NanoHost. */
export const OpenKitNanoHostBindSchema = z
  .object({
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65_535),
  })
  .strict();

const RawSecretPattern =
  /(^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]+|hf_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|okt_[A-Za-z0-9_-]+)/;

/**
 * Rejects raw-secret-shaped strings in NanoHost deployment configuration.
 *
 * @param value Candidate value.
 * @param ctx Zod refinement context.
 * @param path Path to the value.
 */
function addRawSecretIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number>
): void {
  if (typeof value === 'string') {
    if (RawSecretPattern.test(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'NanoHost deployment configuration must not contain raw-secret-shaped strings.',
        path,
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      addRawSecretIssues(item, ctx, [...path, index]);
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      addRawSecretIssues(item, ctx, [...path, key]);
    }
  }
}

/** Default aggregate active-Turn bound for one shared Sandbox. */
export const NANO_HOST_DEFAULT_MAX_ACTIVE_TURNS = HARNESS_DEFAULT_MAX_ACTIVE_TURNS;

/**
 * Secret-free NanoHost deployment projection loaded from server config.
 *
 * Carries exactly one configured NanoHost identity, NanoCore rendezvous endpoint,
 * and non-secret credential reference. Raw `okt_` material, Cell topology keys,
 * and unknown fields are rejected.
 */
export const OpenKitNanoHostConfigSchema = z
  .object({
    bind: OpenKitNanoHostBindSchema,
    credentialRef: z.string().min(1),
    credentialSlots: z
      .object({
        A: OpenKitNanoHostCredentialSlotSchema,
        B: OpenKitNanoHostCredentialSlotSchema,
      })
      .strict(),
    deploymentId: z.string().min(1),
    identityId: z.string().min(1),
    /** Positive backend-private Sandbox bound; omission uses the current default. */
    maxActiveTurnsPerSandbox: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    rendezvousUrl: HttpOriginSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
    const paths = [
      value.credentialSlots.A.secretPath,
      value.credentialSlots.A.companionPath,
      value.credentialSlots.B.secretPath,
      value.credentialSlots.B.companionPath,
    ];
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'NanoHost credential slot paths must be distinct.',
        path: ['credentialSlots'],
      });
    }
  });

/**
 * Restricted SSH identity used by NanoCore to invoke the installed App-update helper.
 *
 * Request data cannot choose the helper command, repository, Docker socket, or target path.
 * The identity and known-hosts files are absolute host paths mounted as protected secrets.
 */
export const OpenKitAppUpdateConfigSchema = z
  .object({
    host: z.string().trim().min(1),
    identityFile: z
      .string()
      .min(1)
      .refine(isAbsolute, 'App-update identity file path must be absolute.'),
    knownHostsFile: z
      .string()
      .min(1)
      .refine(isAbsolute, 'App-update known-hosts file path must be absolute.'),
    port: z.number().int().min(1).max(65_535),
    user: z.string().trim().min(1),
  })
  .strict()
  .refine(
    (value) => value.identityFile !== value.knownHostsFile,
    'App-update identity and known-hosts paths must be distinct.'
  )
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** One exact repository path; glob and URL aliases cannot enlarge maintenance authority. */
const MaintenanceRepositoryPathSchema = z
  .string()
  .refine(
    (value) =>
      /^\/(?:[A-Za-z0-9_~.-]+\/)*[A-Za-z0-9_~.-]+$/.test(value) &&
      value.split('/').every((segment) => segment !== '.' && segment !== '..'),
    'Expected a canonical exact repository path.'
  );

/** Finite Server-owned authority for a registered Worker's Git-read rule correction. */
export const WorkerGitReadMaintenanceAssignmentSchema = z
  .object({
    responsibleUserId: z.string().min(1),
    agentId: z.string().min(1),
    networkGrantId: z.string().min(1),
    host: z.string().refine((value) => {
      try {
        if (
          !value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) &&
          !(value.startsWith('[') && value.endsWith(']') && isIP(value.slice(1, -1)) === 6)
        )
          return false;
        const url = new URL(`https://${value}`);
        return (
          url.hostname === value &&
          url.host === value &&
          url.pathname === '/' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, 'Expected an exact canonical host.'),
    port: z.number().int().min(1).max(65_535),
    protocol: z.literal('rest'),
    repositoryPaths: z
      .array(MaintenanceRepositoryPathSchema)
      .min(1)
      .refine(
        (values) => new Set(values).size === values.length,
        'Repository paths must be unique.'
      ),
    binaries: z
      .array(
        z
          .string()
          .refine(
            (value) =>
              isAbsolute(value) &&
              [...value].every(
                (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
              ) &&
              !value.split('/').some((segment) => segment === '.' || segment === '..') &&
              !value.includes('//') &&
              !value.endsWith('/'),
            'Expected a canonical absolute binary path.'
          )
      )
      .min(1)
      .refine((values) => new Set(values).size === values.length, 'Binaries must be unique.'),
    validFrom: z.iso.datetime({ precision: 3 }),
    expiresAt: z.iso.datetime({ precision: 3 }),
    enabled: z.boolean(),
  })
  .strict()
  .refine((value) => Date.parse(value.validFrom) < Date.parse(value.expiresAt), {
    message: 'Maintenance validity must be a nonempty finite interval.',
    path: ['expiresAt'],
  });

/** Authored finite assignment; runtime admission must also evaluate current authority. */
export type WorkerGitReadMaintenanceAssignment = z.infer<
  typeof WorkerGitReadMaintenanceAssignmentSchema
>;

/** File-backed NanoCore configuration schema. */
export const OpenKitConfigSchema = z
  .object({
    appUpdate: OpenKitAppUpdateConfigSchema.optional(),
    auth: OpenKitAuthConfigSchema.optional(),
    defaults: OpenKitConfigDefaultsSchema.optional(),
    mode: CoreModeSchema.optional(),
    policy: z
      .object({
        workerGitReadMaintenance: z
          .array(WorkerGitReadMaintenanceAssignmentSchema)
          .refine(
            (entries) =>
              new Set(
                entries.map((entry) =>
                  JSON.stringify([entry.responsibleUserId, entry.agentId, entry.networkGrantId])
                )
              ).size === entries.length,
            'Maintenance assignments must have unique responsible-user, Agent and grant tuples.'
          )
          .optional(),
        workDataCapture: z
          .object({
            value: z.enum(['off', 'on']).default('off'),
          })
          .strict()
          .optional(),
        workspaceApprovalModes: z
          .record(
            z.string().min(1),
            z
              .object({
                'repo.push': z.enum(['require_human_approval', 'auto_allow']).optional(),
              })
              .strict()
          )
          .optional(),
      })
      .strict()
      .optional(),
    nanohost: OpenKitNanoHostConfigSchema.optional(),
    requiredFeatures: AuthoredConfigRequiredFeaturesSchema.optional(),
    schemaVersion: z.literal(1).optional(),
    server: OpenKitServerRuntimeSchema.optional(),
    vault: OpenKitVaultConfigSchema.optional(),
  })
  .strip();

/**
 * File-backed NanoCore configuration.
 */
export type OpenKitConfig = z.infer<typeof OpenKitConfigSchema>;

/**
 * Restricted SSH identity for the installed App-update helper.
 */
export type OpenKitAppUpdateConfig = z.infer<typeof OpenKitAppUpdateConfigSchema>;

/**
 * Secret-free NanoHost deployment projection.
 */
export type OpenKitNanoHostConfig = z.infer<typeof OpenKitNanoHostConfigSchema>;

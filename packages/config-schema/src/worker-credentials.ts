import { VaultReferenceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Canonical Worker credential target shared by authored and admitted declarations. */
export const WORKER_RUNTIME_CREDENTIAL_FILE_PATH_SCHEMA = z
  .string()
  .min(1)
  .startsWith('/sandbox/')
  .refine(
    (path) =>
      path.length <= 4096 &&
      !path.includes('\\') &&
      !Array.from(path).some(
        (character) =>
          character.charCodeAt(0) < 32 ||
          (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)
      ) &&
      !path
        .split('/')
        .slice(1)
        .some((part) => part === '' || part === '.' || part === '..'),
    'Runtime credential file paths must be canonical and cannot traverse parents.'
  )
  .refine(
    (path) => path !== '/sandbox/openkit' && !path.startsWith('/sandbox/openkit/'),
    'Runtime credential files cannot target OpenKit-managed sandbox paths.'
  );
/** Required or realized credential protection, independent of the execution placement. */
export const WorkerCredentialProtectionSchema = z
  .object({
    ephemeral: z.literal(true),
    outsideRetainedStorage: z.literal(true),
    excludedFromCapture: z.literal(true),
    excludedFromExport: z.literal(true),
  })
  .strict();

/** Fixed minimum for a static Worker file; adapters may not weaken it. */
export const WORKER_CREDENTIAL_FILE_REQUIREMENT = Object.freeze({
  format: 'utf8' as const,
  access: 'read-only' as const,
  requiredProtection: Object.freeze({
    ephemeral: true as const,
    outsideRetainedStorage: true as const,
    excludedFromCapture: true as const,
    excludedFromExport: true as const,
  }),
});

/** Reference-only file supply. Secret material travels through the private supply owner. */
export const WorkerCredentialFileBindingSchema = z
  .object({
    declarationId: z.string().min(1).max(4096),
    planId: z.string().min(1).max(4096),
    receiptId: z.string().min(1).max(4096),
    material: z
      .object({
        referenceId: VaultReferenceIdSchema,
        version: z.number().int().positive().safe(),
        format: z.literal('utf8'),
      })
      .strict(),
    target: z
      .object({ kind: z.literal('file'), path: WORKER_RUNTIME_CREDENTIAL_FILE_PATH_SCHEMA })
      .strict(),
    access: z.literal('read-only'),
    requiredProtection: WorkerCredentialProtectionSchema,
  })
  .strict();

/** Placement-neutral file supply inferred from the canonical schema. */
export type WorkerCredentialFileBinding = z.infer<typeof WorkerCredentialFileBindingSchema>;

/** A realized placement receipt carries only exact reference lineage and protection. */
export const WorkerCredentialReceiptSchema = z
  .object({
    declarationId: WorkerCredentialFileBindingSchema.shape.declarationId,
    planId: WorkerCredentialFileBindingSchema.shape.planId,
    receiptId: WorkerCredentialFileBindingSchema.shape.receiptId,
    materialVersion: z.number().int().positive().safe(),
    access: z.literal('read-only'),
    realizedProtection: WorkerCredentialProtectionSchema,
  })
  .strict();
/** Realized protection proof inferred from the canonical schema. */
export type WorkerCredentialReceipt = z.infer<typeof WorkerCredentialReceiptSchema>;

/** Placement-neutral admitted supply, used by the existing execution backend port. */
export const WorkerCredentialBindingsSchema = z
  .array(WorkerCredentialFileBindingSchema)
  .max(32)
  .superRefine((bindings, context) => {
    const declarations = new Set<string>();
    const plans = new Set<string>();
    const receipts = new Set<string>();
    const targets: string[] = [];
    for (const binding of bindings) {
      if (
        [binding.declarationId, binding.planId, binding.receiptId].some((identity) =>
          Array.from(identity).some(
            (character) =>
              character.charCodeAt(0) < 32 ||
              (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)
          )
        ) ||
        declarations.has(binding.declarationId) ||
        plans.has(binding.planId) ||
        receipts.has(binding.receiptId) ||
        targets.some(
          (target) =>
            target === binding.target.path ||
            target.startsWith(`${binding.target.path}/`) ||
            binding.target.path.startsWith(`${target}/`)
        )
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Credential bindings require unique identities and nonoverlapping canonical targets.',
        });
      }
      declarations.add(binding.declarationId);
      plans.add(binding.planId);
      receipts.add(binding.receiptId);
      targets.push(binding.target.path);
    }
  });

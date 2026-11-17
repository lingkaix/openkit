import {
  BLOCKED_DELEGATED_REFRESH_STRATEGIES,
  type DelegatedRefreshIntent,
  type GatewayConfig,
  StaticProviderAccessShapeSchema,
} from '@openkit/config-schema';
import { OperationError } from '../operation-error.js';
import {
  type VaultReferenceRecord,
  vaultCredentialWriterOf,
} from '../storage/vault-native-codecs.js';

/**
 * Refuses a Core-side material rotation while a Gateway placement holds the refresh family.
 * A fenced holder cannot write back, so a new root version is the accepted exit. This is a
 * pre-check before backend material is written; the native version CAS remains authoritative.
 *
 * @param reference Current canonical Vault reference.
 * @throws OperationError `credential_family_busy` while delegation is pending or active.
 */
export function assertCoreMayRotateCredentialFamily(reference: VaultReferenceRecord): void {
  const writer = vaultCredentialWriterOf(reference);
  if (writer.mode !== 'core' && writer.state !== 'fenced') throw credentialFamilyBusy();
}

/**
 * Refuses a new delegation unless Core is the current, unfenced writer of the family.
 *
 * @param reference Current canonical Vault reference.
 * @throws OperationError `credential_family_busy` for every non-Core writer state.
 */
export function assertCoreMayDelegateCredentialFamily(reference: VaultReferenceRecord): void {
  if (vaultCredentialWriterOf(reference).mode !== 'core') throw credentialFamilyBusy();
}

/**
 * Reads the configured refresh intent of one Provider access shape. Absent or ambiguous
 * configuration yields undefined; the existing static path then refuses independently.
 *
 * @param configuration Current Gateway configuration.
 * @param profileId Access-shape id named by the admitted declaration.
 * @returns The exact configured shape and its refresh intent, when one is declared.
 */
export function readDelegatedRefreshShape(
  configuration: Pick<GatewayConfig, 'providerAccessShapes'> | undefined,
  profileId: string
):
  | {
      readonly shape: ReturnType<typeof StaticProviderAccessShapeSchema.parse>;
      readonly refresh: DelegatedRefreshIntent;
    }
  | undefined {
  const selected = configuration?.providerAccessShapes?.filter((shape) => shape.id === profileId);
  if (!selected || selected.length !== 1) return undefined;
  const parsed = StaticProviderAccessShapeSchema.safeParse(selected[0]);
  if (!parsed.success || !parsed.data.refresh) return undefined;
  return { shape: parsed.data, refresh: parsed.data.refresh };
}

/**
 * Refuses a strategy whose rotated family Core cannot recover, before any Policy or native effect.
 *
 * @param refresh Configured refresh intent.
 * @throws OperationError `credential_delegation_blocked` for a blocked strategy.
 */
export function assertDelegatedRefreshStrategyAvailable(refresh: DelegatedRefreshIntent): void {
  if (BLOCKED_DELEGATED_REFRESH_STRATEGIES.includes(refresh.strategy))
    throw new OperationError(
      'credential_delegation_blocked',
      'Delegated refresh is blocked: rotating-family recovery is unproved.',
      409
    );
}

function credentialFamilyBusy(): OperationError {
  return new OperationError(
    'credential_family_busy',
    'The credential refresh family is held by another writer.',
    409
  );
}

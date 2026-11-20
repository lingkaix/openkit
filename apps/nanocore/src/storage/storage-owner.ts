import { canonicalIdentifierName } from '@openkit/protocol';
import { uuidv5 } from '../generative-kernel/uuid.js';

/** Server-side owners with a typed handle for the v0.2.0 cutover. */
export type StorageOwner =
  | 'control-kernel'
  | 'server-work'
  | 'communication'
  | 'security-trigger'
  | 'nanohost'
  | 'openai-agents';

/** A2 reports the reason dependent work must refuse on this owner. */
export type StorageUnavailable<Owner extends StorageOwner> = {
  readonly state: 'unavailable';
  readonly owner: Owner;
  readonly reason:
    | 'disabled'
    | 'missing'
    | 'unsupported'
    | 'corrupt'
    | 'full'
    | 'migration-failed'
    | 'recovery-required';
};

/** File-local owner admission, checked again when posting a mutation. */
export type StorageStatus<Owner extends StorageOwner> =
  | { readonly state: 'ready'; readonly owner: Owner }
  | StorageUnavailable<Owner>;

/** Independent store failure travels with the refusal. */
export type StorageResult<Owner extends StorageOwner, Result> =
  | { readonly state: 'ready'; readonly value: Result }
  | StorageUnavailable<Owner>;

/** Original occurrence identity used to derive an internal request ID. */
export interface StorageOccurrence<Owner extends string, Verb extends string> {
  readonly deploymentId: string;
  readonly sourceOwner: Owner;
  readonly verb: Verb;
  readonly occurrenceKey: string;
}

/** A8 receipt key. Target, generation and digest are compared separately on replay. */
export function storageRequestId(occurrence: StorageOccurrence<string, string>): string {
  return uuidv5(
    canonicalIdentifierName([
      'openkit:storage-receipt:v1',
      occurrence.deploymentId,
      occurrence.sourceOwner,
      occurrence.verb,
      occurrence.occurrenceKey,
    ])
  );
}

/** Source-owned intent committed before posting to the deciding owner. */
export interface StorageIntent<Owner extends string, Verb extends string, Target>
  extends StorageOccurrence<Owner, Verb> {
  readonly requestId: string;
  readonly target: Target;
  readonly expectedGeneration: string | null;
  readonly inputDigest: string;
}

/** The deciding transaction commits the receipt with the transition and its Audit or step. */
export type StorageReceipt<Intent, Result> = {
  readonly intent: Intent;
  readonly receiptDigest: string;
} & (
  | { readonly disposition: 'applied'; readonly result: Result }
  | { readonly disposition: 'refused'; readonly reason: string }
);

/** An identical replay returns the original receipt under current read authority. */
export type StorageDecision<Receipt> =
  | { readonly state: 'settled'; readonly receipt: Receipt }
  | { readonly state: 'conflict' | 'unknown' };

/** Only a verified complete current history can report absence. */
export type StorageReceiptLookup<Receipt> = StorageDecision<Receipt> | { readonly state: 'absent' };

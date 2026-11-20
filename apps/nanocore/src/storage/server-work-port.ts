import type { ActorRef, CapabilityCall } from '@openkit/protocol';
import type {
  StorageIntent,
  StorageReceipt,
  StorageResult,
  StorageStatus,
} from './storage-owner.js';

/** A5 stages exact bytes at the work owner and carries only their reference to the kernel. */
interface ServerWorkContext {
  readonly actor: ActorRef;
  readonly credentialRef: string | null;
  readonly recordRef: string;
}

/** A Call may have no Thread or Turn. Usage and finish refer to the admitted Call by ID. */
interface ServerCallTarget extends ServerWorkContext {
  readonly callId: CapabilityCall['id'];
}

/** A5 checks the live actor, credential, route and applicable budget before provider contact. */
export type ServerCallAdmission = StorageIntent<
  'server-work',
  'admit-call',
  ServerCallTarget & {
    readonly threadId: CapabilityCall['threadId'];
    readonly turnId: CapabilityCall['turnId'];
    readonly routeRef: string;
    readonly budgetRef: string | null;
  }
>;

/** A5 applies the stage/decide/publish protocol before provider contact and at each settlement. */
export type ServerWorkIntent =
  | StorageIntent<'server-work', 'admit-thread', ServerWorkContext & { readonly threadId: string }>
  | StorageIntent<
      'server-work',
      'admit-turn' | 'settle-turn',
      ServerWorkContext & { readonly threadId: string; readonly turnId: string }
    >
  | ServerCallAdmission
  | StorageIntent<'server-work', 'settle-call' | 'settle-usage', ServerCallTarget>;

/** A5 binds the permitted publication to the original staged change. */
export type ServerWorkReceipt<Intent extends ServerWorkIntent = ServerWorkIntent> = StorageReceipt<
  Intent,
  { readonly decisionRef: string }
>;

/** A5 stages work before the kernel decision and publishes from its exact receipt. */
export interface ServerWorkStore {
  status(): StorageStatus<'server-work'>;
  /** Commit the staged record and intent before returning permission to post. */
  stage<Intent extends ServerWorkIntent>(
    intent: Intent
  ): Promise<StorageResult<'server-work', Intent>>;
  /** Read the original staged command after restart or a lost acknowledgement. */
  readIntent(requestId: string): Promise<StorageResult<'server-work', ServerWorkIntent | null>>;
  /** Match receipt and staged digest, then settle and publish once if applied. */
  settle(receipt: ServerWorkReceipt): Promise<StorageResult<'server-work', void>>;
  /** Verify owner publication before scheduler dispatch. */
  isPublished(receipt: ServerWorkReceipt): Promise<StorageResult<'server-work', boolean>>;
  /** A fresh claim on the published Call permits one provider contact after final authority checks. */
  claimCallContact(
    receipt: Extract<ServerWorkReceipt<ServerCallAdmission>, { disposition: 'applied' }>
  ): Promise<
    StorageResult<'server-work', { readonly state: 'claimed-now' | 'refused' | 'inspect-original' }>
  >;
}

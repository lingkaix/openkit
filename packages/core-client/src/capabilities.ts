import type { MetaResponseSchema } from '@openkit/protocol';
import type { z } from 'zod';

type MetaResponse = z.infer<typeof MetaResponseSchema>;

/** Error thrown when a required capability is missing. */
export class CapabilityRequiredError extends Error {
  /** Capability flag that was required. */
  public readonly capability: string;

  /** Creates a missing-capability error. */
  public constructor(capability: string) {
    super(`Capability is not supported by the active NanoCore server: ${capability}`);
    this.name = 'CapabilityRequiredError';
    this.capability = capability;
  }
}

/** First-class capability discovery helper. */
export interface CapabilitiesClient {
  /** Refreshes the local capability snapshot from `/api/meta`. */
  refresh(): Promise<MetaResponse>;
  /** Returns the latest local capability snapshot, if one has been loaded. */
  snapshot(): MetaResponse | null;
  /** Returns true when the latest snapshot includes one capability flag. */
  supports(flag: string): boolean;
  /** Throws when the latest snapshot does not include one capability flag. */
  require(flag: string): void;
}

/** Creates a capability discovery helper. */
export function createCapabilitiesClient(
  loadMeta: () => Promise<MetaResponse>
): CapabilitiesClient {
  let current: MetaResponse | null = null;

  return {
    async refresh() {
      current = await loadMeta();
      return current;
    },
    snapshot() {
      return current;
    },
    supports(flag) {
      return current?.capabilities.includes(flag) ?? false;
    },
    require(flag) {
      if (!(current?.capabilities.includes(flag) ?? false)) {
        throw new CapabilityRequiredError(flag);
      }
    },
  };
}

/** Fixed process-local entry ceiling; entries never retain reasoning payload bytes. */
export const REASONING_ATTRIBUTION_LIMIT = 4096;

/** Producing identity ignores logical routes and distinguishes Provider profiles/accounts. */
export interface ReasoningMember {
  /** Resolved Provider profile id. */
  readonly providerId: string;
  /** Native pi-ai model id that produced the capsule. */
  readonly modelId: string;
}

/** Payload-free LRU association abandoned on process restart, with ambiguous ids failing closed. */
export class ReasoningAttribution {
  private readonly entries = new Map<string, string | null>();

  /** Number of retained ids, including ambiguous entries, bounded by the fixed ceiling. */
  public get size(): number {
    return this.entries.size;
  }

  /** Records only an item returned by Gateway; conflicting producers invalidate attribution. */
  public record(itemId: string, member: ReasoningMember): void {
    const key = JSON.stringify([member.providerId, member.modelId]);
    const existing = this.entries.get(itemId);
    this.entries.delete(itemId);
    this.entries.set(itemId, existing === undefined || existing === key ? key : null);
    if (this.entries.size > REASONING_ATTRIBUTION_LIMIT) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  /** Refreshes a lookup's recency and permits opaque replay only for its unambiguous producer. */
  public matches(itemId: unknown, member: ReasoningMember): boolean {
    if (typeof itemId !== 'string') return false;
    const key = this.entries.get(itemId);
    if (key === undefined) return false;
    this.entries.delete(itemId);
    this.entries.set(itemId, key);
    return key === JSON.stringify([member.providerId, member.modelId]);
  }
}

/** Shared by every client in this process; only a process restart normally loses all entries. */
export const gatewayReasoningAttribution = new ReasoningAttribution();

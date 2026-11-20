import { policyDigest } from '@openkit/protocol/digest';

interface PublishedFactReference {
  readonly slotId: string;
  readonly collectionId: string;
  readonly collectionSetRevision: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly factId: string;
}

interface PublishedFactBody {
  readonly value: number;
  readonly unit: string;
  readonly asOf: string;
}

/** Ruling 2A: retain exact bytes only after current binding inventory and body admission. */
export async function captureDiscordPublishedFact(input: {
  readonly requested: PublishedFactReference;
  /** Reads the admitted inventory from binding and source owners, not from retrieval hits. */
  readonly currentInventory: () => readonly PublishedFactReference[];
  readonly readExact: (
    source: PublishedFactReference
  ) => Promise<{ readonly sourceDigest: string; readonly fact: PublishedFactBody } | undefined>;
}) {
  const revisionKey = policyDigest(input.requested);
  const exact = () => {
    const matches = input
      .currentInventory()
      .filter((source) => policyDigest(source) === revisionKey);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const reference = exact();
  if (!reference) return undefined;
  const body = await input.readExact(reference);
  if (!body || !exact() || body.sourceDigest !== reference.sourceDigest) return undefined;
  const { value, unit, asOf } = body.fact;
  if (!Number.isFinite(value) || !unit || !asOf) return undefined;
  const {
    slotId,
    collectionId,
    collectionSetRevision,
    sourceId,
    sourceRevision,
    sourceDigest,
    factId,
  } = reference;
  return {
    slotId,
    collectionId,
    collectionSetRevision,
    sourceId,
    sourceRevision,
    sourceDigest,
    factId,
    value,
    unit,
    asOf,
  };
}

import {
  type ServerEvidenceBundleRecord,
  ServerEvidenceBundleRecordSchema,
} from '@openkit/app-api-schemas';
import type Database from 'better-sqlite3';
import { assertControlProductWriter } from './control-store-products.js';
import {
  assertEvidenceBundleDirectoryId,
  evidenceBundleFromRow,
  insertEvidenceBundle,
  readEvidenceBundleRow,
} from './evidence-bundle-records.js';
import type { StorageResult } from './storage-owner.js';

function parseContainmentHandoff(record: ServerEvidenceBundleRecord): ServerEvidenceBundleRecord {
  const parsed = ServerEvidenceBundleRecordSchema.parse(record);
  assertEvidenceBundleDirectoryId(parsed.id);
  if (parsed.rawEvidenceRefs.length !== 0)
    throw new TypeError('Containment handoff must contain only redacted evidence.');
  return parsed;
}

interface ContainmentEvidenceInspection {
  readonly state: 'published' | 'conflict' | 'absent';
}

/** Publishes the original committed kernel handoff in the admitted Server work transaction. */
export function publishServerWorkContainmentEvidence(
  sqlite: Database.Database,
  record: ServerEvidenceBundleRecord
): void {
  assertControlProductWriter(sqlite);
  insertEvidenceBundle({ scope: 'server-work', sqlite }, parseContainmentHandoff(record));
}

/** Compares the original handoff to the retained destination after an ambiguous publication. */
export function inspectServerWorkContainmentEvidence(
  sqlite: Database.Database,
  record: ServerEvidenceBundleRecord
): ContainmentEvidenceInspection {
  const expected = parseContainmentHandoff(record);
  const stored = readEvidenceBundleRow({ sqlite }, expected.id);
  if (!stored) return { state: 'absent' };
  return {
    state:
      JSON.stringify(evidenceBundleFromRow(stored, true)) === JSON.stringify(expected)
        ? 'published'
        : 'conflict',
  };
}

interface ContainmentEvidenceStore {
  publish(record: ServerEvidenceBundleRecord): Promise<StorageResult<'server-work', void>>;
  inspect(
    record: ServerEvidenceBundleRecord
  ): Promise<StorageResult<'server-work', ContainmentEvidenceInspection>>;
}

/** Copies evidence after containment commits. A lost write ACK permits only exact inspection. */
export async function publishContainmentEvidenceHandoff(input: {
  readonly evidenceId: string;
  readonly readHandoff?: (
    evidenceId: string
  ) => Promise<StorageResult<'control-kernel', ServerEvidenceBundleRecord | null>>;
  readonly store?: ContainmentEvidenceStore;
}): Promise<
  StorageResult<
    'control-kernel' | 'server-work',
    { readonly state: 'published' | 'conflict' | 'unknown' }
  >
> {
  const { evidenceId, readHandoff, store } = input;
  if (!store) return { state: 'unavailable', owner: 'server-work', reason: 'disabled' };
  if (!readHandoff) return { state: 'unavailable', owner: 'control-kernel', reason: 'disabled' };

  const handoff = await Promise.resolve()
    .then(() => readHandoff(evidenceId))
    .catch(() => null);
  if (handoff?.state === 'unavailable') return handoff;
  if (!handoff?.value) return { state: 'ready', value: { state: 'unknown' } };

  let record: ServerEvidenceBundleRecord;
  try {
    record = parseContainmentHandoff(handoff.value);
  } catch {
    return { state: 'ready', value: { state: 'conflict' } };
  }
  if (record.id !== evidenceId) return { state: 'ready', value: { state: 'conflict' } };

  const published = await Promise.resolve()
    .then(() => store.publish(record))
    .catch(() => null);
  if (published?.state === 'unavailable') return published;
  if (published) return { state: 'ready', value: { state: 'published' } };

  const observed = await Promise.resolve()
    .then(() => store.inspect(record))
    .catch(() => null);
  if (observed?.state === 'unavailable') return observed;
  if (!observed || observed.value.state === 'absent')
    return { state: 'ready', value: { state: 'unknown' } };
  return { state: 'ready', value: { state: observed.value.state } };
}

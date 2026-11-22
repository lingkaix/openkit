import { SURFACES } from './surfaces';

/** Closed vocabulary from docs/specs/20260628-web_product_surface_projection.md. */
export const DISPOSITION_KINDS = ['live', 'workflow', 'roadmap'] as const;

export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

/** One recorded disposition. `kind` stays a string so an unknown value can fail the guard. */
export interface DispositionRecord {
  readonly key: string;
  readonly disposition: {
    readonly kind: string;
    readonly surface?: string;
    readonly issue?: number;
  };
}

/** The fields each disposition kind carries; any other field fails the guard (#885 item 3). */
const DISPOSITION_FIELDS: Record<DispositionKind, readonly string[]> = {
  live: ['kind', 'surface'],
  workflow: ['kind', 'surface'],
  roadmap: ['kind', 'issue'],
};
const RECORD_FIELDS = ['key', 'disposition'];

/** The evaluated access record NanoCore admits each public operation with. */
export interface EvaluatedAccess {
  readonly scope: string;
  readonly authentication?: string;
}

interface CredentialDefinition {
  readonly credentials: readonly string[];
}

/** A definition that admits only the Worker package is outside ordinary-user Web. */
export function admitsOnlyWorkerPackage(credentials: readonly string[]): boolean {
  return credentials.length === 1 && credentials[0] === 'worker-package';
}

/**
 * The ordinary-user inclusion set, read from the evaluated access catalog for every key:
 * user or Workspace scope, not the Gateway actor, and (where a definition exists) not
 * admitted only to the Worker package.
 */
export function includedOrdinaryUserOperationIds(
  access: Readonly<Record<string, EvaluatedAccess>>,
  definitions: Readonly<Record<string, CredentialDefinition>>
): string[] {
  return Object.entries(access)
    .filter(([, record]) => record.scope === 'user' || record.scope === 'workspace')
    .filter(([, record]) => record.authentication !== 'gateway-actor')
    .filter(([id]) => {
      const definition = definitions[id];
      return !definition || !admitsOnlyWorkerPackage(definition.credentials);
    })
    .map(([id]) => id)
    .sort();
}

/** Surface ids the catalog currently marks Tier A. */
export function tierASurfaceIds(): Set<string> {
  return new Set(SURFACES.filter((surface) => surface.tier === 'A').map((surface) => surface.id));
}

function unknownFields(value: object, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((field) => !allowed.includes(field));
}

/**
 * Missing, duplicate, unknown kind, unknown or misplaced field, leftover, non-Tier-A and
 * malformed issue numbers fail. Whether the issue is still open is checked against GitHub, not here.
 */
export function dispositionGuardErrors(input: {
  included: readonly string[];
  dispositions: readonly DispositionRecord[];
  tierASurfaceIds: ReadonlySet<string>;
}): string[] {
  const errors: string[] = [];
  const counts = new Map<string, number>();
  const included = new Set(input.included);
  for (const row of input.dispositions) {
    counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
    const kind = row.disposition.kind;
    if (!DISPOSITION_KINDS.includes(kind as DispositionKind)) {
      errors.push(`unknown disposition for ${row.key}`);
      continue;
    }
    const extra = [
      ...unknownFields(row, RECORD_FIELDS),
      ...unknownFields(row.disposition, DISPOSITION_FIELDS[kind as DispositionKind]),
    ];
    if (extra.length > 0) {
      errors.push(`unknown field ${extra.join(', ')} in disposition for ${row.key}`);
      continue;
    }
    const surface = row.disposition.surface;
    const issue = row.disposition.issue;
    if (kind === 'live' || kind === 'workflow') {
      if (typeof surface !== 'string') {
        errors.push(`invalid disposition shape for ${row.key}`);
        continue;
      }
      if (!input.tierASurfaceIds.has(surface)) {
        errors.push(`${kind} surface ${surface || '(none)'} is not Tier A for ${row.key}`);
      }
      continue;
    }
    if (typeof issue !== 'number') {
      errors.push(`invalid disposition shape for ${row.key}`);
      continue;
    }
    if (!Number.isSafeInteger(issue) || issue <= 0) {
      errors.push(`roadmap issue ${issue} is not an issue number for ${row.key}`);
    }
  }
  for (const [key, count] of counts) {
    if (count > 1) errors.push(`duplicate disposition for ${key}`);
    if (!included.has(key)) errors.push(`leftover disposition for ${key}`);
  }
  for (const key of input.included) {
    if (!counts.has(key)) errors.push(`missing disposition for ${key}`);
  }
  return errors;
}

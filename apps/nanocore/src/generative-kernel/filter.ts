import { LIGHT_APP_CAPABILITIES } from '@openkit/app-api-schemas';
import { KernelCommandError } from './errors.js';

const FILTER_BYTE_LIMIT = LIGHT_APP_CAPABILITIES.maxFilterBytes;
const MAX_PREDICATES = LIGHT_APP_CAPABILITIES.maxPredicates;
const MAX_DEPTH = LIGHT_APP_CAPABILITIES.maxGroupingDepth;

/** One compiled parameterized filter fragment. */
export interface CompiledFilter {
  /** SQL boolean expression using `?` placeholders. */
  readonly sql: string;
  /** Bound parameter values in placeholder order. */
  readonly params: readonly unknown[];
}

type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'and' }
  | { kind: 'or' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' };

/**
 * Compiles one PocketBase-style filter into parameterized SQL against admitted fields.
 *
 * @param filter Caller filter text.
 * @param columnFor Identifies the SQLite column for a field or metadata name.
 * @returns Compiled SQL and parameters, or null when the filter is empty.
 */
export function compileRecordFilter(
  filter: string | undefined,
  columnFor: (operand: string) => { sql: string; type: string }
): CompiledFilter | null {
  if (filter === undefined || filter.trim() === '') {
    return null;
  }
  if (Buffer.byteLength(filter, 'utf8') > FILTER_BYTE_LIMIT) {
    throw new KernelCommandError('limit_exceeded', 'Filter exceeds 2 KiB.', {
      limit: 'filterBytes',
      maximum: FILTER_BYTE_LIMIT,
    });
  }
  const tokens = tokenize(filter);
  let index = 0;
  let predicates = 0;
  const params: unknown[] = [];

  const peek = (): Token | undefined => tokens[index];
  const take = (): Token => {
    const token = tokens[index++];
    if (!token) {
      throw new KernelCommandError('validation_failed', 'Unexpected end of filter.', {
        path: 'filter',
      });
    }
    return token;
  };

  const parseOr = (depth: number): string => {
    if (depth > MAX_DEPTH) {
      throw new KernelCommandError('validation_failed', 'Filter grouping exceeds depth four.', {
        path: 'filter',
      });
    }
    let expr = parseAnd(depth);
    while (peek()?.kind === 'or') {
      take();
      expr = `(${expr} OR ${parseAnd(depth)})`;
    }
    return expr;
  };

  const parseAnd = (depth: number): string => {
    let expr = parsePrimary(depth);
    while (peek()?.kind === 'and') {
      take();
      expr = `(${expr} AND ${parsePrimary(depth)})`;
    }
    return expr;
  };

  const parsePrimary = (depth: number): string => {
    if (peek()?.kind === 'lparen') {
      take();
      const inner = parseOr(depth + 1);
      if (take().kind !== 'rparen') {
        throw new KernelCommandError(
          'validation_failed',
          'Filter is missing a closing parenthesis.',
          { path: 'filter' }
        );
      }
      return `(${inner})`;
    }
    return parseComparison();
  };

  const parseComparison = (): string => {
    predicates += 1;
    if (predicates > MAX_PREDICATES) {
      throw new KernelCommandError('limit_exceeded', 'Filter exceeds 32 predicates.', {
        limit: 'predicates',
        maximum: MAX_PREDICATES,
      });
    }
    const ident = take();
    if (ident.kind !== 'ident') {
      throw new KernelCommandError(
        'validation_failed',
        'Filter comparisons require a field identifier.',
        { path: 'filter' }
      );
    }
    const op = take();
    if (op.kind !== 'op') {
      throw new KernelCommandError('validation_failed', 'Filter comparisons require an operator.', {
        path: 'filter',
      });
    }
    const literal = take();
    const column = columnFor(ident.value);
    if (literal.kind === 'ident') {
      throw new KernelCommandError(
        'validation_failed',
        'Field-to-field comparisons are unavailable.',
        { path: 'filter' }
      );
    }
    if (literal.kind === 'null') {
      if (op.value === '=') {
        return `${column.sql} IS NULL`;
      }
      if (op.value === '!=') {
        return `${column.sql} IS NOT NULL`;
      }
      throw new KernelCommandError(
        'validation_failed',
        'Ordered comparisons to null are rejected.',
        { path: 'filter' }
      );
    }
    if (
      (op.value === '>' || op.value === '>=' || op.value === '<' || op.value === '<=') &&
      column.type !== 'text' &&
      column.type !== 'number' &&
      column.type !== 'date' &&
      ident.value !== 'created' &&
      ident.value !== 'updated' &&
      ident.value !== 'id' &&
      ident.value !== 'revision'
    ) {
      throw new KernelCommandError(
        'validation_failed',
        'Ordering operators apply only to text, number, or date.',
        { path: 'filter' }
      );
    }
    if (literal.kind === 'boolean') {
      const value = literal.value ? 1 : 0;
      if (op.value === '!=') {
        params.push(value);
        return `(${column.sql} IS NOT NULL AND ${column.sql} ${sqlOperator(op.value)} ?)`;
      }
      params.push(value);
      return `${column.sql} ${sqlOperator(op.value)} ?`;
    }
    const value =
      literal.kind === 'string' ? literal.value : literal.kind === 'number' ? literal.value : null;
    if (op.value === '!=') {
      params.push(value);
      return `(${column.sql} IS NOT NULL AND ${column.sql} ${sqlOperator(op.value)} ?)`;
    }
    if (op.value === '>' || op.value === '>=' || op.value === '<' || op.value === '<=') {
      params.push(value);
      return `(${column.sql} IS NOT NULL AND ${column.sql} ${sqlOperator(op.value)} ?)`;
    }
    params.push(value);
    return `${column.sql} ${sqlOperator(op.value)} ?`;
  };

  const sql = parseOr(1);
  if (index !== tokens.length) {
    throw new KernelCommandError('validation_failed', 'Filter contains trailing tokens.', {
      path: 'filter',
    });
  }
  return { sql, params };
}

/**
 * Maps a filter operator to SQL.
 *
 * @param op Filter operator.
 * @returns SQL operator.
 */
function sqlOperator(op: string): string {
  switch (op) {
    case '=':
      return '=';
    case '!=':
      return '!=';
    case '>':
      return '>';
    case '>=':
      return '>=';
    case '<':
      return '<';
    case '<=':
      return '<=';
    default:
      throw new KernelCommandError('validation_failed', `Unsupported filter operator: ${op}.`, {
        path: 'filter',
      });
  }
}

/**
 * Tokenizes one PocketBase-style filter.
 *
 * @param filter Filter text.
 * @returns Tokens.
 */
function tokenize(filter: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const takeWhile = (test: (ch: string) => boolean): string => {
    const start = i;
    while (i < filter.length && test(filter[i]!)) {
      i += 1;
    }
    return filter.slice(start, i);
  };
  while (i < filter.length) {
    const ch = filter[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '`') {
      throw new KernelCommandError('validation_failed', 'Single-quoted strings are unsupported.', {
        path: 'filter',
      });
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < filter.length) {
        if (filter[i] === '\\') {
          i += 2;
          continue;
        }
        if (filter[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      try {
        tokens.push({ kind: 'string', value: JSON.parse(filter.slice(start, i)) as string });
      } catch {
        throw new KernelCommandError('validation_failed', 'Invalid JSON string literal.', {
          path: 'filter',
        });
      }
      continue;
    }
    if (filter.startsWith('&&', i)) {
      tokens.push({ kind: 'and' });
      i += 2;
      continue;
    }
    if (filter.startsWith('||', i)) {
      tokens.push({ kind: 'or' });
      i += 2;
      continue;
    }
    if (filter.startsWith('>=', i) || filter.startsWith('<=', i) || filter.startsWith('!=', i)) {
      tokens.push({ kind: 'op', value: filter.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if (ch === '=' || ch === '>' || ch === '<') {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    if (ch === '/' || ch === '@') {
      throw new KernelCommandError('validation_failed', 'Unsupported filter syntax.', {
        path: 'filter',
      });
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const number = takeWhile((next) => /[0-9.eE+-]/.test(next));
      if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(number)) {
        throw new KernelCommandError('validation_failed', 'Filter numbers must be JSON numbers.', {
          path: 'filter',
        });
      }
      const value = Number(number);
      if (!Number.isFinite(value)) {
        throw new KernelCommandError('validation_failed', 'Filter numbers must be finite.', {
          path: 'filter',
        });
      }
      tokens.push({ kind: 'number', value });
      continue;
    }
    const ident = takeWhile((next) => /[A-Za-z0-9_]/.test(next));
    if (ident.length > 0 && !/^[A-Za-z_]/.test(ident)) {
      throw new KernelCommandError(
        'validation_failed',
        'Filter identifiers must start with a letter.',
        { path: 'filter' }
      );
    }
    if (ident === 'true' || ident === 'false') {
      tokens.push({ kind: 'boolean', value: ident === 'true' });
      continue;
    }
    if (ident === 'null') {
      tokens.push({ kind: 'null' });
      continue;
    }
    if (ident.length > 0) {
      tokens.push({ kind: 'ident', value: ident });
      continue;
    }
    throw new KernelCommandError('validation_failed', `Unsupported filter syntax at ${ch}.`, {
      path: 'filter',
    });
  }
  return tokens;
}

/**
 * Returns whether a filter is a top-level AND of comparisons that includes exact id equality.
 *
 * @param filter Filter text.
 * @param recordId Bound record UUID.
 * @returns True when the Kernel parser observes the required id equality.
 */
export function filterConstrainsRecordId(filter: string, recordId: string): boolean {
  const tokens = tokenize(filter);
  if (
    tokens.some(
      (token) => token.kind === 'or' || token.kind === 'lparen' || token.kind === 'rparen'
    )
  ) {
    return false;
  }
  const comparisons: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === 'and') {
      comparisons.push([]);
      continue;
    }
    comparisons[comparisons.length - 1]?.push(token);
  }
  return comparisons.some(
    (comparison) =>
      comparison.length === 3 &&
      comparison[0]?.kind === 'ident' &&
      comparison[0].value === 'id' &&
      comparison[1]?.kind === 'op' &&
      comparison[1].value === '=' &&
      comparison[2]?.kind === 'string' &&
      comparison[2].value === recordId
  );
}

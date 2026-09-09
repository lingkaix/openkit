import { KernelCommandError } from './errors.js';

const FILTER_BYTE_LIMIT = 2048;
const MAX_PREDICATES = 32;
const MAX_DEPTH = 4;

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
      throw new KernelCommandError('validation_failed', 'Unexpected end of filter.');
    }
    return token;
  };

  const parseOr = (depth: number): string => {
    if (depth > MAX_DEPTH) {
      throw new KernelCommandError('validation_failed', 'Filter grouping exceeds depth four.');
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
        throw new KernelCommandError('validation_failed', 'Filter is missing a closing parenthesis.');
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
      throw new KernelCommandError('validation_failed', 'Filter comparisons require a field identifier.');
    }
    const op = take();
    if (op.kind !== 'op') {
      throw new KernelCommandError('validation_failed', 'Filter comparisons require an operator.');
    }
    const literal = take();
    const column = columnFor(ident.value);
    if (literal.kind === 'ident') {
      throw new KernelCommandError('validation_failed', 'Field-to-field comparisons are unavailable.');
    }
    if (literal.kind === 'null') {
      if (op.value === '=') {
        return `${column.sql} IS NULL`;
      }
      if (op.value === '!=') {
        return `${column.sql} IS NOT NULL`;
      }
      throw new KernelCommandError('validation_failed', 'Ordered comparisons to null are rejected.');
    }
    if ((op.value === '>' || op.value === '>=' || op.value === '<' || op.value === '<=') &&
      column.type !== 'text' &&
      column.type !== 'number' &&
      column.type !== 'date' &&
      ident.value !== 'created' &&
      ident.value !== 'updated' &&
      ident.value !== 'id' &&
      ident.value !== 'revision') {
      throw new KernelCommandError(
        'validation_failed',
        'Ordering operators apply only to text, number, or date.'
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
    const value = literal.kind === 'string' ? literal.value : literal.kind === 'number' ? literal.value : null;
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
    throw new KernelCommandError('validation_failed', 'Filter contains trailing tokens.');
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
      throw new KernelCommandError('validation_failed', `Unsupported filter operator: ${op}.`);
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
      throw new KernelCommandError('validation_failed', 'Single-quoted strings are unsupported.');
    }
    if (ch === '"') {
      i += 1;
      let value = '';
      while (i < filter.length && filter[i] !== '"') {
        if (filter[i] === '\\') {
          i += 1;
          const escaped = filter[i];
          if (escaped === undefined) {
            throw new KernelCommandError('validation_failed', 'Unterminated string literal.');
          }
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
          i += 1;
          continue;
        }
        value += filter[i];
        i += 1;
      }
      if (filter[i] !== '"') {
        throw new KernelCommandError('validation_failed', 'Unterminated string literal.');
      }
      i += 1;
      tokens.push({ kind: 'string', value });
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
    if (ch === '/' || ch === '@' || ch === '-') {
      throw new KernelCommandError('validation_failed', 'Unsupported filter syntax.');
    }
    const ident = takeWhile((next) => /[A-Za-z0-9_]/.test(next));
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
    const number = takeWhile((next) => /[0-9.eE+-]/.test(next));
    if (number.length > 0) {
      const value = Number(number);
      if (!Number.isFinite(value)) {
        throw new KernelCommandError('validation_failed', 'Filter numbers must be finite.');
      }
      tokens.push({ kind: 'number', value });
      continue;
    }
    throw new KernelCommandError('validation_failed', `Unsupported filter syntax at ${ch}.`);
  }
  return tokens;
}

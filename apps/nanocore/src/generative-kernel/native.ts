import type { LightAppAdmittedCollection, LightAppAdmittedSchema } from '@openkit/app-api-schemas';

/**
 * Quotes one SQLite identifier generated from a stable UUID.
 *
 * @param value Identifier without quotes.
 * @returns Quoted identifier.
 */
export function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Native table name for one collection.
 *
 * @param collectionId Stable collection UUID.
 * @returns Unquoted table name.
 */
export function collectionTableName(collectionId: string): string {
  return `c_${collectionId.replaceAll('-', '')}`;
}

/**
 * Native column name for one field.
 *
 * @param fieldId Stable field UUID.
 * @returns Unquoted column name.
 */
export function fieldColumnName(fieldId: string): string {
  return `f_${fieldId.replaceAll('-', '')}`;
}

/**
 * SQLite type used for one admitted field.
 *
 * @param field Admitted field.
 * @returns SQLite declared type.
 */
export function sqliteTypeForField(field: LightAppAdmittedCollection['fields'][number]): string {
  if (field.type === 'bool') {
    return 'INTEGER';
  }
  if (field.type === 'number') {
    const onlyInt = (field.options as { onlyInt?: boolean } | undefined)?.onlyInt === true;
    return onlyInt ? 'INTEGER' : 'REAL';
  }
  return 'TEXT';
}

/**
 * Builds CREATE TABLE plus index DDL for one admitted schema.
 *
 * @param schema Admitted schema.
 * @returns SQL statements.
 */
export function createSchemaDdl(schema: LightAppAdmittedSchema): string[] {
  const statements: string[] = [];
  const collectionIds = new Set(schema.collections.map((collection) => collection.id));
  for (const collection of schema.collections) {
    const table = quoteIdent(collectionTableName(collection.id));
    const columns = [
      'id TEXT PRIMARY KEY NOT NULL',
      "revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0)",
      'created TEXT NOT NULL',
      'updated TEXT NOT NULL',
      'creator_json TEXT NOT NULL',
      'last_mutator_json TEXT NOT NULL',
      'create_request_id TEXT NOT NULL',
      'last_request_id TEXT NOT NULL',
      "write_schema_revision INTEGER NOT NULL CHECK (typeof(write_schema_revision) = 'integer' AND write_schema_revision > 0)",
    ];
    const foreignKeys: string[] = [];
    for (const field of collection.fields) {
      const column = quoteIdent(fieldColumnName(field.id));
      const type = sqliteTypeForField(field);
      const nullability = field.required ? 'NOT NULL' : '';
      columns.push(`${column} ${type} ${nullability}`.trim());
      const check = fieldCheckSql(field, column);
      if (check) {
        columns[columns.length - 1] += ` CHECK (${check})`;
      }
      if (field.type === 'relation') {
        const targetId = (field.options as { collection: string }).collection;
        if (!collectionIds.has(targetId)) {
          continue;
        }
        foreignKeys.push(
          `FOREIGN KEY (${column}) REFERENCES ${quoteIdent(collectionTableName(targetId))}(id) ON DELETE RESTRICT`
        );
      }
    }
    statements.push(`CREATE TABLE ${table} (${[...columns, ...foreignKeys].join(', ')})`);
    collection.indexes.forEach((index, indexNumber) => {
      const indexName = quoteIdent(`i_${collection.id.replaceAll('-', '')}_${indexNumber}`);
      const indexColumns = index.fields.map((fieldId) => quoteIdent(fieldColumnName(fieldId)));
      const unique = index.unique ? 'UNIQUE ' : '';
      statements.push(
        `CREATE ${unique}INDEX ${indexName} ON ${table} (${indexColumns.join(', ')})`
      );
    });
  }
  return statements;
}

/**
 * Builds ALTER TABLE statements that add newly admitted nullable columns.
 *
 * @param previous Previously admitted schema.
 * @param next Newly admitted schema.
 * @returns SQL statements.
 */
export function additiveSchemaDdl(
  previous: LightAppAdmittedSchema,
  next: LightAppAdmittedSchema
): string[] {
  const statements: string[] = [];
  for (const collection of next.collections) {
    const prior = previous.collections.find((candidate) => candidate.id === collection.id);
    if (!prior) {
      continue;
    }
    const table = quoteIdent(collectionTableName(collection.id));
    const known = new Set(prior.fields.map((field) => field.id));
    for (const field of collection.fields) {
      if (known.has(field.id)) {
        continue;
      }
      const column = quoteIdent(fieldColumnName(field.id));
      const check = fieldCheckSql(field, column);
      statements.push(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${sqliteTypeForField(field)}${check ? ` CHECK (${check})` : ''}`
      );
    }
  }
  return statements;
}

function fieldCheckSql(
  field: LightAppAdmittedCollection['fields'][number],
  column: string
): string | null {
  if (field.type === 'bool') {
    return `${column} IS NULL OR ${column} IN (0, 1)`;
  }
  if (field.type === 'number') {
    const options = (field.options ?? {}) as { onlyInt?: boolean; min?: number; max?: number };
    const parts = [
      options.onlyInt === true
        ? `typeof(${column}) = 'integer'`
        : `typeof(${column}) IN ('integer', 'real')`,
    ];
    if (typeof options.min === 'number') {
      parts.push(`${column} >= ${options.min}`);
    }
    if (typeof options.max === 'number') {
      parts.push(`${column} <= ${options.max}`);
    }
    return `${column} IS NULL OR (${parts.join(' AND ')})`;
  }
  if (field.type === 'select') {
    const values = ((field.options as { values?: string[] } | undefined)?.values ?? []).map(
      (value) => `'${value.replaceAll("'", "''")}'`
    );
    if (values.length === 0) {
      return null;
    }
    return `${column} IS NULL OR ${column} IN (${values.join(', ')})`;
  }
  if (field.type === 'text') {
    const max = (field.options as { max?: number } | undefined)?.max;
    if (typeof max === 'number') {
      return `${column} IS NULL OR length(${column}) <= ${max}`;
    }
  }
  return null;
}

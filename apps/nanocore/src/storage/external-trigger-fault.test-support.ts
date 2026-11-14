import type { CoreDb } from './db.js';

/** Corrupts one already committed source reference in an isolated test Core without naming a table. */
export function corruptExternalTriggerSourceTurn(
  coreDb: CoreDb,
  sourceTurnId: string,
  replacement: string
): void {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const normalize = (name: string) => name.replaceAll('_', '').toLowerCase();
  const tables = coreDb.sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  let changed = 0;
  for (const { name } of tables) {
    const columns = coreDb.sqlite.prepare(`PRAGMA table_info(${quote(name)})`).all() as {
      name: string;
      pk: number;
    }[];
    const keys = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
    const candidates = columns.filter((column) =>
      ['sourceturnid', 'scopejson'].includes(normalize(column.name))
    );
    if (!keys.length || !candidates.length) continue;
    const selected = [...new Set([...keys, ...candidates].map((column) => column.name))];
    const rows = coreDb.sqlite
      .prepare(`SELECT ${selected.map(quote).join(', ')} FROM ${quote(name)}`)
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      for (const column of candidates) {
        const original = row[column.name];
        let corrupted: string | undefined;
        if (normalize(column.name) === 'sourceturnid' && original === sourceTurnId)
          corrupted = replacement;
        if (normalize(column.name) === 'scopejson' && typeof original === 'string') {
          const scope = JSON.parse(original) as Record<string, unknown>;
          if (scope.sourceTurnId === sourceTurnId)
            corrupted = JSON.stringify({ ...scope, sourceTurnId: replacement });
        }
        if (corrupted === undefined) continue;
        const result = coreDb.sqlite
          .prepare(
            `UPDATE ${quote(name)} SET ${quote(column.name)} = ? WHERE ${keys.map((key) => `${quote(key.name)} = ?`).join(' AND ')}`
          )
          .run(corrupted, ...keys.map((key) => row[key.name]));
        changed += result.changes;
      }
    }
  }
  if (changed !== 1) throw new Error(`Expected one stored source reference; changed ${changed}.`);
}

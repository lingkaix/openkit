import type { ReactNode } from 'react';
import {
  Table as AriaTable,
  Cell,
  Column,
  Row,
  TableBody,
  TableHeader,
} from 'react-aria-components';

/** One column definition in an OpenKit data table. */
export interface TableColumn {
  /** Stable column identity used to resolve row cells. */
  id: string;
  /** Visible and accessible column label. */
  label: string;
}

/** One row of cells in an OpenKit data table. */
export interface TableRow {
  /** Stable row identity. */
  id: string;
  /** Cell content keyed by column identity. */
  cells: Record<string, ReactNode>;
}

/** Properties for the OpenKit data table. */
export interface TableProps {
  /** Accessible table name. */
  'aria-label': string;
  /** Ordered table columns; the first column identifies each row. */
  columns: TableColumn[];
  /** Ordered table rows. */
  rows: TableRow[];
}

/**
 * OpenKit data table with React Aria table, row, column, and cell semantics.
 *
 * The wrapper owns only compact Spectrum-tokened presentation; React Aria owns
 * collection identity, keyboard navigation, and accessibility behavior.
 */
export function Table({ 'aria-label': ariaLabel, columns, rows }: TableProps) {
  return (
    <div className="overflow-x-auto rounded-ok border border-border">
      <AriaTable
        aria-label={ariaLabel}
        className="w-full border-separate border-spacing-0 text-left"
      >
        <TableHeader columns={columns}>
          {(column) => (
            <Column
              id={column.id}
              isRowHeader={column.id === columns[0]?.id}
              className="border-b border-separator bg-sunken px-3 py-2 text-xs font-bold text-fg-strong"
            >
              {column.label}
            </Column>
          )}
        </TableHeader>
        <TableBody items={rows}>
          {(row) => (
            <Row id={row.id} columns={columns} className="text-sm text-fg">
              {(column) => (
                <Cell className="border-b border-separator px-3 py-2">{row.cells[column.id]}</Cell>
              )}
            </Row>
          )}
        </TableBody>
      </AriaTable>
    </div>
  );
}

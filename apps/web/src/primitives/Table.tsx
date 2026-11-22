import type { Key, ReactNode } from 'react';
import {
  Table as AriaTable,
  Cell,
  Column,
  Row,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { Menu, type MenuItem } from './Menu';

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

/** Row ⋯ menu: the same actions for every row, handed the row id. */
export interface TableRowActions {
  /** Actions offered in each row's ⋯ menu. */
  items: MenuItem[];
  /** Handles one action for one row. */
  onAction: (rowId: string, key: Key) => void;
  /** Accessible name of a row's menu, from the row. Defaults to "Actions for <row id>". */
  label?: (row: TableRow) => string;
}

/** Properties for the OpenKit data table. */
export interface TableProps {
  /** Accessible table name. */
  'aria-label': string;
  /** Ordered table columns; the first column identifies each row. */
  columns: TableColumn[];
  /** Ordered table rows. */
  rows: TableRow[];
  /** Optional row ⋯ menu in a last, unlabeled column. */
  rowActions?: TableRowActions;
}

const ACTIONS_COLUMN = '__actions';

/**
 * OpenKit data table (DESIGN.md §9.6): the S2 TableView look. No outer box; a 12px bold
 * subdued header row over a separator; 40/50 rows with hairline separators and a hover
 * tint; row commands live in one quiet ⋯ menu at the end of the row.
 *
 * React Aria owns collection identity, keyboard navigation, and accessibility behavior.
 */
export function Table({ 'aria-label': ariaLabel, columns, rows, rowActions }: TableProps) {
  const allColumns = rowActions ? [...columns, { id: ACTIONS_COLUMN, label: 'Actions' }] : columns;
  return (
    <div className="overflow-x-auto">
      <AriaTable
        aria-label={ariaLabel}
        className="w-full border-separate border-spacing-0 text-left"
      >
        <TableHeader columns={allColumns}>
          {(column) => (
            <Column
              id={column.id}
              isRowHeader={column.id === columns[0]?.id}
              className="ok-table-cell border-b border-separator pb-2 text-xs font-bold text-fg-muted"
            >
              {column.id === ACTIONS_COLUMN ? (
                <span className="sr-only">{column.label}</span>
              ) : (
                column.label
              )}
            </Column>
          )}
        </TableHeader>
        <TableBody items={rows}>
          {(row) => (
            <Row
              id={row.id}
              columns={allColumns}
              className="ok-table-row text-sm text-fg outline-none hover:bg-overlay data-[focus-visible]:outline-2 data-[focus-visible]:outline-solid data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus"
            >
              {(column) => (
                <Cell className="ok-table-cell border-b border-separator outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-solid data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus">
                  {column.id === ACTIONS_COLUMN && rowActions ? (
                    <div className="flex justify-end">
                      <Menu
                        icon="more"
                        label={rowActions.label?.(row) ?? `Actions for ${row.id}`}
                        items={rowActions.items}
                        onAction={(key) => rowActions.onAction(row.id, key)}
                      />
                    </div>
                  ) : (
                    row.cells[column.id]
                  )}
                </Cell>
              )}
            </Row>
          )}
        </TableBody>
      </AriaTable>
    </div>
  );
}

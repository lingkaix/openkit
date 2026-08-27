/**
 * A2UI catalog seed — whitelist map from declarative component type names to
 * OpenKit primitive renderers (DESIGN.md §9, D-011).
 *
 * Only imports from `primitives/`. Unknown types are never registered here; the
 * renderer degrades them to plain content. This module maps data → React trees
 * and never evaluates agent JSON as code.
 */

import type { ReactNode } from 'react';
import {
  Button,
  type ButtonSize,
  type ButtonVariant,
  Card,
  ItemCard,
  type ItemKind,
  Select,
  type SelectOption,
  StatusChip,
  type StatusTone,
  Switch,
  TextField,
} from '../../primitives';

/** Opaque props bag on a declarative A2UI node (strings, numbers, booleans, lists). */
export type A2UIProps = Record<string, unknown>;

/**
 * One node in a declarative A2UI document.
 *
 * Data-only: `type` selects a whitelisted renderer; `props` / `content` / `children`
 * are read as values. Never treated as executable code.
 */
export interface A2UINode {
  /** Component type name; must match a catalog key to render as a primitive. */
  type: string;
  /** Optional property bag forwarded to the whitelisted renderer. */
  props?: A2UIProps;
  /** Nested declarative children. */
  children?: A2UINode[];
  /** Plain text for Text nodes and unknown-type fallback. */
  content?: string;
}

/** Root envelope for a declarative A2UI surface. */
export interface A2UIDocument {
  /** Document root node. */
  root: A2UINode;
}

/**
 * Renders one catalog entry.
 *
 * @param node The declarative node (already known to be whitelisted).
 * @param renderChildren Helper that walks child nodes through the same renderer.
 * @returns React tree for the node.
 */
export type CatalogRenderer = (
  node: A2UINode,
  renderChildren: (nodes?: A2UINode[]) => ReactNode
) => ReactNode;

/**
 * Coerces an unknown prop to a display string.
 *
 * @param value Arbitrary prop value.
 * @param fallback Default when empty.
 * @returns String suitable for UI text.
 */
function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/**
 * Reads Select options from a declarative props bag.
 *
 * @param value Expected `{ id, label }[]`.
 * @returns Normalized select options.
 */
function asSelectOptions(value: unknown): SelectOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        id: asString(row.id, `opt_${index}`),
        label: asString(row.label, asString(row.id, `Option ${index + 1}`)),
      };
    })
    .filter((opt) => opt.label.length > 0);
}

/**
 * Whitelisted A2UI type → OpenKit primitive renderers.
 *
 * Keys are the only component type names the shell will render as interactive UI.
 */
export const A2UI_CATALOG: Readonly<Record<string, CatalogRenderer>> = {
  Card: (node, renderChildren) => (
    <Card className={asString(node.props?.className) || undefined}>
      {renderChildren(node.children)}
    </Card>
  ),

  Button: (node) => {
    const label = asString(node.props?.label, node.content ?? '');
    const variant = asString(node.props?.variant, 'accent') as ButtonVariant;
    const size = asString(node.props?.size, 'sm') as ButtonSize;
    return (
      <Button variant={variant} size={size}>
        {label}
      </Button>
    );
  },

  ItemCard: (node, renderChildren) => {
    const kind = asString(node.props?.kind, 'positive') as ItemKind;
    const title = asString(node.props?.title, node.content ?? 'Item');
    const meta = asString(node.props?.meta) || undefined;
    return (
      <ItemCard kind={kind} title={title} meta={meta}>
        {renderChildren(node.children)}
      </ItemCard>
    );
  },

  StatusChip: (node) => {
    const tone = asString(node.props?.tone, 'neutral') as StatusTone;
    const label = asString(node.props?.label, node.content ?? '');
    return <StatusChip tone={tone}>{label}</StatusChip>;
  },

  Switch: (node) => {
    const label = asString(node.props?.label, node.content ?? '');
    const selected = Boolean(node.props?.selected ?? node.props?.defaultSelected);
    return <Switch defaultSelected={selected}>{label}</Switch>;
  },

  Select: (node) => {
    const label = asString(node.props?.label, 'Select');
    const items = asSelectOptions(node.props?.items);
    const placeholder = asString(node.props?.placeholder) || undefined;
    const selectedKey = asString(node.props?.selectedKey) || undefined;
    return (
      <Select
        label={label}
        items={items}
        placeholder={placeholder}
        defaultSelectedKey={selectedKey}
      />
    );
  },

  TextField: (node) => {
    const label = asString(node.props?.label, 'Field');
    const defaultValue = asString(node.props?.value, node.content ?? '') || undefined;
    const placeholder = asString(node.props?.placeholder) || undefined;
    return <TextField label={label} defaultValue={defaultValue} placeholder={placeholder} />;
  },

  Text: (node) => {
    const text = asString(node.content, asString(node.props?.text));
    const strong = Boolean(node.props?.strong);
    if (strong) {
      return <p className="text-sm font-bold text-fg-strong">{text}</p>;
    }
    return <p className="text-sm text-fg">{text}</p>;
  },
};

/**
 * Returns whether a declarative type name is in the OpenKit A2UI whitelist.
 *
 * @param type Component type string from an A2UI node.
 * @returns True when a catalog renderer exists.
 */
export function isWhitelisted(type: string): boolean {
  return Object.hasOwn(A2UI_CATALOG, type);
}

/**
 * Builds a plain-text projection of a node for unknown-type fallback.
 *
 * Prefer explicit `content`, then a human note in props, then a compact props dump.
 *
 * @param node Declarative node (typically unwhitelisted).
 * @returns Safe plain string — never executable.
 */
export function plainContentFrom(node: A2UINode): string {
  if (typeof node.content === 'string' && node.content.length > 0) return node.content;
  const note = asString(node.props?.note);
  if (note) return note;
  const title = asString(node.props?.title);
  if (title) return title;
  const label = asString(node.props?.label);
  if (label) return label;
  if (node.props && Object.keys(node.props).length > 0) {
    return Object.entries(node.props)
      .map(([key, value]) => `${key}: ${asString(value, JSON.stringify(value))}`)
      .join('\n');
  }
  return `Unsupported component: ${node.type}`;
}

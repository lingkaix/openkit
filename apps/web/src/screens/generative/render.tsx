/**
 * Pure A2UI renderer (DESIGN.md §10.8, D-011).
 *
 * Walks a declarative JSON document and renders only whitelisted OpenKit
 * primitives. Unknown types degrade to plain content. Never mounts an embedded
 * frame, never evaluates agent JSON as code, never surfaces an error card for
 * catalog misses.
 */

import type { ReactNode } from 'react';
import { Fragment } from 'react';
import { Icon, Skeleton } from '../../primitives';
import { A2UI_CATALOG, type A2UIDocument, type A2UINode, plainContentFrom } from './catalog';
import type { GenerativeRenderState } from './states';

export interface PlainContentFallbackProps {
  /** Safe plain text to show instead of an unknown component. */
  content: string;
}

/**
 * Plain-content fallback for unknown A2UI component types.
 *
 * Renders text only — never an error banner and never an embedded frame.
 *
 * @param props.content Human-readable projection of the unknown node.
 */
export function PlainContentFallback({ content }: PlainContentFallbackProps) {
  return (
    <div data-a2ui-fallback className="whitespace-pre-wrap text-sm text-fg" role="note">
      {content}
    </div>
  );
}

/**
 * Renders one declarative A2UI node through the whitelist catalog.
 *
 * @param node Declarative node (data only).
 * @returns Whitelisted primitive tree, or plain-content fallback.
 */
export function renderA2UINode(node: A2UINode): ReactNode {
  const renderer = A2UI_CATALOG[node.type];
  if (!renderer) {
    return <PlainContentFallback content={plainContentFrom(node)} />;
  }
  return renderer(node, (children) => {
    if (!children || children.length === 0) return null;
    return children.map((child, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: declarative trees have no stable ids
      <Fragment key={`${child.type}-${index}`}>{renderA2UINode(child)}</Fragment>
    ));
  });
}

export interface A2UIRendererProps {
  /** Three-state presentation: streaming | ready | fallback. */
  state: GenerativeRenderState;
  /** Declarative document to render when not streaming. */
  document?: A2UIDocument | null;
  /** Optional status line under the streaming skeleton. */
  streamingNote?: string;
}

/**
 * In-thread A2UI render shell.
 *
 * - `streaming` → Skeleton (+ optional composing note)
 * - `ready` / `fallback` → walk the document; unknown nodes become plain content
 *
 * @param props.state Presentation state.
 * @param props.document Declarative A2UI document (fixture or future data plane).
 * @param props.streamingNote Optional composing hint for the streaming state.
 */
export function A2UIRenderer({ state, document, streamingNote }: A2UIRendererProps) {
  if (state === 'streaming') {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton lines={4} />
        {streamingNote ? (
          <p className="flex items-center gap-1.5 text-xs text-fg-muted">
            <Icon name="retry" size="sm" />
            {streamingNote}
          </p>
        ) : null}
      </div>
    );
  }

  if (!document) {
    return <PlainContentFallback content="No generative content." />;
  }

  return <div className="flex flex-col gap-3">{renderA2UINode(document.root)}</div>;
}

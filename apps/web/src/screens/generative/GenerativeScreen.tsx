/**
 * Generative UI / A2UI demo surface (WP-9, board 13).
 *
 * Tier C render shell only: shows the three-state fallback (streaming skeleton → rendered whitelist → plain-content fallback) with fixture declarations.
 * It is omitted from published navigation and routing.
 * No live agent data path exists.
 */

import type { ReactNode } from 'react';
import { AssistantMessage, Card, Icon, Page, PageHeader, UserMessage } from '../../primitives';
import { FALLBACK_SAMPLE, READY_SAMPLE, RESULT_ITEM_SAMPLE } from './fixtures';
import { A2UIRenderer } from './render';

/**
 * Tag row for a generated-view surface (board 13 `okb-surface-tag`).
 *
 * @param props.label Tag copy (e.g. "Generated view").
 */
function SurfaceTag({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-separator bg-sunken px-3 py-1.5 text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">
      <Icon name="generative" size="sm" />
      {label}
    </div>
  );
}

/**
 * In-thread generated surface chrome: tag + body.
 *
 * @param props.tag Surface tag label.
 * @param props.children Body content (renderer output).
 */
function GeneratedSurface({ tag, children }: { tag: string; children: ReactNode }) {
  return (
    <Card className="max-w-[480px] overflow-hidden p-0">
      <SurfaceTag label={tag} />
      <div className="flex flex-col gap-3 p-4">{children}</div>
    </Card>
  );
}

/** Board 13 internal review screen for the three-state A2UI shell. */
export function GenerativeScreen() {
  return (
    <Page>
      <PageHeader
        title="Generative UI"
        subtitle="A2UI in-thread render shell — whitelisted OpenKit primitives only."
      />

      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6">
        <UserMessage>
          Set up a weekly refresh of the competitor pricing, and email me what changed.
        </UserMessage>

        <AssistantMessage hue="you" initials="OK" author="Assistant">
          <p className="mb-3">Here&apos;s the setup — adjust anything and confirm.</p>
          <p className="mb-2 text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">
            Rendered · whitelist
          </p>
          <GeneratedSurface tag="Generated view">
            <A2UIRenderer state="ready" document={READY_SAMPLE} />
          </GeneratedSurface>
        </AssistantMessage>

        <div className="max-w-[480px]">
          <A2UIRenderer state="ready" document={RESULT_ITEM_SAMPLE} />
          <p className="mt-2 text-xs text-fg-muted">Submitted by SW · 16:02</p>
        </div>

        <UserMessage>How did prices move this quarter?</UserMessage>

        <AssistantMessage hue="you" initials="OK" author="Assistant">
          <p className="mb-3">Across the three competitors with public pricing:</p>
          <p className="mb-2 text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">
            Plain-content fallback
          </p>
          <GeneratedSurface tag="Generated view · plain fallback">
            <A2UIRenderer state="fallback" document={FALLBACK_SAMPLE} />
          </GeneratedSurface>
        </AssistantMessage>

        <UserMessage>Break that down by tier too.</UserMessage>

        <AssistantMessage hue="you" initials="OK" author="Assistant">
          <p className="mb-2 text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">
            Streaming skeleton
          </p>
          <GeneratedSurface tag="Generated view">
            <A2UIRenderer
              state="streaming"
              document={null}
              streamingNote="Composing the tier breakdown…"
            />
          </GeneratedSurface>
        </AssistantMessage>
      </div>
    </Page>
  );
}

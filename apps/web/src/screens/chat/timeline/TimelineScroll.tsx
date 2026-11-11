import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../../primitives';
import { fillCopy, timelineCopy } from './copy';
import { isFollowing, scrollCorrection, sentinelDistancePx, shouldPageEdge } from './window';

/** The thread window scroller, or the nearest ancestor that actually scrolls. */
export function scrollParent(node: HTMLElement | null): HTMLElement {
  const marked = node?.closest<HTMLElement>('[data-timeline-scroll]');
  if (marked) return marked;
  let current = node?.parentElement ?? null;
  while (current) {
    const overflow = getComputedStyle(current).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return current;
    current = current.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function distanceFromEnd(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}

function distanceToStart(scroller: HTMLElement): number {
  return scroller.scrollTop;
}

/**
 * Paging chrome and scroll anchoring for the run window.
 * `overflow-anchor` is set on the scroller, and the manual correction always runs.
 */
export function TimelineScroll({
  topEntryId,
  initiallyFollowing,
  canEarlier,
  canLater,
  paging,
  onEarlier,
  onLater,
  showJump,
  onJump,
  newCount,
  decisionNew,
  onFollowChange,
  onCatchUp,
  children,
}: {
  topEntryId: string | null;
  initiallyFollowing: boolean;
  canEarlier: boolean;
  canLater: boolean;
  paging: boolean;
  onEarlier: () => void;
  onLater: () => void;
  showJump: boolean;
  onJump: () => void;
  newCount: number;
  decisionNew: boolean;
  onFollowChange: (following: boolean) => void;
  onCatchUp: () => void;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const pending = useRef<{ id: string; top: number } | null>(null);
  const [following, setFollowing] = useState(initiallyFollowing);
  const followingRef = useRef(initiallyFollowing);

  function setFollow(next: boolean) {
    followingRef.current = next;
    setFollowing(next);
    onFollowChange(next);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the scroll listener stays on the scroller and reads the latest follow callback through setFollow.
  useEffect(() => {
    const scroller = scrollParent(frame.current);
    scroller.style.overflowAnchor = 'auto';
    const onScroll = () => {
      const next = isFollowing(distanceFromEnd(scroller));
      if (next !== followingRef.current) setFollow(next);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: paging callbacks stay current; rebinding the observer on each render would page twice.
  useEffect(() => {
    const root = scrollParent(frame.current);
    const viewport = root.clientHeight || window.innerHeight;
    const margin = `${Math.round(sentinelDistancePx(viewport))}px 0px`;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || paging) continue;
          const scroller = scrollParent(frame.current);
          const height = scroller.clientHeight || window.innerHeight;
          if (
            entry.target === topSentinel.current &&
            canEarlier &&
            shouldPageEdge(distanceToStart(scroller), height)
          ) {
            remember();
            onEarlier();
          }
          if (
            entry.target === bottomSentinel.current &&
            canLater &&
            shouldPageEdge(distanceFromEnd(scroller), height)
          ) {
            onLater();
          }
        }
      },
      {
        root: root === document.documentElement || root === document.scrollingElement ? null : root,
        rootMargin: margin,
      }
    );
    if (topSentinel.current) observer.observe(topSentinel.current);
    if (bottomSentinel.current) observer.observe(bottomSentinel.current);
    return () => observer.disconnect();
  }, [canEarlier, canLater, onEarlier, onLater, paging]);

  useLayoutEffect(() => {
    const fix = pending.current;
    if (!fix) return;
    const entry = document.querySelector<HTMLElement>(
      `[data-timeline-entry="${CSS.escape(fix.id)}"]`
    );
    if (!entry) return;
    const delta = scrollCorrection(fix.top, entry.getBoundingClientRect().top);
    // A follow-state render can land before the prepend. Keep the anchor until it moves.
    if (delta === 0) return;
    scrollParent(frame.current).scrollTop += delta;
    pending.current = null;
  });

  useLayoutEffect(() => {
    if (followingRef.current) pending.current = null;
    if (!followingRef.current || pending.current) return;
    const scroller = scrollParent(frame.current);
    scroller.scrollTop = scroller.scrollHeight;
  });

  function remember() {
    setFollow(false);
    if (!topEntryId) return;
    const entry = document.querySelector<HTMLElement>(
      `[data-timeline-entry="${CSS.escape(topEntryId)}"]`
    );
    if (!entry) return;
    pending.current = { id: topEntryId, top: entry.getBoundingClientRect().top };
  }

  return (
    <div ref={frame} className="flex flex-col gap-3">
      <div ref={topSentinel} aria-hidden="true" />
      {canEarlier ? (
        <Button
          variant="quiet"
          size="sm"
          isDisabled={paging}
          onPress={() => {
            remember();
            onEarlier();
          }}
        >
          {timelineCopy.loadEarlier}
        </Button>
      ) : null}
      {children}
      {canLater ? (
        <Button variant="quiet" size="sm" isDisabled={paging} onPress={onLater}>
          {timelineCopy.loadLater}
        </Button>
      ) : null}
      <div ref={bottomSentinel} aria-hidden="true" />
      {showJump ? (
        <Button
          variant="quiet"
          size="sm"
          className="sticky bottom-3 z-10 self-center"
          onPress={onJump}
        >
          {timelineCopy.jumpToLatest}
        </Button>
      ) : null}
      {newCount > 0 && !following ? (
        <Button
          variant="quiet"
          size="sm"
          className="sticky bottom-3 z-10 self-center"
          data-emphasis={decisionNew ? 'decision' : undefined}
          onPress={onCatchUp}
        >
          {fillCopy(timelineCopy.newUpdates, { count: newCount })}
        </Button>
      ) : null}
    </div>
  );
}

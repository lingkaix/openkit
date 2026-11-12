import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../../primitives';
import { fillCopy, timelineCopy } from './copy';
import { writeTimelineHistory } from './navigation-state';
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
  updatesHost,
  onFollowChange,
  onCatchUp,
  pinDivider,
  pinKey,
  restoreTop,
  followRequest = 0,
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
  /** Renders the new-updates control outside the scrolling entries. */
  updatesHost?: HTMLElement | null;
  onFollowChange: (following: boolean) => void;
  onCatchUp: () => void;
  /** Keep the catch-up row at the top of the window once, then leave scroll alone. */
  pinDivider?: boolean;
  /** Changing this arms the pin again. A prepend does not. */
  pinKey?: string;
  /** Scroll position from this history entry. Null follows the latest anchor. */
  restoreTop?: number | null;
  /** Bumps when Jump to latest or the catch-up control asks the scroller to follow. */
  followRequest?: number;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const pending = useRef<{ id: string; top: number; height: number } | null>(null);
  const [following, setFollowing] = useState(initiallyFollowing);
  const followingRef = useRef(initiallyFollowing);
  const pinnedDivider = useRef(false);
  const pinToken = useRef(pinKey);
  const restored = useRef(false);
  // The edge sentinel must not page while a saved offset is still waiting for height.
  const [restoreSettled, setRestoreSettled] = useState(restoreTop == null);
  const restoreToken = useRef(restoreTop);
  if (restoreToken.current !== restoreTop) {
    restoreToken.current = restoreTop;
    restored.current = false;
    setRestoreSettled(restoreTop == null);
  }

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
      writeTimelineHistory(window.history, { scrollTop: scroller.scrollTop });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: paging callbacks stay current; rebinding the observer on each render would page twice.
  useEffect(() => {
    if (!restoreSettled) return undefined;
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
  }, [canEarlier, canLater, onEarlier, onLater, paging, restoreSettled]);

  useLayoutEffect(() => {
    const fix = pending.current;
    if (!fix) return;
    const entry = document.querySelector<HTMLElement>(
      `[data-timeline-entry="${CSS.escape(fix.id)}"]`
    );
    if (!entry) return;
    const scroller = scrollParent(frame.current);
    // A follow render can land before the prepend. Wait until the page changes height,
    // then clear even when overflow-anchor already left a zero residual.
    if (scroller.scrollHeight === fix.height) return;
    const delta = scrollCorrection(fix.top, entry.getBoundingClientRect().top);
    if (delta !== 0) scroller.scrollTop += delta;
    pending.current = null;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: opening settles onto follow once; setFollow reads the latest callback.
  useLayoutEffect(() => {
    if (!initiallyFollowing || followingRef.current) return;
    setFollow(true);
  }, [initiallyFollowing]);

  const followedRequest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: setFollow is recreated each render; followedRequest records the one snap.
  useLayoutEffect(() => {
    if (followRequest === 0 || followRequest === followedRequest.current) return;
    followedRequest.current = followRequest;
    setFollow(true);
    const scroller = scrollParent(frame.current);
    scroller.scrollTop = scroller.scrollHeight;
  }, [followRequest]);

  useLayoutEffect(() => {
    if (followingRef.current) pending.current = null;
    if (pinDivider || !followingRef.current || pending.current) return;
    const scroller = scrollParent(frame.current);
    scroller.scrollTop = scroller.scrollHeight;
  });

  useLayoutEffect(() => {
    if (restoreTop == null) {
      restored.current = false;
      return;
    }
    if (restored.current || !frame.current) return;
    const scroller = scrollParent(frame.current);
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const hasEntry = scroller.querySelector('[data-timeline-entry]') != null;
    // Wait until the runs have height. A saved offset past the mounted end clamps.
    if (restoreTop > 0 && max < restoreTop - 2 && (!hasEntry || max === 0)) return;
    scroller.scrollTop = Math.min(restoreTop, max);
    restored.current = true;
    setRestoreSettled(true);
    if (!isFollowing(distanceFromEnd(scroller))) setFollow(false);
  });

  useLayoutEffect(() => {
    if (pinToken.current !== pinKey) {
      pinToken.current = pinKey;
      pinnedDivider.current = false;
    }
    if (!pinDivider) {
      pinnedDivider.current = false;
      return;
    }
    if (pinnedDivider.current) return;
    const scroller = scrollParent(frame.current);
    const divider = scroller.querySelector<HTMLElement>('[data-catch-up-divider]');
    if (!divider) return;
    const delta = divider.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (Math.abs(delta) > 1) scroller.scrollTop += delta;
    pinnedDivider.current = true;
  });

  // Inspecting steps leaves follow mode before their height changes.
  function pauseForFold(target: EventTarget | null) {
    if (target instanceof Element && target.closest('[data-fold-control]')) setFollow(false);
  }

  function remember() {
    setFollow(false);
    if (!topEntryId) return;
    const entry = document.querySelector<HTMLElement>(
      `[data-timeline-entry="${CSS.escape(topEntryId)}"]`
    );
    if (!entry) return;
    const scroller = scrollParent(frame.current);
    pending.current = {
      id: topEntryId,
      top: entry.getBoundingClientRect().top,
      height: scroller.scrollHeight,
    };
  }

  const newUpdatesButton =
    newCount > 0 && !following ? (
      <Button
        variant="quiet"
        size="sm"
        className={updatesHost ? undefined : 'self-center'}
        data-emphasis={decisionNew ? 'decision' : undefined}
        onPress={onCatchUp}
      >
        {fillCopy(timelineCopy.newUpdates, { count: newCount })}
      </Button>
    ) : null;
  const newUpdates = updatesHost ? createPortal(newUpdatesButton, updatesHost) : newUpdatesButton;

  return (
    <div
      ref={frame}
      className="flex flex-col gap-3"
      onPointerDownCapture={(event) => pauseForFold(event.target)}
      onClickCapture={(event) => pauseForFold(event.target)}
      onKeyDownCapture={(event) => {
        if (event.key === 'Enter' || event.key === ' ') pauseForFold(event.target);
      }}
    >
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
      {newUpdates}
    </div>
  );
}

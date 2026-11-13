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

export type VisibleTextAnchor = {
  entryId: string;
  node: Text | null;
  path: number[];
  offset: number;
  prefix: string;
  fragment: string;
  top: number;
};

type ViewBox = { x: number; y: number; width: number; height: number };

function viewBox(scroller: HTMLElement): ViewBox {
  const box = scroller.getBoundingClientRect();
  const x = box.left + scroller.clientLeft;
  const y = box.top + scroller.clientTop;
  const right = Math.min(x + scroller.clientWidth, window.innerWidth);
  const bottom = Math.min(y + scroller.clientHeight, window.innerHeight);
  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.max(0, right - Math.max(0, x)),
    height: Math.max(0, bottom - Math.max(0, y)),
  };
}

function overlaps(box: ViewBox, view: ViewBox): boolean {
  return (
    box.height > 0 &&
    box.width > 0 &&
    box.y + box.height > view.y + 1 &&
    box.y < view.y + view.height - 1 &&
    box.x + box.width > view.x &&
    box.x < view.x + view.width
  );
}

function toBox(rect: DOMRect | DOMRectReadOnly): ViewBox {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function entryTextNodes(entry: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (
      current instanceof Text &&
      current.data.trim() &&
      !current.parentElement?.closest('button,input,textarea,svg,[aria-hidden="true"]')
    ) {
      nodes.push(current);
    }
  }
  return nodes;
}

function characterBox(node: Text, offset: number): ViewBox | null {
  if (offset < 0 || offset >= node.length) return null;
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + 1);
  const rect = range.getClientRects()[0];
  return rect ? toBox(rect) : null;
}

function nodePath(entry: HTMLElement, node: Node): number[] {
  const path: number[] = [];
  let current: Node | null = node;
  while (current && current !== entry) {
    const parent: ParentNode | null = current.parentNode;
    if (!parent) return [];
    path.unshift(Array.from(parent.childNodes).indexOf(current as ChildNode));
    current = parent;
  }
  return path;
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range?.startContainer) return { node: range.startContainer, offset: range.startOffset };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  return { node: position.offsetNode, offset: position.offset };
}

function textMatches(node: Text, saved: VisibleTextAnchor): boolean {
  return (
    node.data.startsWith(saved.prefix) &&
    node.data.slice(saved.offset, saved.offset + 24) === saved.fragment
  );
}

function resolveAnchoredText(entry: HTMLElement, saved: VisibleTextAnchor): Text | null {
  if (saved.offset < 0) return null;
  if (saved.node?.isConnected && entry.contains(saved.node) && textMatches(saved.node, saved)) {
    return saved.node;
  }
  let candidate: Node | undefined = entry;
  for (const index of saved.path) candidate = candidate?.childNodes[index];
  if (candidate instanceof Text && textMatches(candidate, saved)) return candidate;
  const found = entryTextNodes(entry).filter((node) => textMatches(node, saved));
  return found.length === 1 ? found[0] : null;
}

/** Screen Y of the held visible text, or of the entry top when the run has no text. */
export function measureVisibleTextAnchor(
  scroller: HTMLElement,
  saved: VisibleTextAnchor
): number | null {
  const entry = scroller.querySelector<HTMLElement>(
    `[data-timeline-entry="${CSS.escape(saved.entryId)}"]`
  );
  if (!entry) return null;
  if (saved.offset < 0) return entry.getBoundingClientRect().top;
  const node = resolveAnchoredText(entry, saved);
  if (!node) return null;
  return characterBox(node, saved.offset)?.y ?? null;
}

function captureVisibleEntry(scroller: HTMLElement, view: ViewBox): VisibleTextAnchor | null {
  const portTop = scroller.getBoundingClientRect().top;
  for (const entry of scroller.querySelectorAll<HTMLElement>('[data-timeline-entry]')) {
    const top = entry.getBoundingClientRect().top;
    if (top < portTop - 2 || top >= view.y + view.height) continue;
    const entryId = entry.dataset.timelineEntry ?? '';
    if (!entryId) continue;
    return { entryId, node: null, path: [], offset: -1, prefix: '', fragment: '', top };
  }
  return null;
}

/** First visible text character, else an entry whose top edge is inside the viewport. */
export function captureVisibleTextAnchor(scroller: HTMLElement): VisibleTextAnchor | null {
  const view = viewBox(scroller);
  for (const entry of scroller.querySelectorAll<HTMLElement>('[data-timeline-entry]')) {
    if (!overlaps(toBox(entry.getBoundingClientRect()), view)) continue;
    const entryId = entry.dataset.timelineEntry ?? '';
    if (!entryId) continue;
    for (const node of entryTextNodes(entry)) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        if (!overlaps(toBox(line), view)) continue;
        const caret = caretAt(
          Math.max(line.left + 1, view.x + 1),
          Math.max(line.top + 1, view.y + 1)
        );
        if (caret?.node !== node) continue;
        let offset = Math.min(caret.offset, node.length - 1);
        while (offset < node.length - 1 && !node.data[offset]?.trim()) offset += 1;
        const box = characterBox(node, offset);
        if (!box || !overlaps(box, view)) continue;
        return {
          entryId,
          node,
          path: nodePath(entry, node),
          offset,
          prefix: node.data.slice(0, 64),
          fragment: node.data.slice(offset, offset + 24),
          top: box.y,
        };
      }
    }
  }
  return captureVisibleEntry(scroller, view);
}

function trackVisibleAnchor(
  scroller: HTMLElement,
  saved: VisibleTextAnchor | null
): VisibleTextAnchor | null {
  if (!saved) return captureVisibleTextAnchor(scroller);
  const top = measureVisibleTextAnchor(scroller, saved);
  const view = viewBox(scroller);
  if (top != null && top >= view.y && top < view.y + view.height) return { ...saved, top };
  return captureVisibleTextAnchor(scroller) ?? (top != null ? { ...saved, top } : saved);
}

/**
 * Paging chrome and scroll anchoring for the run window.
 * `overflow-anchor` is set on the scroller. While the reader is not following,
 * a visible text point is held and only its measured residual is corrected,
 * including when native anchoring leaves that point where content moved it.
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
  const held = useRef<VisibleTextAnchor | null>(null);
  const correcting = useRef(false);
  const tracking = useRef(false);
  const [following, setFollowing] = useState(initiallyFollowing);
  const followingRef = useRef(initiallyFollowing);
  const pinnedDivider = useRef(false);
  const pinToken = useRef(pinKey);
  const restored = useRef(false);
  const earlierRef = useRef<HTMLButtonElement>(null);
  const restoreEarlierFocus = useRef(false);
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
  useLayoutEffect(() => {
    const scroller = scrollParent(frame.current);
    scroller.style.overflowAnchor = 'auto';
    const onScroll = () => {
      const next = isFollowing(distanceFromEnd(scroller));
      if (next !== followingRef.current) setFollow(next);
      writeTimelineHistory(window.history, { scrollTop: scroller.scrollTop });
      if (correcting.current || tracking.current) return;
      if (followingRef.current) {
        held.current = null;
        return;
      }
      tracking.current = true;
      held.current = trackVisibleAnchor(scroller, held.current);
      tracking.current = false;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: paging callbacks stay current; rebinding the observer on each render would page twice.
  useEffect(() => {
    if (!restoreSettled) return undefined;
    // Paging waits when the observer API is absent. The timeline still renders.
    if (typeof IntersectionObserver === 'undefined') return undefined;
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
    if (delta !== 0) {
      correcting.current = true;
      scroller.scrollTop += delta;
      correcting.current = false;
    }
    pending.current = null;
  });

  useLayoutEffect(() => {
    if (paging || !restoreEarlierFocus.current) return;
    restoreEarlierFocus.current = false;
    // Paging can blur the button onto the body. A later choice stays where the reader put it.
    const active = document.activeElement;
    const resting =
      active == null ||
      active === document.body ||
      active === document.documentElement ||
      active === earlierRef.current;
    if (resting) earlierRef.current?.focus();
  }, [paging]);

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
    if (followingRef.current) {
      pending.current = null;
      held.current = null;
    }
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

  useLayoutEffect(() => {
    const scroller = scrollParent(frame.current);
    if (followingRef.current) {
      held.current = null;
      return;
    }
    tracking.current = true;
    try {
      const saved = held.current;
      if (saved) {
        const top = measureVisibleTextAnchor(scroller, saved);
        if (top != null) {
          const delta = scrollCorrection(saved.top, top);
          if (delta !== 0) {
            correcting.current = true;
            scroller.scrollTop += delta;
            correcting.current = false;
          }
        }
      }
      if (followingRef.current) {
        held.current = null;
        return;
      }
      held.current = trackVisibleAnchor(scroller, held.current);
    } finally {
      tracking.current = false;
    }
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
          ref={earlierRef}
          variant="quiet"
          size="sm"
          onPress={() => {
            restoreEarlierFocus.current = true;
            remember();
            onEarlier();
          }}
        >
          {timelineCopy.loadEarlier}
        </Button>
      ) : null}
      {children}
      {canLater ? (
        <Button variant="quiet" size="sm" onPress={onLater}>
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

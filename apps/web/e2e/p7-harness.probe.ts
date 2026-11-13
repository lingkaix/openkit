export interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface AnchorCheckpoint {
  at: number;
  cause: string;
  generation: number;
  valid: boolean;
  reason: string | null;
  entryId: string | null;
  entry: ProbeRect | null;
  point: ProbeRect | null;
  viewport: ProbeRect | null;
  visualViewport: {
    offsetTop: number;
    offsetLeft: number;
    width: number;
    height: number;
    scale: number;
  } | null;
  scrollTop: number | null;
  scrollHeight: number | null;
  clientHeight: number | null;
  absoluteDrift: number | null;
  relativeDrift: number | null;
}
export interface ProbeSnapshot {
  timeline: number[];
  roots: number[];
  ownerLocated: boolean;
  ownerErrors: string[];
  ownerEvidence: Array<{ at: number; name: string; candidates: number }>;
  anchorTrace: AnchorCheckpoint[];
  anchorIdentity: {
    entryId: string;
    path: number[];
    offset: number;
    prefix: string;
    fragment: string;
    generation: number;
  } | null;
  anchorSettled: boolean;
}
export interface BrowserProbe {
  timeline: number[];
  roots: number[];
  record(cause: string): AnchorCheckpoint | null;
  settleAnchor(label: string): Promise<AnchorCheckpoint>;
  snapshot(): ProbeSnapshot;
}

/** Serialized before React. No imports, application mutation, polling owner or network access. */
export function installBrowserProbe(scope: { workspaceId: string; threadId: string }) {
  type Fiber = {
    type?: { name?: string } | ((...args: never[]) => unknown);
    memoizedState?: unknown;
    memoizedProps?: Record<string, unknown>;
    child?: Fiber;
    sibling?: Fiber;
    return?: Fiber;
  };
  // Playwright does not promise ordering between multiple init scripts.
  const existing = (window as unknown as { __p7?: { timeline: number[]; roots: number[] } }).__p7;
  const timeline: number[] = existing?.timeline ?? [],
    roots: number[] = existing?.roots ?? [],
    ownerErrors: string[] = [];
  const ownerEvidence: ProbeSnapshot['ownerEvidence'] = [];
  let ownerSeen = false,
    ownerState: unknown,
    ownerProps: unknown,
    ownerType: unknown;
  let ownerLocated = false;
  const isOwner = (f: Fiber) => {
    const p = f.memoizedProps;
    return (
      typeof f.type === 'function' &&
      p?.workspaceId === scope.workspaceId &&
      p.threadId === scope.threadId &&
      typeof p.onJumpToLatest === 'function' &&
      typeof p.measureOpening === 'boolean' &&
      typeof p.readOnly === 'boolean' &&
      typeof p.mode === 'string' &&
      typeof p.lens === 'string' &&
      typeof p.anchor === 'object' &&
      p.anchor !== null
    );
  };
  (
    window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }
  ).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberRoot(_id: number, root: { current?: Fiber }) {
      const at = performance.now();
      roots.push(at);
      const candidates = new Set<Fiber>();
      let scopedLens = false;
      const walk = (f: Fiber | undefined) => {
        if (!f) return;
        if (f.memoizedProps?.['data-timeline-lens'] != null) {
          let ancestor = f.return;
          while (ancestor) {
            if (
              ancestor.memoizedProps?.workspaceId === scope.workspaceId &&
              ancestor.memoizedProps.threadId === scope.threadId
            )
              scopedLens = true;
            if (isOwner(ancestor)) candidates.add(ancestor);
            ancestor = ancestor.return;
          }
        }
        walk(f.child);
        walk(f.sibling);
      };
      walk(root.current);
      if (!candidates.size) {
        if (scopedLens) ownerErrors.push('ThreadStream boundary missing');
        return;
      }
      ownerEvidence.push({
        at,
        name: [...candidates][0]?.type?.name ?? 'anonymous',
        candidates: candidates.size,
      });
      if (candidates.size !== 1) {
        ownerErrors.push('ambiguous ThreadStream boundary');
        return;
      }
      const owner = [...candidates][0];
      ownerLocated = true;
      if (ownerSeen && ownerType !== owner.type)
        ownerErrors.push('ThreadStream boundary type changed');
      if (!ownerSeen || ownerState !== owner.memoizedState || ownerProps !== owner.memoizedProps)
        timeline.push(at);
      ownerSeen = true;
      ownerState = owner.memoizedState;
      ownerProps = owner.memoizedProps;
      ownerType = owner.type;
    },
  };
  const trace: AnchorCheckpoint[] = [];
  const rect = (r: DOMRect | DOMRectReadOnly): ProbeRect => ({
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  });
  const port = () => document.querySelector<HTMLElement>('[data-timeline-scroll]');
  const viewport = (p: HTMLElement) => {
    const r = p.getBoundingClientRect();
    const x = r.left + p.clientLeft,
      y = r.top + p.clientTop;
    const right = Math.min(x + p.clientWidth, innerWidth),
      bottom = Math.min(y + p.clientHeight, innerHeight);
    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.max(0, right - Math.max(0, x)),
      height: Math.max(0, bottom - Math.max(0, y)),
    };
  };
  const visible = (r: ProbeRect, v: ProbeRect) =>
    r.height > 0 &&
    r.width > 0 &&
    r.y + r.height > v.y + 1 &&
    r.y < v.y + v.height - 1 &&
    r.x + r.width > v.x &&
    r.x < v.x + v.width;
  const textNodes = (entry: HTMLElement) => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (
        n instanceof Text &&
        n.data.trim() &&
        !n.parentElement?.closest('button,input,textarea,svg,[aria-hidden="true"]')
      )
        nodes.push(n);
    }
    return nodes;
  };
  const pointRect = (node: Text, offset: number) => {
    if (offset < 0 || offset >= node.length) return null;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const r = range.getClientRects()[0];
    return r ? rect(r) : null;
  };
  const pathTo = (entry: HTMLElement, node: Node) => {
    const path: number[] = [];
    let current: Node | null = node;
    while (current && current !== entry) {
      const parent: ParentNode | null = current.parentNode;
      if (!parent) return [];
      path.unshift(Array.from(parent.childNodes).indexOf(current as ChildNode));
      current = parent as Node;
    }
    return path;
  };
  type Held = {
    entryId: string;
    node: Text;
    path: number[];
    offset: number;
    prefix: string;
    fragment: string;
    generation: number;
    baseY: number;
    baseRelative: number;
  };
  let held: Held | null = null,
    generation = 0,
    settled = false;
  const select = (): Held | null => {
    const p = port();
    if (!p) return null;
    const v = viewport(p);
    for (const entry of p.querySelectorAll<HTMLElement>('[data-timeline-entry]')) {
      if (!visible(rect(entry.getBoundingClientRect()), v)) continue;
      for (const node of textNodes(entry)) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const line of range.getClientRects()) {
          if (!visible(rect(line), v)) continue;
          // Native caret hit testing chooses the first visible text line, not the run's offscreen top.
          const doc = document as Document & {
            caretRangeFromPoint(x: number, y: number): Range | null;
          };
          const caret = doc.caretRangeFromPoint(
            Math.max(line.left + 1, v.x + 1),
            Math.max(line.top + 1, v.y + 1)
          );
          if (caret?.startContainer !== node) continue;
          let offset = Math.min(caret.startOffset, node.length - 1);
          while (offset < node.length - 1 && !node.data[offset]?.trim()) offset++;
          const point = pointRect(node, offset);
          if (!point || !visible(point, v)) continue;
          return {
            entryId: entry.dataset.timelineEntry ?? '',
            node,
            path: pathTo(entry, node),
            offset,
            prefix: node.data.slice(0, 64),
            fragment: node.data.slice(offset, offset + 24),
            generation,
            baseY: point.y,
            baseRelative: point.y - v.y,
          };
        }
      }
    }
    return null;
  };
  const resolve = (entry: HTMLElement, h: Held): Text | null => {
    if (
      h.node.isConnected &&
      entry.contains(h.node) &&
      h.node.data.startsWith(h.prefix) &&
      h.node.data.slice(h.offset, h.offset + 24) === h.fragment
    )
      return h.node;
    let candidate: Node | undefined = entry;
    for (const index of h.path) candidate = candidate?.childNodes[index];
    if (
      candidate instanceof Text &&
      candidate.data.startsWith(h.prefix) &&
      candidate.data.slice(h.offset, h.offset + 24) === h.fragment
    )
      return candidate;
    const matches = textNodes(entry).filter(
      (n) => n.data.startsWith(h.prefix) && n.data.slice(h.offset, h.offset + 24) === h.fragment
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const record = (cause: string): AnchorCheckpoint | null => {
    if (!held) return null;
    const p = port(),
      v = p ? viewport(p) : null;
    const entry =
      p?.querySelector<HTMLElement>(`[data-timeline-entry="${CSS.escape(held.entryId)}"]`) ?? null;
    const node = entry ? resolve(entry, held) : null;
    const point = node ? pointRect(node, held.offset) : null;
    const vv = window.visualViewport;
    const value: AnchorCheckpoint = {
      at: performance.now(),
      cause,
      generation: held.generation,
      valid: Boolean(point && p && entry),
      reason: !p
        ? 'viewport missing'
        : !entry
          ? 'entry removed'
          : !node
            ? 'text identity lost'
            : !point
              ? 'text point unavailable'
              : null,
      entryId: held.entryId,
      entry: entry ? rect(entry.getBoundingClientRect()) : null,
      point,
      viewport: v,
      visualViewport: vv
        ? {
            offsetTop: vv.offsetTop,
            offsetLeft: vv.offsetLeft,
            width: vv.width,
            height: vv.height,
            scale: vv.scale,
          }
        : null,
      scrollTop: p?.scrollTop ?? null,
      scrollHeight: p?.scrollHeight ?? null,
      clientHeight: p?.clientHeight ?? null,
      absoluteDrift: point ? Math.abs(point.y - held.baseY) : null,
      relativeDrift: point && v ? Math.abs(point.y - v.y - held.baseRelative) : null,
    };
    trace.push(value);
    return value;
  };
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  const probe: BrowserProbe = {
    timeline,
    roots,
    record,
    async settleAnchor(label) {
      generation++;
      settled = false;
      held = null;
      const deadline = performance.now() + 2000;
      let previous: string | null = null,
        stable = 0;
      while (performance.now() < deadline) {
        await frame();
        const candidate = select();
        const p = port();
        const signature =
          candidate && p
            ? JSON.stringify([
                candidate.entryId,
                candidate.path,
                candidate.offset,
                candidate.baseY,
                rect(p.getBoundingClientRect()),
                p.scrollTop,
                p.scrollHeight,
                p.clientHeight,
              ])
            : null;
        stable = signature !== null && signature === previous ? stable + 1 : 0;
        previous = signature;
        if (stable >= 2 && candidate) {
          held = candidate;
          settled = true;
          return record(`baseline:${label}`) as AnchorCheckpoint;
        }
      }
      throw new Error('First-visible text anchor did not settle within 2s');
    },
    snapshot() {
      return {
        timeline,
        roots,
        ownerLocated,
        ownerErrors,
        ownerEvidence,
        anchorTrace: trace,
        anchorIdentity: held
          ? {
              entryId: held.entryId,
              path: held.path,
              offset: held.offset,
              prefix: held.prefix,
              fragment: held.fragment,
              generation: held.generation,
            }
          : null,
        anchorSettled: settled,
      };
    },
  };
  (window as unknown as { __p7Harness: BrowserProbe }).__p7Harness = probe;
  document.addEventListener('keydown', () => record('typing:keydown'), true);
  document.addEventListener(
    'input',
    () => {
      record('typing:input');
      requestAnimationFrame(() => record('typing:paint'));
    },
    true
  );
  let queued = false;
  const observe = () =>
    new MutationObserver((records) => {
      if (
        !held ||
        !records.some((r) =>
          (r.target instanceof Element ? r.target : r.target.parentElement)?.closest(
            '[data-timeline-lens]'
          )
        )
      )
        return;
      if (!queued) {
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          record('stream:dom-paint');
        });
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-run-status'],
    });
  if (document.documentElement) observe();
  else document.addEventListener('DOMContentLoaded', observe, { once: true });
}

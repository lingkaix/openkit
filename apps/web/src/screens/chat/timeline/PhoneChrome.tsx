import { type ReactNode, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { usePersistentNavigation } from '../../../app/AppShell';
import { Button, Icon } from '../../../primitives';
import { timelineCopy } from './copy';
import type { NowModel } from './now';
import {
  closeSheetSearch,
  nextSheetStack,
  openSheetSearch,
  phoneBarLabel,
  type SheetKind,
  type SheetLayer,
  sheetDepthOf,
  sheetStackOf,
} from './phone';
import { RequestUnavailableNotice } from './request-anchor';

export interface TimelineSheets {
  phone: boolean;
  decisionId: string | null;
  stepsTurnId: string | null;
  inspectTurnId: string | null;
  /** The sheet underneath the URL sheet. Present only while two sheets are open. */
  under: SheetLayer | null;
  open: (kind: SheetKind, id: string, mode?: 'push' | 'replace') => void;
  close: () => void;
}

/** URL-backed sheets. Back pops the entry and stays on the Thread. */
export function useTimelineSheets(): TimelineSheets {
  const phone = !usePersistentNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const openers = useRef<Array<HTMLElement | null>>([]);
  const seenDepth = useRef(0);
  const decisionId = searchParams.get('decision');
  const stepsTurnId = searchParams.get('steps');
  const inspectTurnId = searchParams.get('inspect');
  const urlTop: SheetLayer | null = decisionId
    ? { kind: 'decision', id: decisionId }
    : stepsTurnId
      ? { kind: 'steps', id: stepsTurnId }
      : inspectTurnId
        ? { kind: 'inspect', id: inspectTurnId }
        : null;
  const recorded = sheetStackOf(location.state);
  const stack =
    recorded.length > 0 ? recorded : urlTop && sheetDepthOf(location.state) > 0 ? [urlTop] : [];
  const under = stack.length === 2 && urlTop && stack[1]?.kind === urlTop.kind ? stack[0]! : null;
  const open = (kind: SheetKind, id: string, mode: 'push' | 'replace' = 'push') => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fromHistory = sheetStackOf(history.state);
    const base = fromHistory.length > 0 ? fromHistory : stack;
    const next =
      mode === 'replace' && base.length > 0
        ? { mode: 'replace' as const, stack: [...base.slice(0, -1), { kind, id }] }
        : nextSheetStack(base, kind, id);
    const index = next.stack.length - 1;
    openers.current[index] = active;
    openers.current.length = index + 1;
    const search = openSheetSearch(searchParams.toString(), kind, id);
    navigate(
      { pathname: location.pathname, search },
      {
        replace: next.mode === 'replace',
        state: { okSheet: kind, sheetDepth: next.stack.length, sheetStack: next.stack },
      }
    );
  };
  const close = () => {
    if (sheetDepthOf(location.state) > 0 || sheetDepthOf(history.state) > 0) {
      navigate(-1);
      return;
    }
    setSearchParams(closeSheetSearch(searchParams.toString()), { replace: true });
  };
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    const id = decisionId ?? stepsTurnId ?? inspectTurnId;
    if (!id) return;
    const state = history.state as {
      usr?: { okSheet?: string };
      okSheet?: string;
    } | null;
    if (
      sheetDepthOf(location.state) > 0 ||
      sheetDepthOf(state) > 0 ||
      state?.usr?.okSheet ||
      state?.okSheet
    )
      return;
    const key = `${location.pathname}?${location.search}`;
    if (seeded.current === key) return;
    seeded.current = key;
    const kind: SheetKind = decisionId ? 'decision' : stepsTurnId ? 'steps' : 'inspect';
    const current = searchParams.toString();
    flushSync(() => {
      navigate(
        { pathname: location.pathname, search: closeSheetSearch(current) },
        { replace: true, state: { sheetDepth: 0 } }
      );
    });
    navigate(
      { pathname: location.pathname, search: openSheetSearch(current, kind, id) },
      { state: { okSheet: kind, sheetDepth: 1, sheetStack: [{ kind, id }] } }
    );
  }, [
    decisionId,
    inspectTurnId,
    location.pathname,
    location.search,
    location.state,
    navigate,
    searchParams,
    stepsTurnId,
  ]);
  const depth = under ? 2 : urlTop ? Math.max(stack.length, 1) : 0;
  useEffect(() => {
    const previous = seenDepth.current;
    seenDepth.current = depth;
    if (depth >= previous) return;
    const target = openers.current[previous - 1];
    openers.current.length = depth;
    target?.focus();
  }, [depth]);
  return { phone, decisionId, stepsTurnId, inspectTurnId, under, open, close };
}

/** Sticky Now and Needs you line. Tapping opens the next decision. */
export function PhoneBar({
  now,
  needsCount,
  reducedMotion,
  onOpen,
  unavailable = false,
}: {
  now: NowModel;
  needsCount: number;
  reducedMotion: boolean;
  onOpen?: () => void;
  /** The current timeline window kept its body after a missing request or Item anchor. */
  unavailable?: boolean;
}) {
  const nowText = now.kind === 'hidden' ? null : now.text;
  const label = phoneBarLabel(nowText, needsCount);
  const notice = <RequestUnavailableNotice unavailable={unavailable} />;
  if (!label) return notice;
  const live = !reducedMotion && (now.kind === 'step' || now.kind === 'thinking') && now.live;
  const className = 'ok-meta flex min-h-11 w-full items-center gap-2 text-left';
  const body = (
    <>
      <span className="ok-now-dot" data-live={live ? 'true' : 'false'} aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </>
  );
  if (!onOpen) {
    return (
      <>
        {notice}
        <p data-phone-bar="true" className={className}>
          {body}
        </p>
      </>
    );
  }
  return (
    <>
      {notice}
      <button type="button" data-phone-bar="true" className={className} onClick={onOpen}>
        {body}
      </button>
    </>
  );
}

export function PhoneSheetFrame({
  label,
  mode,
  expanded,
  onExpand,
  onClose,
  covered = false,
  children,
  footer,
}: {
  label: string;
  mode: 'full' | 'partial';
  expanded?: boolean;
  onExpand?: () => void;
  onClose: () => void;
  /** A newer sheet is open above this one. Keep it mounted, but out of the way. */
  covered?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const full = mode === 'full' || expanded === true;
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (covered) return;
    const node = dialogRef.current;
    if (node && !node.contains(document.activeElement)) {
      const firstControl = node.querySelector<HTMLElement>('button, [href], input, textarea');
      (firstControl ?? node).focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (!node) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ),
      ];
      if (focusable.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [covered]);
  return (
    <div
      className="fixed inset-0 z-40 flex flex-col"
      inert={covered || undefined}
      aria-hidden={covered || undefined}
    >
      {mode === 'partial' && !full ? <div className="min-h-0 flex-1" aria-hidden="true" /> : null}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal={covered ? undefined : true}
        aria-label={label}
        tabIndex={-1}
        data-sheet={mode}
        data-expanded={full ? 'true' : 'false'}
        className={`flex flex-col bg-layer-1 shadow-ok-modal outline-none ${full ? 'h-full' : 'h-[60vh] rounded-t-ok-xl border border-separator'}`}
      >
        {mode === 'partial' ? (
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-center"
            aria-label={expanded ? timelineCopy.collapseSheet : timelineCopy.expandSheet}
            onClick={onExpand}
          >
            <span className="h-1 w-10 rounded-full bg-border" aria-hidden="true" />
          </button>
        ) : null}
        <div className="flex items-center justify-between gap-2 px-3">
          <h2 className="text-sm font-semibold text-fg">{label}</h2>
          <Button
            size="sm"
            variant="quiet"
            aria-label={timelineCopy.closeSheet}
            className="min-h-11 min-w-11 shrink-0 px-0!"
            onPress={onClose}
          >
            <Icon name="close" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4">{children}</div>
        {footer ? (
          <div
            className={mode === 'full' ? 'flex min-h-[40%] flex-col gap-3 px-4 pt-3' : 'px-4 pb-4'}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export { DecisionSheet } from './decision-sheet';

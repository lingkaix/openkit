import { type ReactNode, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { usePersistentNavigation } from '../../../app/AppShell';
import { Button, Icon } from '../../../primitives';
import { timelineCopy } from './copy';
import type { NowModel } from './now';
import {
  closeSheetSearch,
  nextSheetDepth,
  openSheetSearch,
  phoneBarLabel,
  type SheetKind,
  sheetDepthOf,
} from './phone';

export interface TimelineSheets {
  phone: boolean;
  decisionId: string | null;
  stepsTurnId: string | null;
  inspectTurnId: string | null;
  open: (kind: SheetKind, id: string, mode?: 'push' | 'replace') => void;
  close: () => void;
}

/** URL-backed sheets. Back pops the entry and stays on the Thread. */
export function useTimelineSheets(): TimelineSheets {
  const phone = !usePersistentNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const opener = useRef<HTMLElement | null>(null);
  const decisionId = searchParams.get('decision');
  const stepsTurnId = searchParams.get('steps');
  const inspectTurnId = searchParams.get('inspect');
  const open = (kind: SheetKind, id: string, mode: 'push' | 'replace' = 'push') => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const search = openSheetSearch(searchParams.toString(), kind, id);
    const next = nextSheetDepth(sheetDepthOf(history.state));
    navigate(
      { pathname: location.pathname, search },
      {
        replace: mode === 'replace' || next.mode === 'replace',
        state: { okSheet: kind, sheetDepth: next.depth },
      }
    );
  };
  const close = () => {
    const state = history.state as { usr?: { okSheet?: string }; okSheet?: string } | null;
    if (state?.usr?.okSheet || state?.okSheet) {
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
    if (sheetDepthOf(state) > 0 || state?.usr?.okSheet || state?.okSheet) return;
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
      { state: { okSheet: kind, sheetDepth: 1 } }
    );
  }, [
    decisionId,
    inspectTurnId,
    location.pathname,
    location.search,
    navigate,
    searchParams,
    stepsTurnId,
  ]);
  useEffect(() => {
    if (decisionId || stepsTurnId || inspectTurnId) return;
    const target = opener.current;
    if (!target) return;
    opener.current = null;
    target.focus();
  }, [decisionId, inspectTurnId, stepsTurnId]);
  return { phone, decisionId, stepsTurnId, inspectTurnId, open, close };
}

/** Sticky Now and Needs you line. Tapping opens the next decision. */
export function PhoneBar({
  now,
  needsCount,
  reducedMotion,
  onOpen,
}: {
  now: NowModel;
  needsCount: number;
  reducedMotion: boolean;
  onOpen?: () => void;
}) {
  const nowText = now.kind === 'hidden' ? null : now.text;
  const label = phoneBarLabel(nowText, needsCount);
  if (!label) return null;
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
      <p data-phone-bar="true" className={className}>
        {body}
      </p>
    );
  }
  return (
    <button type="button" data-phone-bar="true" className={className} onClick={onOpen}>
      {body}
    </button>
  );
}

export function PhoneSheetFrame({
  label,
  mode,
  expanded,
  onExpand,
  onClose,
  children,
  footer,
}: {
  label: string;
  mode: 'full' | 'partial';
  expanded?: boolean;
  onExpand?: () => void;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const full = mode === 'full' || expanded === true;
  return (
    <div className="fixed inset-0 z-40 flex flex-col">
      {mode === 'partial' && !full ? <div className="min-h-0 flex-1" aria-hidden="true" /> : null}
      <div
        role="dialog"
        aria-label={label}
        data-sheet={mode}
        data-expanded={full ? 'true' : 'false'}
        className={`flex flex-col bg-layer-1 shadow-ok-modal ${full ? 'h-full' : 'h-[60vh] rounded-t-ok-xl border border-separator'}`}
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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposeTestStore } from './test-support/store.js';
import {
  createEarlierPageCorpus,
  EARLIER_PAGE_HEADERS,
  EARLIER_PAGE_ITEMS,
  type EarlierPageCorpus,
} from './test-support/thread-timeline-earlier.fixture.js';

const PAGE_ITEMS = 50;
const PAGE_RUNS = 31;
const RESPONSE_BYTES = 262_144;
/** Cooperative eligibility chunks yield well inside this bound; one synchronous pass does not. */
const EVENT_LOOP_TURN = 50;

let corpus: EarlierPageCorpus;

beforeAll(async () => {
  corpus = await createEarlierPageCorpus();
}, 180_000);

afterAll(async () => {
  if (corpus) await disposeTestStore(corpus.root);
});

async function post(operation: string, body: Record<string, unknown>) {
  const response = await corpus.app.request(`/api/app/operations/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, bytes: Buffer.byteLength(text), text };
}

describe(`Earlier page during a receipt write on a ${EARLIER_PAGE_HEADERS}-header / ${EARLIER_PAGE_ITEMS}-Item Thread`, () => {
  it('serves the real older page while a displayed-only Mark read is still scanning eligibility', async () => {
    const selector = { workspaceId: corpus.workspaceId, threadId: corpus.threadId };
    const displayed = corpus.itemIds.slice(-PAGE_ITEMS);

    // The quiet first page fixes the exact older-run identities this Thread must answer with.
    const first = await post('thread.timeline', selector);
    expect(first.status, first.text.slice(0, 400)).toBe(200);
    const newest = JSON.parse(first.text) as {
      runs: Array<{ id: string; admissionOrder: number }>;
      beforeCursor: string | null;
    };
    expect(newest.runs).toHaveLength(PAGE_RUNS);
    const expectedOlder = corpus.headerIds.slice(
      newest.runs[0]!.admissionOrder - PAGE_RUNS - 1,
      newest.runs[0]!.admissionOrder - 1
    );

    // Probe only receipt work, before the separately bounded Earlier reader is issued.
    const started = performance.now();
    let settled = false;
    const receipt = post('thread.mark-read', { ...selector, itemIds: displayed }).then((result) => {
      settled = true;
      return result;
    });
    try {
      // Let the receipt operation enter its eligibility scan before Earlier arrives.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const firstTurn = performance.now() - started;
      expect(
        firstTurn,
        `one event-loop turn was blocked for ${Math.round(firstTurn)} ms during the receipt write`
      ).toBeLessThanOrEqual(EVENT_LOOP_TURN);
      const earlier = await post('thread.timeline', { ...selector, cursor: newest.beforeCursor! });

      expect(earlier.status, earlier.text.slice(0, 400)).toBe(200);
      expect(earlier.bytes).toBeLessThanOrEqual(RESPONSE_BYTES);
      const older = JSON.parse(earlier.text) as {
        runs: Array<{ id: string; admissionOrder: number }>;
      };
      expect(older.runs).toHaveLength(PAGE_RUNS);
      expect(older.runs.map((run) => run.id)).toEqual(expectedOlder);
      // The page reached the App while the receipt write was still scanning the Thread.
      expect(settled, 'Earlier page waited for the whole receipt scan').toBe(false);
      const marked = await receipt;

      // The receipt still records every displayed identity against the complete eligible set.
      expect(marked.status, marked.text.slice(0, 400)).toBe(200);
      const state = await post('thread.read-state', selector);
      expect(state.status, state.text.slice(0, 400)).toBe(200);
      const body = JSON.parse(state.text) as { readItemIds: string[]; unreadItemIds: string[] };
      expect(new Set(body.readItemIds)).toEqual(new Set(displayed));
      expect(new Set(body.unreadItemIds)).toEqual(
        new Set(corpus.itemIds.slice(0, EARLIER_PAGE_ITEMS - PAGE_ITEMS))
      );
    } finally {
      await receipt;
    }
  }, 180_000);
});

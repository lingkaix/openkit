import { allocateEntityId } from '@openkit/protocol';
import { expect, it } from 'vitest';
import {
  clearDisplayedTimeline,
  getDisplayedTimeline,
  publishDisplayedTimeline,
  subscribeDisplayedTimeline,
} from './displayed-timeline';

// SF3: the React external-store snapshot cannot change silently for an equivalent payload.
// Tickets still identify distinct stream claims; an old cleanup must not clear a newer claim.
it('SF3 keeps an equivalent displayed snapshot stable or notifies its replacement', () => {
  const payload = {
    workspaceId: allocateEntityId('ws'),
    threadId: allocateEntityId('th'),
    data: null,
  };
  let notifications = 0;
  const unsubscribe = subscribeDisplayedTimeline(() => {
    notifications += 1;
  });
  const tickets: ReturnType<typeof publishDisplayedTimeline>[] = [];
  try {
    const first = publishDisplayedTimeline(payload);
    tickets.push(first);
    const before = getDisplayedTimeline();
    expect(before).toMatchObject(payload);
    const notificationsBefore = notifications;

    // A fresh input object carries exactly the same Workspace, Thread and data reference.
    const second = publishDisplayedTimeline({ ...payload });
    tickets.push(second);
    const after = getDisplayedTimeline();
    const notificationsAfter = notifications;
    expect(after).toMatchObject(payload);
    expect(second, 'Equivalent payloads still need independent ownership tickets').not.toBe(first);

    // These controls must not contribute notifications to the earlier replacement decision.
    clearDisplayedTimeline(first);
    expect(
      getDisplayedTimeline(),
      'An obsolete owner must not clear the newer claim'
    ).toMatchObject(payload);
    clearDisplayedTimeline(second);
    expect(getDisplayedTimeline()).toBeNull();

    expect(
      Object.is(before, after) || notificationsAfter > notificationsBefore,
      'An equivalent displayed payload must keep snapshot identity or notify its replacement'
    ).toBe(true);
  } finally {
    for (const ticket of tickets) clearDisplayedTimeline(ticket);
    unsubscribe();
  }
});

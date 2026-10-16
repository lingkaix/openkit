import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { findAssistantTimeline, openAssistantTimeline } from './assistant-timeline.js';

describe('Assistant Timeline selection', () => {
  it('keeps the earliest retained conversation as the Timeline without merging or deleting history', () => {
    const store = new FsStore();
    const workspace = store.createWorkspace('Retained work');
    const first = store.createThread(workspace.id, 'Original', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'first-user',
    });
    const later = store.createThread(workspace.id, 'Later history', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'first-user',
    });
    store.createThread(workspace.id, 'Administration', undefined, 'administration', {
      visibility: 'private',
      privateOwnerUserId: 'first-user',
    });
    store.createThread(workspace.id, 'Other user', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'other-user',
    });
    store.createThread(workspace.id, 'Shared Task');

    expect(openAssistantTimeline(store, workspace.id, 'first-user', 'Replacement')).toEqual(first);
    expect(store.getThread(workspace.id, later.id)).toEqual(later);
    expect(store.listThreads(workspace.id)).toHaveLength(5);
  });

  it('preserves an archived Timeline until an explicit Thread update reopens it', () => {
    const store = new FsStore();
    const workspace = store.createWorkspace('Archived work');
    const timeline = openAssistantTimeline(store, workspace.id, 'first-user', 'Assistant');
    store.archiveThread(workspace.id, timeline.id);

    expect(openAssistantTimeline(store, workspace.id, 'first-user', 'New name')).toMatchObject({
      id: timeline.id,
      name: 'Assistant',
      status: 'archived',
    });
    expect(store.listThreads(workspace.id)).toHaveLength(1);
    store.updateThread(workspace.id, timeline.id, { status: 'active' });
    expect(findAssistantTimeline(store, workspace.id, 'first-user')).toMatchObject({
      id: timeline.id,
      status: 'active',
    });
  });
});

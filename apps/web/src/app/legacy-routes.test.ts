import { describe, expect, it } from 'vitest';
import { legacyTarget } from './legacy-routes';

describe('legacyTarget', () => {
  it('maps each retired address to its current route, keeping search and hash', () => {
    expect(legacyTarget('/chat', '?x=1', '#a')).toEqual({ to: '/assistant?x=1#a' });
    expect(legacyTarget('/attention', '?workspaceId=w')).toEqual({
      to: '/needs-you?workspaceId=w',
    });
    expect(legacyTarget('/chat/w-1/t-1', '?turnId=u')).toEqual({
      to: '/w/w-1/t/t-1?turnId=u',
      state: { threadActivity: 'chat' },
    });
    expect(legacyTarget('/tasks/w-1/t-1')).toEqual({
      to: '/w/w-1/t/t-1',
      state: { threadActivity: 'task' },
    });
    expect(legacyTarget('/goals/w-1/t-1', '?card=c')).toEqual({
      to: '/w/w-1/t/t-1?card=c',
      state: { threadActivity: 'goal' },
    });
    expect(legacyTarget('/goals/w-1/t-1/artifacts/a-1')).toEqual({
      to: '/w/w-1/t/t-1/artifacts/a-1',
      state: { threadActivity: 'goal' },
    });
  });

  it('copies encoded segments without decoding them', () => {
    expect(legacyTarget('/tasks/w%2F1/t%252F')?.to).toBe('/w/w%2F1/t/t%252F');
  });

  it('accepts the letter case and trailing slashes the old routes accepted', () => {
    expect(legacyTarget('/chat/w-1/t-1/', '?item=fixture', '#anchor')).toEqual({
      to: '/w/w-1/t/t-1?item=fixture#anchor',
      state: { threadActivity: 'chat' },
    });
    expect(legacyTarget('/Tasks/w-1/t-1')).toEqual({
      to: '/w/w-1/t/t-1',
      state: { threadActivity: 'task' },
    });
    expect(legacyTarget('/goals/w%2F1/t%3F/artifacts/a%23/', '?v=2', '#h')).toEqual({
      to: '/w/w%2F1/t/t%3F/artifacts/a%23?v=2#h',
      state: { threadActivity: 'goal' },
    });
    expect(legacyTarget('/GOALS/w-1/t-1/Artifacts/a-1')).toEqual({
      to: '/w/w-1/t/t-1/artifacts/a-1',
      state: { threadActivity: 'goal' },
    });
    expect(legacyTarget('/Chat/', '?x=1')).toEqual({ to: '/assistant?x=1' });
    expect(legacyTarget('/ATTENTION//')).toEqual({ to: '/needs-you' });
  });

  it('returns null for current routes and unknown tails', () => {
    expect(legacyTarget('/assistant')).toBeNull();
    expect(legacyTarget('/w/w-1/t/t-1')).toBeNull();
    expect(legacyTarget('/tasks/w-1/t-1/artifacts/a-1')).toBeNull();
    expect(legacyTarget('/goals/w-1/t-1/other/a-1')).toBeNull();
    expect(legacyTarget('/chat/w-1')).toBeNull();
  });
});

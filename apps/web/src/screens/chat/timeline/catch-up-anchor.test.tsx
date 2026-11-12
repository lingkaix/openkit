import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CatchUpDivider } from './CatchUpDivider';
import { timelineCopy } from './copy';
import { anchorFromSearch } from './window';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
}

describe('catch-up anchor link', () => {
  it('opens the catch-up entry on the catch-up anchor', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/tasks/ws/th?turn=tu_1&item=it_1']}>
        <CatchUpDivider count={0} onEarlierUnread={() => undefined} digest={null} />
        <LocationProbe />
      </MemoryRouter>
    );
    await user.click(screen.getByRole('link', { name: timelineCopy.newSinceHere }));
    const href = screen.getByTestId('loc').textContent ?? '';
    expect(anchorFromSearch(href.slice(href.indexOf('?')))).toEqual({ kind: 'catch-up' });
    expect(href).not.toContain('item=');
  });
});

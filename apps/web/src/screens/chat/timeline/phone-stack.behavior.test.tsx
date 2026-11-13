import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useTimelineSheets } from './PhoneChrome';

function StackHarness() {
  const sheets = useTimelineSheets();
  const top = sheets.inspectTurnId
    ? 'inspect'
    : sheets.stepsTurnId
      ? 'steps'
      : sheets.decisionId
        ? 'decision'
        : 'none';
  const stepsOpen = Boolean(sheets.stepsTurnId || sheets.under?.kind === 'steps');
  return (
    <>
      <button type="button" onClick={() => sheets.open('steps', 'tu_1')}>
        Open steps
      </button>
      {stepsOpen ? (
        <button type="button" onClick={() => sheets.open('inspect', 'tu_1')}>
          Inspect
        </button>
      ) : null}
      <button type="button" onClick={() => sheets.close()}>
        Back
      </button>
      <p data-top={top} data-under={sheets.under?.kind ?? 'none'}>
        {top}
      </p>
    </>
  );
}

describe('two-deep phone sheets', () => {
  it('closes only the top sheet and returns focus to the control that opened it', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StackHarness />
      </MemoryRouter>
    );
    await user.click(screen.getByRole('button', { name: 'Open steps' }));
    const status = screen.getByRole('paragraph');
    expect(status).toHaveAttribute('data-top', 'steps');
    expect(status).toHaveAttribute('data-under', 'none');

    const inspect = screen.getByRole('button', { name: 'Inspect' });
    await user.click(inspect);
    expect(status).toHaveAttribute('data-top', 'inspect');
    expect(status).toHaveAttribute('data-under', 'steps');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(status).toHaveAttribute('data-top', 'steps');
    expect(status).toHaveAttribute('data-under', 'none');
    expect(screen.getByRole('button', { name: 'Inspect' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(status).toHaveAttribute('data-top', 'none');
    expect(screen.getByRole('button', { name: 'Open steps' })).toHaveFocus();
  });
});

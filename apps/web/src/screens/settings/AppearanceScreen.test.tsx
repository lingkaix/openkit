import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useThemeStore } from '../../app/theme-store';
import { AppearanceScreen } from './AppearanceScreen';

/** A client whose every member access is recorded, so any server read is visible. */
function recordingClient(accessed: string[]): CoreClient {
  const record = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'then') return undefined;
        const next = `${path}.${String(key)}`;
        accessed.push(next);
        return record(next);
      },
      apply: () => {
        accessed.push(`${path}()`);
        return Promise.reject(new Error(`Appearance read ${path}`));
      },
    });
  return record('client') as CoreClient;
}

function renderAppearance(path: string, accessed: string[]) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CoreClientProvider client={recordingClient(accessed)}>
        <MemoryRouter initialEntries={[path]}>
          <AppearanceScreen />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

describe('Appearance (WEB-UX A0, principle P14)', () => {
  it('shows the theme control and a live preview, with All components collapsed', async () => {
    const accessed: string[] = [];
    renderAppearance('/settings/appearance', accessed);

    expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument();
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(within(preview).getByRole('button', { name: 'Approve plan' })).toBeInTheDocument();
    expect(within(preview).getByText('Approve the plan?')).toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: 'All components' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('heading', { name: 'Buttons' })).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('heading', { name: 'Buttons' })).toBeInTheDocument();
    expect(accessed).toEqual([]);
  });

  it('opens every specimen group and the native Generative UI catalog from the deep link', async () => {
    const accessed: string[] = [];
    renderAppearance('/settings/appearance/components', accessed);

    expect(screen.getByRole('button', { name: 'All components' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    const generative = await screen.findByRole('region', { name: 'Generative UI' });
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    ).toEqual([
      'Mode',
      'Style',
      'Foundations',
      'Actions',
      'Fields',
      'Navigation',
      'Overlays',
      'Data',
      'Feedback',
      'Conversation',
      'Work',
      'Generative UI',
    ]);
    expect(within(generative).getByText('Weekly pricing refresh')).toBeInTheDocument();
    const list = within(generative).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list.querySelectorAll(':scope > :not(li)')).toHaveLength(0);
    expect(within(generative).getByRole('textbox', { name: 'Run at' })).toHaveValue('09:00');
    expect(within(generative).getByRole('switch', { name: 'Email me a summary' })).toBeChecked();
    const save = within(generative).getByRole('button', { name: 'Save schedule' });
    // The label inherits the on-accent color and stays valid phrasing content.
    expect(save.querySelector('p, .text-fg')).toBeNull();
    expect(accessed).toEqual([]);
  });

  it('previews light beside dark without changing the persisted choice', async () => {
    const accessed: string[] = [];
    useThemeStore.setState({ theme: 'system' });
    renderAppearance('/settings/appearance/components', accessed);

    const foundations = await screen.findByRole('region', { name: 'Foundations' });
    expect(foundations.querySelector('.ok-scheme-light')).not.toBeNull();
    expect(foundations.querySelector('.ok-scheme-dark')).not.toBeNull();

    const buttons = screen.getByRole('heading', { level: 4, name: 'Buttons' }).parentElement!;
    expect(within(buttons).getAllByRole('button', { name: 'Approve plan' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('switch', { name: 'Light and dark side by side' }));
    const panes = within(buttons).getAllByRole('button', { name: 'Approve plan' });
    expect(panes).toHaveLength(2);
    expect(panes[0]!.closest('.ok-scheme-light')).not.toBeNull();
    expect(panes[1]!.closest('.ok-scheme-dark')).not.toBeNull();
    expect(useThemeStore.getState().theme).toBe('system');
    expect(accessed).toEqual([]);
  });
});

import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { isSurfaceLive } from '../../app/flags';
import { surfaceById } from '../../app/surfaces';
import { A2UI_CATALOG, isWhitelisted } from './catalog';
import catalogSource from './catalog.tsx?raw';
import { FALLBACK_SAMPLE, READY_SAMPLE, unknownComponentDocument } from './fixtures';
import { GenerativeScreen } from './GenerativeScreen';
import screenSource from './GenerativeScreen.tsx?raw';
import { A2UIRenderer, PlainContentFallback, renderA2UINode } from './render';
import renderSource from './render.tsx?raw';
import { resolveRenderState } from './states';
import statesSource from './states.ts?raw';

/** Minimal client — generative shell uses fixtures only. */
function makeClient(): CoreClient {
  return {
    app: {
      listAuthorizedWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [] } satisfies Awaited<
          ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>
        >),
    },
    core: {
      meta: vi.fn().mockResolvedValue({}),
    },
  } as unknown as CoreClient;
}

function Providers({ children, path }: { children: ReactNode; path: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

/** Concatenated generative-shell module sources for safety scanning. */
const SHELL_SOURCES = [catalogSource, renderSource, screenSource, statesSource].join('\n');

describe('WP-9 generative surface — unpublished render shell', () => {
  it('keeps generative Tier C and not live', () => {
    const surface = surfaceById('generative');
    expect(surface).toBeDefined();
    expect(surface?.tier).toBe('C');
    expect(surface?.board).toBe('13');
    expect(surface?.wp).toBe('WP-9');
    expect(isSurfaceLive(surface!)).toBe(false);
  });
});

describe('WP-9 three-state render model', () => {
  it('resolves streaming when streaming flag is set', () => {
    expect(resolveRenderState({ streaming: true, document: READY_SAMPLE })).toBe('streaming');
  });

  it('resolves ready for a fully whitelisted document', () => {
    expect(resolveRenderState({ streaming: false, document: READY_SAMPLE })).toBe('ready');
  });

  it('resolves fallback when any node type is unknown', () => {
    expect(resolveRenderState({ streaming: false, document: FALLBACK_SAMPLE })).toBe('fallback');
  });

  it('streaming state shows skeleton', () => {
    render(<A2UIRenderer state="streaming" document={READY_SAMPLE} />);
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });

  it('ready state renders whitelisted sample (card + button labels)', () => {
    render(<A2UIRenderer state="ready" document={READY_SAMPLE} />);
    expect(screen.getByText('Weekly pricing refresh')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Create automation')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('unknown component type shows plain content fallback, never an error card', () => {
    const { container } = render(
      <A2UIRenderer state="fallback" document={unknownComponentDocument} />
    );
    expect(screen.getByText(/chart type that isn't in the OpenKit catalog/i)).toBeInTheDocument();
    expect(screen.getByText(/Northwind/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(container.querySelector('[data-a2ui-fallback]')).not.toBeNull();
  });

  it('renderA2UINode degrades unknown types to PlainContentFallback', () => {
    const { container } = render(
      <div>{renderA2UINode({ type: 'ExoticWidget', content: 'plain payload only' })}</div>
    );
    expect(screen.getByText('plain payload only')).toBeInTheDocument();
    expect(container.querySelector('[data-a2ui-fallback]')).not.toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('WP-9 whitelist catalog', () => {
  it('whitelists only OpenKit primitives used by the sample', () => {
    expect(isWhitelisted('Card')).toBe(true);
    expect(isWhitelisted('Button')).toBe(true);
    expect(isWhitelisted('ItemCard')).toBe(true);
    expect(isWhitelisted('StatusChip')).toBe(true);
    expect(isWhitelisted('Switch')).toBe(true);
    expect(isWhitelisted('Select')).toBe(true);
    expect(isWhitelisted('TextField')).toBe(true);
    expect(isWhitelisted('Text')).toBe(true);
    expect(isWhitelisted('Chart')).toBe(false);
    expect(isWhitelisted('EmbeddedFrame')).toBe(false);
    expect(Object.keys(A2UI_CATALOG).length).toBeGreaterThan(0);
  });
});

describe('WP-9 no arbitrary-code / no iframe path', () => {
  it('shell modules do not contain iframe tags, eval, Function(, or script injection', () => {
    expect(SHELL_SOURCES).not.toMatch(/<iframe\b/i);
    expect(SHELL_SOURCES).not.toMatch(/createElement\(\s*['"]iframe['"]/i);
    expect(SHELL_SOURCES).not.toMatch(/\beval\s*\(/);
    expect(SHELL_SOURCES).not.toMatch(/\bnew\s+Function\s*\(/);
    expect(SHELL_SOURCES).not.toMatch(/\bFunction\s*\(/);
    expect(SHELL_SOURCES).not.toMatch(/dangerouslySetInnerHTML/);
    expect(SHELL_SOURCES).not.toMatch(/<script\b/i);
  });

  it('PlainContentFallback renders text only', () => {
    const { container } = render(<PlainContentFallback content={'safe plain text'} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText('safe plain text')).toBeInTheDocument();
  });
});

describe('WP-9 GenerativeScreen demo composition', () => {
  it('shows all three states on the demo page', () => {
    render(
      <Providers path="/generative">
        <GenerativeScreen />
      </Providers>
    );
    expect(screen.getByRole('heading', { name: 'Generative UI' })).toBeInTheDocument();
    expect(screen.getByText(/streaming skeleton/i)).toBeInTheDocument();
    expect(screen.getByText(/rendered · whitelist/i)).toBeInTheDocument();
    expect(screen.getByText(/plain-content fallback/i)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
    expect(screen.getByText('Weekly pricing refresh')).toBeInTheDocument();
    expect(screen.getByText('Create automation')).toBeInTheDocument();
    expect(screen.getByText(/Automation created/i)).toBeInTheDocument();
  });
});

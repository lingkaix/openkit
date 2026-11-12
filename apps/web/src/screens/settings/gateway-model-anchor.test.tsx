import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { hrefOf, resolve } from '../chat/timeline/resolve';
import { GatewayConfiguration } from './GatewayConfiguration';

const VIEW_HEIGHT = 240;

function model(id: string, displayName: string) {
  return { id, displayName, capabilities: [], autoFailover: false, routes: [] };
}

const diagnostics = {
  providers: { registry: [] },
  gateway: {
    defaultModelId: 'near',
    titleModelId: null,
    transcription: null,
    models: [model('near', 'Near model'), model('far', 'Far model')],
  },
} as never;

const client = {
  operations: new Proxy({}, { get: () => () => Promise.reject(new Error('unused')) }),
} as unknown as CoreClient;

function OpenModel({ id }: { id: string }) {
  const href = hrefOf(resolve({ kind: 'gateway', logicalModelId: id }));
  return <Link to={href ?? '/settings/gateway'}>Open model</Link>;
}

function renderGateway(initial: string) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route path="/from" element={<OpenModel id="far" />} />
            <Route
              path="/settings/gateway"
              element={
                <GatewayConfiguration
                  client={client}
                  disconnected={false}
                  diagnostics={diagnostics}
                  onChanged={() => undefined}
                />
              }
            />
          </Routes>
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

describe('Gateway model anchor', () => {
  const original = HTMLElement.prototype.scrollIntoView;

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = original;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  });

  it('opens the Gateway page with that model row in the viewport and focused', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEW_HEIGHT });
    HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
      const top = 32;
      const height = 64;
      this.getBoundingClientRect = () => ({
        x: 0,
        y: top,
        top,
        left: 0,
        right: 180,
        bottom: top + height,
        width: 180,
        height,
        toJSON() {
          return {};
        },
      });
    };
    renderGateway('/from');
    await user.click(screen.getByRole('link', { name: 'Open model' }));
    const row = await screen.findByRole('region', { name: 'Far model' });
    expect(document.activeElement).toBe(row);
    expect(row.id).toBe('gateway-model-far');
    const box = row.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(document.activeElement).not.toBe(screen.getByRole('region', { name: 'Near model' }));
  });

  it('says the model is not listed and does not focus another model', async () => {
    renderGateway('/settings/gateway?model=missing');
    expect(await screen.findByRole('status')).toHaveTextContent('That model is not listed.');
    expect(document.activeElement).not.toBe(screen.getByRole('region', { name: 'Near model' }));
    expect(document.activeElement).not.toBe(screen.getByRole('region', { name: 'Far model' }));
  });
});

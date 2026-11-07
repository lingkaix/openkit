import type { KnowledgeClient, KnowledgeNode } from '@openkit/knowledge-ui';
import { KnowledgeBrowser } from '@openkit/knowledge-ui';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

const UPDATED_AT = '2026-03-04T09:41:00.000Z';
const IMAGE_CONTENT_URL = '/api/knowledge/content/floor-plan';
const PDF_CONTENT_URL = '/api/knowledge/content/handbook';

/** Builds one shared knowledge node with the fields the A3 client contract defines. */
function knowledgeNode(
  input: Pick<KnowledgeNode, 'id' | 'title'> & Partial<Omit<KnowledgeNode, 'id' | 'title'>>
): KnowledgeNode {
  return {
    kind: 'page',
    mediaType: 'text/markdown',
    parentId: null,
    updatedAt: null,
    ...input,
  };
}

/** Returns a client whose methods are stubbed unless the test supplies its own fake. */
function knowledgeClient(overrides: Partial<KnowledgeClient> = {}): KnowledgeClient {
  return {
    list: async () => ({ nodes: [], nextCursor: null }),
    read: async () => {
      throw new Error('The read method is not stubbed for this test.');
    },
    search: async () => ({ nodes: [], nextCursor: null }),
    saveText: async () => ({ version: 'unused-version' }),
    importFile: async () => knowledgeNode({ id: 'imported', title: 'Imported' }),
    ...overrides,
  };
}

describe('KnowledgeBrowser list', () => {
  it('renders a Pages list of titled rows, the updated time, and no earlier page without a cursor', async () => {
    const dated = knowledgeNode({
      id: 'reading-room',
      title: 'Reading room opening hours',
      updatedAt: UPDATED_AT,
    });
    const undated = knowledgeNode({ id: 'undated', title: 'Undated page' });
    const list = vi.fn(async () => ({ nodes: [dated, undated], nextCursor: null }));
    render(<KnowledgeBrowser client={knowledgeClient({ list })} parentId={null} />);

    const pages = await screen.findByRole('list', { name: 'Pages' });
    const datedButton = await within(pages).findByRole('button', {
      name: 'Reading room opening hours',
    });
    expect(datedButton).toBeVisible();

    const datedRow = datedButton.closest('li') ?? datedButton.parentElement;
    expect(datedRow).toHaveTextContent('2026');

    const undatedButton = within(pages).getByRole('button', { name: 'Undated page' });
    const undatedRow = undatedButton.closest('li') ?? undatedButton.parentElement;
    expect(undatedRow).not.toHaveTextContent('2026');

    expect(screen.queryByText(/^(Load earlier|Load more|Next)$/)).not.toBeInTheDocument();
  });

  it('offers Load earlier only for a real cursor and passes that cursor to list', async () => {
    const user = userEvent.setup();
    const newest = knowledgeNode({ id: 'newest', title: 'Newest page' });
    const older = knowledgeNode({ id: 'older', title: 'Older page' });
    const list = vi.fn(async (_parentId: string | null, cursor?: string) =>
      cursor === 'cursor-2'
        ? { nodes: [older], nextCursor: null }
        : { nodes: [newest], nextCursor: 'cursor-2' }
    );
    render(<KnowledgeBrowser client={knowledgeClient({ list })} parentId={null} />);

    const loadEarlier = await screen.findByRole('button', { name: 'Load earlier' });
    await user.click(loadEarlier);

    expect(list).toHaveBeenLastCalledWith(null, 'cursor-2');
    expect(await screen.findByRole('button', { name: 'Older page' })).toBeVisible();
  });
});

describe('KnowledgeBrowser preview', () => {
  it('shows the body returned by read when a page opens', async () => {
    const user = userEvent.setup();
    const page = knowledgeNode({ id: 'page-1', title: 'Reading room opening hours' });
    const body = 'The reading room opens at 09:00 on weekdays.';
    const read = vi.fn(async () => ({ node: page, body, version: 'rev-1' }));
    const list = async () => ({ nodes: [page], nextCursor: null });
    render(<KnowledgeBrowser client={knowledgeClient({ list, read })} parentId={null} />);

    await user.click(await screen.findByRole('button', { name: page.title }));

    expect(await screen.findByText(body)).toBeVisible();
  });

  it('uses the host content URL for an image and never the body as the image source', async () => {
    const user = userEvent.setup();
    const image = knowledgeNode({
      id: 'floor-plan',
      title: 'Floor plan',
      kind: 'file',
      mediaType: 'image/png',
    });
    const body = 'data:image/png;base64,AAAA';
    const read = vi.fn(async () => ({
      node: image,
      body,
      version: 'v1',
      contentUrl: IMAGE_CONTENT_URL,
    }));
    const list = async () => ({ nodes: [image], nextCursor: null });
    render(<KnowledgeBrowser client={knowledgeClient({ list, read })} parentId={null} />);

    await user.click(await screen.findByRole('button', { name: image.title }));

    const renderedImage = await screen.findByRole('img');
    expect(renderedImage).toHaveAttribute('src', IMAGE_CONTENT_URL);
    expect(renderedImage.getAttribute('src')).not.toContain('base64');
  });

  it('offers Download for a PDF preview', async () => {
    const user = userEvent.setup();
    const pdf = knowledgeNode({
      id: 'handbook',
      title: 'Handbook',
      kind: 'file',
      mediaType: 'application/pdf',
    });
    const read = vi.fn(async () => ({
      node: pdf,
      body: null,
      version: 'v1',
      contentUrl: PDF_CONTENT_URL,
    }));
    const list = async () => ({ nodes: [pdf], nextCursor: null });
    render(<KnowledgeBrowser client={knowledgeClient({ list, read })} parentId={null} />);

    await user.click(await screen.findByRole('button', { name: pdf.title }));

    const links = screen.queryAllByRole('link', { name: 'Download' });
    const buttons = screen.queryAllByRole('button', { name: 'Download' });
    expect(links.length + buttons.length).toBe(1);
  });
});

describe('KnowledgeBrowser search', () => {
  it('shows the snippet returned for the typed search query', async () => {
    const user = userEvent.setup();
    const page = knowledgeNode({ id: 'page-1', title: 'Reading room opening hours' });
    const snippet = 'The reading room opens at 09:00 on weekdays.';
    const search = vi.fn(async (query: string) =>
      query === 'reading'
        ? { nodes: [{ node: page, snippet }], nextCursor: null }
        : { nodes: [], nextCursor: null }
    );
    render(<KnowledgeBrowser client={knowledgeClient({ search })} parentId={null} />);

    const field = await screen.findByRole('textbox', { name: 'Search' });
    await user.type(field, 'reading{Enter}');

    expect(await screen.findByText(snippet)).toBeVisible();
    expect(search.mock.calls.some(([query]) => query === 'reading')).toBe(true);
  });
});

describe('KnowledgeBrowser editing', () => {
  it('edits an open text page and saves with the version read returned', async () => {
    const user = userEvent.setup();
    const page = knowledgeNode({ id: 'page-1', title: 'Reading room opening hours' });
    const read = vi.fn(async () => ({ node: page, body: 'Original body.', version: 'rev-1' }));
    const saveText = vi.fn(async () => ({ version: 'rev-2' }));
    const list = async () => ({ nodes: [page], nextCursor: null });
    render(<KnowledgeBrowser client={knowledgeClient({ list, read, saveText })} parentId={null} />);

    await user.click(await screen.findByRole('button', { name: page.title }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const editor = await screen.findByRole('textbox', { name: 'Page body' });
    expect(editor).toHaveValue('Original body.');
    await user.clear(editor);
    await user.type(editor, 'Updated body.');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveText).toHaveBeenCalledWith('page-1', 'Updated body.', 'rev-1');
  });

  it('shows the current version when save reports a version conflict', async () => {
    const user = userEvent.setup();
    const page = knowledgeNode({ id: 'page-1', title: 'Reading room opening hours' });
    const read = vi.fn(async () => ({ node: page, body: 'Original body.', version: 'rev-1' }));
    const saveText = vi
      .fn()
      .mockRejectedValueOnce({ kind: 'version-conflict', currentVersion: 'rev-9' });
    const list = async () => ({ nodes: [page], nextCursor: null });
    render(<KnowledgeBrowser client={knowledgeClient({ list, read, saveText })} parentId={null} />);

    await user.click(await screen.findByRole('button', { name: page.title }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('textbox', { name: 'Page body' });

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/rev-9/)).toBeVisible();
  });
});

describe('KnowledgeBrowser import', () => {
  it('passes the chosen File object to importFile', async () => {
    const user = userEvent.setup();
    const importFile = vi.fn(async () => knowledgeNode({ id: 'imported', title: 'Imported' }));
    render(<KnowledgeBrowser client={knowledgeClient({ importFile })} parentId={null} />);

    const input = await screen.findByLabelText('Import file');
    expect(input).toBeInstanceOf(HTMLInputElement);
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    await user.upload(input as HTMLInputElement, file);

    expect(importFile).toHaveBeenCalledWith(null, file);
  });
});

describe('KnowledgeBrowser phone preview', () => {
  it('keeps the host extension in the preview when the phone list is hidden', async () => {
    const user = userEvent.setup();
    const original = window.matchMedia;
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: query === '(max-width: 799px)',
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
        addListener: () => undefined,
        removeListener: () => undefined,
      }) as MediaQueryList;
    const page = knowledgeNode({ id: 'page-1', title: 'Alpha note' });
    const read = vi.fn(async () => ({ node: page, body: 'Alpha note body.', version: 'rev-1' }));
    const list = async () => ({ nodes: [page], nextCursor: null });
    try {
      render(
        <KnowledgeBrowser
          client={knowledgeClient({ list, read })}
          parentId={null}
          extensions={{
            node: (node) => <span>Host controls for {node.title}</span>,
          }}
        />
      );
      await screen.findByRole('button', { name: 'Search' });
      await user.click(await screen.findByRole('button', { name: 'Alpha note' }));
      const preview = await screen.findByRole('article', { name: 'Preview' });
      expect(within(preview).getByText('Host controls for Alpha note')).toBeVisible();
      expect(within(preview).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
      expect(within(preview).queryByText('Alpha note body.')).not.toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('KnowledgeBrowser extensions', () => {
  it('renders the node extension only when the host passes it', async () => {
    const page = knowledgeNode({ id: 'page-1', title: 'Reading room opening hours' });
    const list = async () => ({ nodes: [page], nextCursor: null });
    const { unmount } = render(
      <KnowledgeBrowser
        client={knowledgeClient({ list })}
        parentId={null}
        extensions={{
          node: (node) => <span>Host extension for {node.title}</span>,
        }}
      />
    );

    expect(await screen.findByText('Host extension for Reading room opening hours')).toBeVisible();

    unmount();
    render(<KnowledgeBrowser client={knowledgeClient({ list })} parentId={null} />);

    expect(await screen.findByRole('list', { name: 'Pages' })).toBeVisible();
    expect(screen.queryByText(/Host extension for/)).not.toBeInTheDocument();
  });
});

import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AssistantMessage, UserMessage } from './Message';

const MARKDOWN_BODY = [
  '# Title',
  '',
  '- bullet',
  '',
  '1. numbered',
  '',
  'Use `inline` code.',
  '',
  '```',
  'fenced()',
  '```',
  '',
  '    indented()',
  '',
  '| Col | Val |',
  '| --- | --- |',
  '| a | b |',
].join('\n');

/** Renders one assistant message with the shared identity fixtures. */
function renderAssistant(children: ReactNode) {
  return render(
    <AssistantMessage hue="scout" initials="SC" author="Scout">
      {children}
    </AssistantMessage>
  );
}

describe('AssistantMessage markdown', () => {
  it('renders headings, lists, inline and fenced code, and tables as semantic DOM', () => {
    const { container } = renderAssistant(MARKDOWN_BODY);

    expect(screen.getByRole('heading', { level: 3, name: 'Title' })).toBeInTheDocument();
    expect(container.querySelector('ul')).not.toBeNull();
    expect(container.querySelector('ul li')).toHaveTextContent('bullet');
    expect(container.querySelector('ol')).not.toBeNull();
    expect(container.querySelector('ol li')).toHaveTextContent('numbered');
    expect(container.querySelector('code')).toHaveTextContent('inline');
    expect(container.querySelector('pre')).toHaveTextContent('fenced()');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('group', { name: 'Code block' })).toHaveLength(2);
    for (const block of screen.getAllByRole('group', { name: 'Code block' })) {
      expect(block).toHaveAttribute('tabindex', '0');
    }
    expect(screen.getByRole('group', { name: 'Table' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('columnheader', { name: 'Col' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'a' })).toBeInTheDocument();
  });

  it('keeps raw HTML, script, and javascript links inert', () => {
    const { container } = renderAssistant(
      [
        '<script>window.__assistantMarkdownPwned = true</script>',
        '<img src="https://example.invalid/raw.png" alt="raw" />',
        '<a href="javascript:alert(1)">html go</a>',
        '',
        '[md go](javascript:alert(1))',
      ].join('\n')
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(
      (window as Window & { __assistantMarkdownPwned?: boolean }).__assistantMarkdownPwned
    ).toBeUndefined();
  });

  it('keeps images as escaped text and opens only explicit HTTP(S) links safely', () => {
    const { container } = renderAssistant(
      '![<img src=x onerror=alert(1)>](https://example.invalid/pixel.png)\n\n[Safe](https://example.com)\n\n[Local](/settings)\n\n[Data](data:text/html,hello)'
    );
    expect(container.querySelector('img,script,iframe,source,video,audio')).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Safe' })).toHaveAttribute(
      'href',
      'https://example.com'
    );
    expect(screen.getByRole('link', { name: 'Safe' })).toHaveAttribute(
      'rel',
      'noopener noreferrer'
    );
    expect(screen.getByRole('link', { name: 'Safe' })).toHaveAttribute('target', '_blank');
  });

  it('still renders arbitrary ReactNode children', () => {
    renderAssistant(<span>custom child</span>);
    expect(screen.getByText('custom child')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

describe('UserMessage', () => {
  it('retains Markdown-looking text as literal content', () => {
    render(
      <UserMessage author="Ada" isSelf>
        {MARKDOWN_BODY}
      </UserMessage>
    );

    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/# Title/)).toBeInTheDocument();
    expect(screen.getByText(/- bullet/)).toBeInTheDocument();
  });
});

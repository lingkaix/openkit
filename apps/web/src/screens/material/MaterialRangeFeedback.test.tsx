import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MaterialRangeFeedback } from './MaterialRangeFeedback';

const base = {
  materialId: 'mat_00000000-0000-7afa-a16b-33440db6a104',
  revisionId: 'mrev_00000000-0000-78fe-9799-54f80643d746',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  content: 'A\r\n😀e\u0301\rZ',
};

describe('exact Material range feedback', () => {
  it('maps a displayed CRLF selection to the exact original UTF-16 source', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MaterialRangeFeedback revision={base} value={null} onChange={onChange} />);
    const text = screen.getByRole('textbox', { name: 'Feedback base text' }) as HTMLTextAreaElement;
    expect(text.value).toBe('A\n😀e\u0301\nZ');
    await user.click(text);
    text.setSelectionRange(1, 6);
    fireEvent.select(text);
    await user.click(screen.getByRole('button', { name: 'Use feedback range' }));
    expect(onChange).toHaveBeenLastCalledWith({
      materialId: base.materialId, revisionId: base.revisionId,
      contentDigest: base.contentDigest, start: 1, end: 7,
      originalText: '\r\n😀e\u0301',
    });
  });

  it('rejects empty, out-of-bounds and surrogate-split explicit source offsets', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MaterialRangeFeedback revision={base} value={null} onChange={onChange} />);
    const start = screen.getByRole('textbox', { name: 'Range start' });
    const end = screen.getByRole('textbox', { name: 'Range end' });
    const use = screen.getByRole('button', { name: 'Use feedback range' });
    for (const [from, to] of [['1', '1'], ['0', '99'], ['4', '5']]) {
      await user.clear(start);
      await user.type(start, from);
      await user.clear(end);
      await user.type(end, to);
      expect(use).toBeDisabled();
    }
    expect(onChange).not.toHaveBeenCalled();
    await user.clear(start);
    await user.type(start, '3');
    await user.clear(end);
    await user.type(end, '7');
    await user.click(use);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ start: 3, end: 7, originalText: '😀e\u0301' }));
  });

  it('keeps the original substring and exposes a separate clear action', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = { materialId: base.materialId, revisionId: base.revisionId, contentDigest: base.contentDigest, start: 0, end: 3, originalText: 'A\r\n' };
    render(<MaterialRangeFeedback revision={base} value={value} onChange={onChange} />);
    expect(screen.getByRole('status')).toHaveTextContent('0–3');
    await user.click(screen.getByRole('button', { name: 'Clear feedback range' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType, Key, ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import appShellSource from '../app/AppShell.tsx?raw';
import themePickerSource from '../app/ThemePicker.tsx?raw';
import goalScreenSource from '../screens/goal/GoalScreen.tsx?raw';
import { Gallery } from './Gallery';
import gallerySource from './Gallery.tsx?raw';
import * as P from './index';
import {
  Avatar,
  Button,
  Composer,
  CountBadge,
  ErrorBanner,
  NavRow,
  Select,
  StatusChip,
  Switch,
} from './index';

/** Every §9 primitive must be exported from the barrel (the A2UI catalog seed). */
const REQUIRED_EXPORTS = [
  'Button',
  'StatusChip',
  'ContextChip',
  'Avatar',
  'CountBadge',
  'NavRow',
  'UserMessage',
  'AssistantMessage',
  'ItemCard',
  'Composer',
  'PhaseStepper',
  'TurnSeparator',
  'ChannelTag',
  'KanbanColumn',
  'KanbanCard',
  'ArtifactRow',
  'Toast',
  'Page',
  'PageHeader',
  'Card',
  'ListRow',
  'Eyebrow',
  'Skeleton',
  'EmptyState',
  'ErrorBanner',
  'TextField',
  'Switch',
  'Select',
  'Icon',
  'Dialog',
  'Modal',
  'Menu',
  'Tabs',
  'Table',
  'Progress',
  'Meter',
  'RadioGroup',
  'ToastProvider',
  'toastQueue',
  'CodeView',
  'DiffView',
  'MaterialEditor',
];

/** Every primitive added by S3-S5 must appear as JSX in the shared component sheet. */
const GALLERY_PRIMITIVES = [
  'Dialog',
  'Modal',
  'Menu',
  'Tabs',
  'Table',
  'Progress',
  'Meter',
  'RadioGroup',
  'Toast',
  'ToastProvider',
  'CodeView',
  'DiffView',
  'MaterialEditor',
];

/** Resolve a required barrel export without turning an absent primitive into an import error. */
function requiredPrimitive<T>(name: string): T {
  const primitive = (P as Record<string, unknown>)[name];
  if (!primitive) throw new Error(`Missing required primitive export: ${name}`);
  return primitive as T;
}

/**
 * Removes only axe 4.12's false positive for React Aria's standards-compliant
 * meter role fallback while preserving every other rule and failing node.
 */
function withoutReactAriaMeterFallbackFalsePositive(results: Awaited<ReturnType<typeof axe>>) {
  const expectedRangeAttributes = new Set([
    'aria-valuenow',
    'aria-valuemin',
    'aria-valuemax',
    'aria-valuetext',
  ]);

  return {
    ...results,
    violations: results.violations.flatMap((violation) => {
      if (violation.id !== 'aria-allowed-attr') return [violation];

      const nodes = violation.nodes.filter((node) => {
        const parsedNode = document.createElement('template');
        parsedNode.innerHTML = node.html;
        const element = node.element ?? parsedNode.content.firstElementChild;
        if (
          !element?.hasAttribute('data-rac') ||
          element.getAttribute('role') !== 'meter progressbar'
        ) {
          return true;
        }

        const rejectedAttributes = [...node.any, ...node.all, ...node.none]
          .filter((check) => check.id === 'aria-allowed-attr')
          .flatMap((check) => (Array.isArray(check.data) ? check.data : []))
          .map((rejection) =>
            typeof rejection === 'string' ? rejection.slice(0, rejection.indexOf('=')) : ''
          );
        const isExactRangeFalsePositive =
          rejectedAttributes.length === expectedRangeAttributes.size &&
          rejectedAttributes.every((attribute) => expectedRangeAttributes.has(attribute));
        return !isExactRangeFalsePositive;
      });

      return nodes.length > 0 ? [{ ...violation, nodes }] : [];
    }),
  };
}

describe('primitive tier — completeness', () => {
  for (const name of REQUIRED_EXPORTS) {
    it(`exports ${name}`, () => {
      expect(requiredPrimitive(name)).toBeDefined();
    });
  }
});

describe('primitive tier — renders and is accessible under every theme', () => {
  it('the component sheet includes every S3-S5 primitive specimen', () => {
    for (const name of GALLERY_PRIMITIVES) {
      expect.soft(gallerySource).toMatch(new RegExp(`<${name}\\b`));
    }
  });

  for (const theme of ['', 'ok-theme-paper', 'ok-theme-noir']) {
    it(`the component sheet is axe-clean (${theme || 'spectrum'})`, async () => {
      const { container } = render(
        <div className={theme}>
          <Gallery />
        </div>
      );
      // color-contrast needs real layout, which jsdom lacks; assert structural a11y.
      const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
      expect(withoutReactAriaMeterFallbackFalsePositive(results)).toHaveNoViolations();
    });
  }

  it('the meter fallback filter preserves genuine aria-allowed-attr violations', async () => {
    const { container } = render(
      <button type="button" {...{ 'aria-valuenow': 1 }}>
        Invalid range button
      </button>
    );
    const results = withoutReactAriaMeterFallbackFalsePositive(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } })
    );

    expect(results.violations.some((violation) => violation.id === 'aria-allowed-attr')).toBe(true);
  });
});

describe('primitive tier — behavior', () => {
  it('Dialog in a Modal traps focus and Escape closes back to the trigger', async () => {
    const user = userEvent.setup();
    const Modal =
      requiredPrimitive<ComponentType<{ trigger: ReactElement; children: ReactNode }>>('Modal');
    const Dialog =
      requiredPrimitive<ComponentType<{ title: string; children: ReactNode }>>('Dialog');
    render(
      <Modal trigger={<Button>Open dialog</Button>}>
        <Dialog title="Confirm change">
          <Button variant="quiet">Cancel</Button>
          <Button>Confirm</Button>
        </Dialog>
      </Modal>
    );

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Confirm change' });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    confirm.focus();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('Menu opens with ArrowDown and Enter selects the focused item', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const Menu =
      requiredPrimitive<
        ComponentType<{
          label: string;
          items: { id: string; label: string }[];
          onAction: (key: Key) => void;
        }>
      >('Menu');
    render(
      <Menu
        label="Goal actions"
        items={[
          { id: 'prioritize', label: 'Prioritize' },
          { id: 'pause', label: 'Pause' },
        ]}
        onAction={onAction}
      />
    );

    const trigger = screen.getByRole('button', { name: 'Goal actions' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onAction).toHaveBeenCalledWith('prioritize');
  });

  it('Tabs expose tab semantics and ArrowRight selects the next panel', async () => {
    const user = userEvent.setup();
    const Tabs =
      requiredPrimitive<
        ComponentType<{
          'aria-label': string;
          defaultSelectedKey: string;
          items: { id: string; label: string; content: ReactNode }[];
        }>
      >('Tabs');
    render(
      <Tabs
        aria-label="Goal lens"
        defaultSelectedKey="thread"
        items={[
          { id: 'thread', label: 'Thread', content: 'Thread content' },
          { id: 'plan', label: 'Plan', content: 'Plan content' },
          { id: 'board', label: 'Board', content: 'Board content' },
        ]}
      />
    );

    expect(screen.getByRole('tablist', { name: 'Goal lens' })).toBeInTheDocument();
    const thread = screen.getByRole('tab', { name: 'Thread' });
    const plan = screen.getByRole('tab', { name: 'Plan' });
    expect(thread).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Thread content');
    thread.focus();
    await user.keyboard('{ArrowRight}');
    expect(plan).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Plan content');
  });

  it('Table exposes its labeled column and row data through table semantics', () => {
    const Table =
      requiredPrimitive<
        ComponentType<{
          'aria-label': string;
          columns: { id: string; label: string }[];
          rows: { id: string; cells: Record<string, ReactNode> }[];
        }>
      >('Table');
    render(
      <Table
        aria-label="Worker readiness"
        columns={[
          { id: 'worker', label: 'Worker' },
          { id: 'status', label: 'Status' },
        ]}
        rows={[{ id: 'scout', cells: { worker: 'Scout', status: 'Ready' } }]}
      />
    );

    expect(screen.getByRole('grid', { name: 'Worker readiness' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Worker' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'Scout' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Scout' })).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: 'Ready' })).toBeInTheDocument();
  });

  it('Progress and Meter expose their labeled ranges and current values', () => {
    const Progress =
      requiredPrimitive<
        ComponentType<{ label: string; minValue: number; maxValue: number; value: number }>
      >('Progress');
    const Meter =
      requiredPrimitive<
        ComponentType<{ label: string; minValue: number; maxValue: number; value: number }>
      >('Meter');
    render(
      <>
        <Progress label="Material upload" minValue={10} maxValue={20} value={15} />
        <Meter label="Workspace storage" minValue={0} maxValue={100} value={65} />
      </>
    );

    expect(screen.getByText('Material upload')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Material upload' })).toHaveAttribute(
      'aria-valuenow',
      '15'
    );
    expect(screen.getByRole('progressbar', { name: 'Material upload' })).toHaveAttribute(
      'aria-valuemin',
      '10'
    );
    expect(screen.getByRole('progressbar', { name: 'Material upload' })).toHaveAttribute(
      'aria-valuemax',
      '20'
    );
    expect(screen.getByText('Workspace storage')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Workspace storage' })).toHaveAttribute(
      'aria-valuenow',
      '65'
    );
    expect(screen.getByRole('meter', { name: 'Workspace storage' })).toHaveAttribute(
      'aria-valuemin',
      '0'
    );
    expect(screen.getByRole('meter', { name: 'Workspace storage' })).toHaveAttribute(
      'aria-valuemax',
      '100'
    );
  });

  it('RadioGroup exposes radio semantics and ArrowRight changes selection', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const RadioGroup =
      requiredPrimitive<
        ComponentType<{
          'aria-label': string;
          defaultValue: string;
          items: { id: string; label: string }[];
          onChange: (value: string) => void;
        }>
      >('RadioGroup');
    render(
      <RadioGroup
        aria-label="Color theme"
        defaultValue="spectrum"
        items={[
          { id: 'spectrum', label: 'Spectrum' },
          { id: 'paper', label: 'Paper' },
        ]}
        onChange={onChange}
      />
    );

    expect(screen.getByRole('radiogroup', { name: 'Color theme' })).toBeInTheDocument();
    const spectrum = screen.getByRole('radio', { name: 'Spectrum' });
    const paper = screen.getByRole('radio', { name: 'Paper' });
    expect(spectrum).toBeChecked();
    spectrum.focus();
    await user.keyboard('{ArrowRight}');
    expect(paper).toBeChecked();
    expect(onChange).toHaveBeenCalledWith('paper');
  });

  it('a mounted ToastProvider raises and dismisses queued notifications', async () => {
    const user = userEvent.setup();
    const ToastProvider = requiredPrimitive<ComponentType>('ToastProvider');
    const toastQueue = requiredPrimitive<{
      add(message: string): string;
      clear(): void;
    }>('toastQueue');
    act(() => toastQueue.clear());
    const { baseElement } = render(<ToastProvider />);

    act(() => {
      toastQueue.add('Material saved');
    });
    const toast = await screen.findByRole('alertdialog');
    expect.soft(toast).toHaveAccessibleName('Material saved');
    expect.soft(toast.querySelector('[role="status"], [aria-live]')).toBeNull();
    const results = await axe(baseElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect.soft(results).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() => expect(screen.queryByText('Material saved')).not.toBeInTheDocument());
  });

  it('CodeView renders the exact input bytes visibly in preformatted code', () => {
    const CodeView = requiredPrimitive<ComponentType<{ label: string; value: string }>>('CodeView');
    const value = 'first line\n  second\t<&>';
    render(<CodeView label="Worker output" value={value} />);

    const view = screen.getByLabelText('Worker output');
    expect(view.tagName).toBe('PRE');
    expect(view.querySelector('code')?.textContent).toBe(value);
  });

  it('DiffView renders exact immutable inputs without proposal mutation authority', () => {
    const DiffView =
      requiredPrimitive<
        ComponentType<{
          before: string;
          after: string;
          beforeLabel: string;
          afterLabel: string;
        }>
      >('DiffView');
    const before = 'before\n  unchanged\t<&>';
    const after = 'after\n    changed\t<&>';
    render(
      <DiffView
        before={before}
        after={after}
        beforeLabel="Saved revision"
        afterLabel="Worker proposal"
      />
    );

    const beforeView = screen.getByLabelText('Saved revision');
    const afterView = screen.getByLabelText('Worker proposal');
    expect(beforeView.tagName).toBe('PRE');
    expect(afterView.tagName).toBe('PRE');
    expect(beforeView.querySelector('code')?.textContent).toBe(before);
    expect(afterView.querySelector('code')?.textContent).toBe(after);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply|accept|save/i })).not.toBeInTheDocument();
  });

  it.each([
    ['markdown', '# Release\n', 'Ship  today.'],
    ['text', 'Release\n', 'Ship  today.'],
  ] as const)('MaterialEditor saves one exact atomic %s draft rather than emitting keystrokes', async (kind, initialValue, addition) => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const MaterialEditor =
      requiredPrimitive<
        ComponentType<{
          label: string;
          kind: 'markdown' | 'text';
          initialValue: string;
          onSave: (value: string) => void | Promise<void>;
        }>
      >('MaterialEditor');
    render(
      <MaterialEditor
        label="Release notes"
        kind={kind}
        initialValue={initialValue}
        onSave={onSave}
      />
    );

    const editor = screen.getByRole('textbox', { name: 'Release notes' });
    expect(editor.tagName).toBe('TEXTAREA');
    await user.type(editor, addition);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith(`${initialValue}${addition}`);
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(screen.queryByText('Unsaved')).not.toBeInTheDocument();
  });

  it('MaterialEditor claims Saved only after the exact draft save settles', async () => {
    const user = userEvent.setup();
    let resolveSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const onSave = vi.fn(() => pendingSave);
    const MaterialEditor =
      requiredPrimitive<
        ComponentType<{
          label: string;
          kind: 'markdown' | 'text';
          initialValue: string;
          onSave: (value: string) => void | Promise<void>;
        }>
      >('MaterialEditor');
    render(
      <MaterialEditor
        label="Release notes"
        kind="markdown"
        initialValue={'# Release\n'}
        onSave={onSave}
      />
    );

    const editor = screen.getByRole('textbox', { name: 'Release notes' });
    await user.type(editor, 'Ship exactly.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith('# Release\nShip exactly.');
    expect(editor).toHaveValue('# Release\nShip exactly.');
    expect(screen.getByText('Saving')).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();

    await act(async () => resolveSave());
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(editor).toHaveValue('# Release\nShip exactly.');
  });

  it('MaterialEditor preserves a rejected draft as accessible retryable unsaved work', async () => {
    const user = userEvent.setup();
    const rejectedSave = Promise.reject(new Error('durable save rejected'));
    rejectedSave.catch(() => {});
    const onSave = vi.fn(() => rejectedSave);
    const MaterialEditor =
      requiredPrimitive<
        ComponentType<{
          label: string;
          kind: 'markdown' | 'text';
          initialValue: string;
          onSave: (value: string) => void | Promise<void>;
        }>
      >('MaterialEditor');
    render(
      <MaterialEditor
        label="Release notes"
        kind="text"
        initialValue={'Release\n'}
        onSave={onSave}
      />
    );

    const editor = screen.getByRole('textbox', { name: 'Release notes' });
    await user.type(editor, 'Keep this draft.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const saveError = await screen.findByRole('alert');
    expect(saveError).toHaveTextContent(/save/i);
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(editor).toHaveValue('Release\nKeep this draft.');
    expect(screen.getByRole('button', { name: /save|try again/i })).toBeEnabled();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith('Release\nKeep this draft.');
  });

  it('Button fires onPress on click and Enter', async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Approve</Button>);
    const button = screen.getByRole('button', { name: 'Approve' });
    await user.click(button);
    button.focus();
    await user.keyboard('{Enter}');
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it('Switch toggles with the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch onChange={onChange}>Ask before spending</Switch>);
    const toggle = screen.getByRole('switch', { name: 'Ask before spending' });
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('Composer submits the trimmed value and clears', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const input = screen.getByRole('textbox', { name: 'Message' });
    await user.type(input, '  hello  ');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(input).toHaveValue('');
  });

  it('Composer disables input + send with a stated reason', () => {
    render(<Composer disabledReason="Couldn't reach the local runtime." />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('NavRow marks the active destination and fires onPress', async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<NavRow icon="chat" label="Chat" active onPress={onPress} />);
    const row = screen.getByRole('button', { name: 'Chat' });
    expect(row).toHaveAttribute('aria-current', 'page');
    await user.click(row);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('CountBadge renders a positive count and nothing at zero', () => {
    const { rerender } = render(<CountBadge count={3} label="need you" />);
    expect(screen.getByText('3')).toBeInTheDocument();
    rerender(<CountBadge count={0} label="need you" />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('Avatar exposes the worker name to assistive tech', () => {
    render(<Avatar hue="scout" initials="SC" name="Scout" />);
    expect(screen.getByRole('img', { name: 'Scout' })).toBeInTheDocument();
  });

  it('StatusChip states meaning as text, not color alone', () => {
    render(<StatusChip tone="notice">Needs review</StatusChip>);
    expect(screen.getByText('Needs review')).toBeInTheDocument();
  });

  it('ErrorBanner offers a retry action', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorBanner message="Couldn't reach the local runtime." onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't reach the local runtime.");
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('Select is a labeled, listbox-backed control with its items wired', () => {
    const { container } = render(
      <Select
        label="Model"
        defaultSelectedKey="sonnet"
        items={[
          { id: 'opus', label: 'Claude Opus 4.8' },
          { id: 'sonnet', label: 'Claude Sonnet 5' },
        ]}
      />
    );
    // Labeled trigger that exposes a listbox popup. Opening the portalled listbox
    // and picking is covered by L4 Playwright e2e, where real pointer/layout
    // exist; RAC's virtual-focus listbox is flaky in jsdom.
    const trigger = screen.getByRole('button', { name: /Model/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveTextContent('Claude Sonnet 5');
    // Items are wired into the control (RAC mirrors them into a hidden native select).
    expect(container.querySelectorAll('select option').length).toBeGreaterThanOrEqual(2);
  });
});

describe('primitive tier — ownership', () => {
  it('GoalScreen delegates tab semantics and keyboard behavior to the Tabs primitive', () => {
    expect(goalScreenSource).not.toMatch(/role=["']tab(?:list)?["']/);
    expect(goalScreenSource).not.toMatch(/from ["']react-aria-components["']/);
  });

  it('AppShell mounts the shared ToastProvider', () => {
    expect(appShellSource).toMatch(/<ToastProvider\b/);
  });

  it('ThemePicker delegates radio behavior to the OpenKit RadioGroup primitive', () => {
    expect(themePickerSource).not.toMatch(/from ["']react-aria-components["']/);
    expect(themePickerSource).toMatch(/from ["']\.\.\/primitives["']/);
    expect(themePickerSource).toMatch(/<RadioGroup\b/);
  });
});

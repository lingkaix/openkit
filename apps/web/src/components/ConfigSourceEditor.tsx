import { createEffect, onCleanup, onMount } from 'solid-js';

import type { RuntimeConfigFileDiagnostic } from '../lib/app-types';

/**
 * Props for the runtime config source editor.
 */
export interface ConfigSourceEditorProps {
  /** Accessible label for the editor. */
  label: string;
  /** Current source content. */
  value: string;
  /** Diagnostics returned by NanoCore validation. */
  diagnostics: RuntimeConfigFileDiagnostic[];
  /** Whether the editor is read-only. */
  readOnly?: boolean;
  /** Called when source content changes. */
  onChange: (value: string) => void;
  /** Called when the user presses the editor save shortcut. */
  onSave?: () => void;
}

/**
 * Renders a JSONC source editor enhanced with CodeMirror outside tests.
 */
export function ConfigSourceEditor(props: ConfigSourceEditorProps) {
  let host: HTMLDivElement | undefined;
  let editor: {
    state: { doc: { toString: () => string } };
    dispatch: (input: unknown) => void;
    destroy: () => void;
  } | null = null;
  let ignoreEditorUpdate = false;

  /**
   * Checks whether the current runtime should skip CodeMirror enhancement.
   */
  function shouldUseTextareaOnly(): boolean {
    return globalThis.navigator?.userAgent.toLowerCase().includes('jsdom') ?? false;
  }

  /**
   * Converts one-based runtime diagnostics into CodeMirror diagnostics.
   */
  function editorDiagnostics(): Array<{
    from: number;
    to: number;
    severity: 'info' | 'warning' | 'error';
    source: string;
    message: string;
  }> {
    if (!editor) {
      return [];
    }

    const doc = editor.state.doc;

    return props.diagnostics.map((diagnostic) => {
      const range = diagnostic.range;
      const from = range
        ? lineColumnToOffset(doc.toString(), range.startLine, range.startColumn)
        : 0;
      const to = range ? lineColumnToOffset(doc.toString(), range.endLine, range.endColumn) : from;

      return {
        from,
        to,
        severity:
          diagnostic.severity === 'warning'
            ? 'warning'
            : diagnostic.severity === 'info'
              ? 'info'
              : 'error',
        source: diagnostic.code,
        message: diagnostic.message,
      };
    });
  }

  /**
   * Pushes current diagnostics into the mounted CodeMirror editor.
   */
  async function syncEditorDiagnostics(): Promise<void> {
    if (!editor) {
      return;
    }

    const { setDiagnostics } = await import('@codemirror/lint');
    editor.dispatch(setDiagnostics(editor.state as never, editorDiagnostics()));
  }

  onMount(async () => {
    if (!host || shouldUseTextareaOnly()) {
      return;
    }

    const [
      { basicSetup, EditorView },
      { EditorState, Prec },
      { json },
      { lintGutter, lintKeymap },
      { keymap },
      { searchKeymap },
      { autocompletion },
    ] = await Promise.all([
      import('codemirror'),
      import('@codemirror/state'),
      import('@codemirror/lang-json'),
      import('@codemirror/lint'),
      import('@codemirror/view'),
      import('@codemirror/search'),
      import('@codemirror/autocomplete'),
    ]);

    editor = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          json(),
          lintGutter(),
          autocompletion(),
          keymap.of([...lintKeymap, ...searchKeymap]),
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-s',
                run: () => {
                  props.onSave?.();
                  return true;
                },
              },
            ])
          ),
          EditorView.editable.of(!props.readOnly),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || ignoreEditorUpdate) {
              return;
            }

            props.onChange(update.state.doc.toString());
          }),
        ],
      }),
    }) as typeof editor;

    await syncEditorDiagnostics();
  });

  createEffect(() => {
    if (!editor) {
      return;
    }

    const current = editor.state.doc.toString();

    if (current === props.value) {
      void syncEditorDiagnostics();
      return;
    }

    ignoreEditorUpdate = true;
    editor.dispatch({
      changes: {
        from: 0,
        to: current.length,
        insert: props.value,
      },
    });
    ignoreEditorUpdate = false;
    void syncEditorDiagnostics();
  });

  onCleanup(() => {
    editor?.destroy();
  });

  return (
    <div class="config-source-editor">
      <div ref={host} class="config-source-codemirror" />
      <textarea
        aria-label={props.label}
        class="textarea textarea-bordered config-source-textarea"
        onInput={(event) => props.onChange(event.currentTarget.value)}
        readOnly={props.readOnly}
        value={props.value}
      />
    </div>
  );
}

/**
 * Converts one-based line and column to a source offset.
 */
function lineColumnToOffset(content: string, line: number, column: number): number {
  const lines = content.split('\n');
  const before = lines.slice(0, Math.max(0, line - 1)).join('\n');
  const prefixLength = before.length + (line > 1 ? 1 : 0);
  const lineContent = lines[line - 1] ?? '';

  return Math.min(prefixLength + Math.max(0, column - 1), prefixLength + lineContent.length);
}

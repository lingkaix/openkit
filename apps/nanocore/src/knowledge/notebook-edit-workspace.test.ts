import { describe, expect, it, vi } from 'vitest';
import { NOTEBOOK_EDIT_LIMITS, NotebookEditWorkspace } from './notebook-edit-workspace.js';

/** Makes one trusted, fixed-base invocation without a publisher or host filesystem. */
function workspace(
  overrides: Partial<ConstructorParameters<typeof NotebookEditWorkspace>[0]> = {}
) {
  return new NotebookEditWorkspace({
    baseFiles: { 'index.md': '# Notebook\n', 'one.md': 'first\n', 'omitted.md': 'private\n' },
    editablePaths: ['index.md', 'one.md'],
    sources: { 'selected.txt': 'evidence\n' },
    deadline: Date.now() + 5_000,
    ...overrides,
  });
}

const signal = new AbortController().signal;

describe('NotebookEditWorkspace', () => {
  it('retains multi-file edits across calls and returns only the exact fixed-base changes', async () => {
    const baseFiles = {
      'index.md': '# Notebook\n',
      'one.md': 'first\n',
      'omitted.md': 'private\n',
    };
    const editor = workspace({ baseFiles });
    baseFiles['one.md'] = 'caller mutation';
    expect(
      await editor.update(
        {
          script: 'mkdir scratch; cat /sources/selected.txt > new.md; printf "second\\n" > one.md',
        },
        signal
      )
    ).toEqual({ exitCode: 0, stdout: '', stderr: '', truncated: false });
    expect(
      await editor.update({ script: 'rmdir scratch; cat one.md new.md; rm index.md' }, signal)
    ).toEqual({ exitCode: 0, stdout: 'second\nevidence\n', stderr: '', truncated: false });
    const changes = editor.changes();
    expect(changes).toEqual({ 'index.md': null, 'new.md': 'evidence\n', 'one.md': 'second\n' });
    changes['one.md'] = 'result mutation';
    expect(editor.changes()['one.md']).toBe('second\n');
  });

  it('keeps omitted published pages and selected Sources immutable, including recursive operations', async () => {
    const editor = workspace();
    expect((await editor.update({ script: 'cat omitted.md' }, signal)).exitCode).not.toBe(0);
    for (const script of [
      'echo replace > omitted.md',
      'echo replace > /sources/selected.txt',
      'rm -rf /sources',
      'cp one.md omitted.md',
      'echo replace > omitted.md/nested.md',
      'mv one.md renamed.md',
    ]) {
      await expect(editor.update({ script }, signal)).rejects.toMatchObject({
        code: 'scope_denied',
      });
      expect(editor.changes()).toEqual({});
    }
  });

  it('refuses unsafe paths and commands without host, network, links or plugin capabilities', async () => {
    const editor = workspace();
    for (const command of ['curl', 'git', 'node', 'python3', 'js-exec', 'sqlite3', 'ln', 'mknod']) {
      const result = await editor.update({ script: `${command} --help` }, signal);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
    }
    for (const path of [
      '/outside.md',
      '/notebook/../outside.md',
      '/notebook/.git/config',
      'bad@id.md',
    ]) {
      await expect(
        editor.update({ script: `echo invalid > ${path}` }, signal)
      ).rejects.toMatchObject({ code: 'scope_denied' });
    }
    expect(
      (await editor.update({ script: 'cat /etc/passwd; cat /proc/self/environ' }, signal)).stdout
    ).toBe('');
    await expect(
      editor.update(
        { script: 'echo scratch > scratch.md; echo nested > scratch.md/nested.md' },
        signal
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(editor.changes()).toEqual({});
  });

  it('permits scratch renames and valid partial edits after an ordinary command failure', async () => {
    const editor = workspace();
    const result = await editor.update(
      { script: 'echo scratch > scratch.md; mv scratch.md final.md; missing-command' },
      signal
    );
    expect(result.exitCode).not.toBe(0);
    expect(editor.changes()).toEqual({ 'final.md': 'scratch\n' });
    await editor.update({ script: 'rm final.md' }, signal);
    expect(editor.changes()).toEqual({});
  });

  it('uses only the fixed virtual environment and working directory', async () => {
    vi.stubEnv('OPENKIT_NOTEBOOK_HOST_MARKER', 'host-only-value');
    try {
      const editor = workspace();
      const result = await editor.update(
        { script: 'printf "%s|" "$OPENKIT_NOTEBOOK_HOST_MARKER"; pwd' },
        signal
      );
      expect(result).toEqual({
        exitCode: 0,
        stdout: '|/notebook\n',
        stderr: '',
        truncated: false,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses the bundled JSON and YAML commands and preserves prior edits after a denied call', async () => {
    const editor = workspace();
    await editor.update(
      {
        script: `printf '{"value":"json"}' | jq -r .value > data.md; printf 'name: yaml\\n' | yq -r .name >> data.md`,
      },
      signal
    );
    expect(editor.changes()).toEqual({ 'data.md': 'json\nyaml\n' });
    await expect(
      editor.update(
        { script: 'echo partial > one.md; echo denied > /sources/selected.txt' },
        signal
      )
    ).rejects.toMatchObject({ code: 'scope_denied' });
    expect(editor.changes()).toEqual({ 'data.md': 'json\nyaml\n' });
  });

  it('caps combined UTF-8 output and preserves exact candidate bytes independently of display', async () => {
    const editor = workspace({
      baseFiles: { 'one.md': 'é'.repeat(40_000) },
      editablePaths: ['one.md'],
    });
    const result = await editor.update({ script: 'cat one.md; cat one.md >&2' }, signal);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      NOTEBOOK_EDIT_LIMITS.outputBytes
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout).not.toContain('\ufffd');
    expect(editor.changes()).toEqual({});
  });

  it('rejects invalid input and admitted content bounds before shell execution', async () => {
    expect(() =>
      workspace({
        baseFiles: { 'one.md': 'x'.repeat(NOTEBOOK_EDIT_LIMITS.fileBytes + 1) },
        editablePaths: ['one.md'],
      })
    ).toThrow(/2 MiB/);
    const sources = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [
        `source-${i}.txt`,
        'x'.repeat(NOTEBOOK_EDIT_LIMITS.fileBytes),
      ])
    );
    expect(() => workspace({ sources })).toThrow(/32 MiB/);
    const editor = workspace();
    await expect(
      editor.update({ script: 'é'.repeat(NOTEBOOK_EDIT_LIMITS.scriptBytes / 2 + 1) }, signal)
    ).rejects.toMatchObject({ code: 'limit_reached' });
    await expect(
      editor.update({ script: 'true', unexpected: true } as { script: string }, signal)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(editor.changes()).toEqual({});
  });

  it('refuses oversized files and changed-file sets without retaining their partial edits', async () => {
    const editor = workspace({
      baseFiles: { 'one.md': 'x'.repeat(NOTEBOOK_EDIT_LIMITS.fileBytes) },
      editablePaths: ['one.md'],
    });
    await expect(editor.update({ script: 'echo x >> one.md' }, signal)).rejects.toMatchObject({
      code: 'limit_reached',
    });
    expect(editor.changes()).toEqual({});
    await expect(
      editor.update({ script: 'for ((i=0; i<257; i++)); do echo new > "new-$i.md"; done' }, signal)
    ).rejects.toMatchObject({ code: 'limit_reached' });
    expect(editor.changes()).toEqual({});
    const full = workspace({
      baseFiles: { 'one.md': 'x'.repeat(NOTEBOOK_EDIT_LIMITS.fileBytes) },
      editablePaths: ['one.md'],
      sources: Object.fromEntries(
        Array.from({ length: 15 }, (_, i) => [
          `source-${i}.txt`,
          'x'.repeat(NOTEBOOK_EDIT_LIMITS.fileBytes),
        ])
      ),
    });
    await expect(full.update({ script: 'cp one.md new.md' }, signal)).rejects.toMatchObject({
      code: 'limit_reached',
    });
    expect(full.changes()).toEqual({});
  });

  it('uses the shared deadline and discards all volatile edits on cancellation', async () => {
    const controller = new AbortController();
    const editor = workspace();
    await editor.update({ script: 'echo changed > one.md' }, controller.signal);
    controller.abort(new Error('/host/private must not escape'));
    expect(() => editor.changes()).toThrow(/cancelled/);
    await expect(editor.update({ script: 'true' }, controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(() => editor.changes()).toThrow(/cancelled/);
    const expired = workspace({ deadline: Date.now() - 1 });
    await expect(expired.update({ script: 'true' }, signal)).rejects.toMatchObject({
      code: 'deadline_reached',
    });
    const bounded = workspace({ deadline: Date.now() + 50 });
    await expect(
      bounded.update({ script: 'while true; do touch scratch.md; done' }, signal)
    ).rejects.toMatchObject({ code: 'deadline_reached' });
    expect(() => bounded.changes()).toThrow(/deadline/);
  });
});

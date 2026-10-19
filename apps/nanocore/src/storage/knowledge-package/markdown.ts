import MarkdownIt from 'markdown-it';

/** Rewrites parsed Markdown destinations while preserving prose, code, labels and original line endings. */
export function remintKnowledgeMarkdown(body: string, rewrite: (href: string) => string): string {
  const markdown = new MarkdownIt({ html: false });
  const lines = [...body.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)]
    .filter((line) => line[0].length > 0)
    .map((line) => ({ start: line.index, text: line[0].replace(/[\r\n]+$/, '') }));
  const edits = new Map<number, { end: number; text: string }>();
  type Destination = { source: string; start: number; end: number; href: string };
  const frames: { line: number; image: boolean; destinations: Destination[] }[] = [];
  let inlineLine = 0;
  const originalDestination = markdown.helpers.parseLinkDestination;
  // Helpers belong to this parser instance. A tentative destination is committed only if its owning rule succeeds.
  Object.assign(markdown.helpers, {
    parseLinkDestination(source: string, start: number, maximum: number) {
      const result = originalDestination(source, start, maximum);
      if (result.ok && frames.length) {
        const angled = source[start] === '<';
        frames.at(-1)!.destinations.push({
          source,
          start: start + Number(angled),
          end: result.pos - Number(angled),
          href: markdown.normalizeLink(result.str),
        });
      }
      return result;
    },
  });
  const retain = (frame: (typeof frames)[number]) => {
    for (const destination of frame.destinations) {
      const target = rewrite(destination.href);
      if (target === destination.href) continue;
      const prefix = destination.source.slice(0, destination.start).split('\n');
      const row = prefix.length - 1;
      const sourceLine = destination.source.split('\n')[row]!;
      const original = lines[frame.line + row];
      const column = original?.text.indexOf(sourceLine) ?? -1;
      // Never guess an offset or rewrite a matching literal elsewhere in the page.
      if (
        !original ||
        column < 0 ||
        destination.source.slice(destination.start, destination.end).includes('\n')
      )
        throw new Error('Knowledge package Markdown destination is unavailable.');
      const start = original.start + column + prefix.at(-1)!.length;
      const end = start + destination.end - destination.start;
      edits.set(start, { end, text: target });
    }
  };
  for (const name of ['link', 'image'] as const) {
    const rule = markdown.inline.ruler.getRules('').find((candidate) => candidate.name === name);
    if (!rule) throw new Error('Knowledge package Markdown parser is unavailable.');
    markdown.inline.ruler.at(name, (state, silent) => {
      // Links inside image alt text are displayed text, not independently fetched destinations.
      const suppressed = frames.some((frame) => frame.image);
      const frame = {
        line: inlineLine,
        image: name === 'image',
        destinations: [] as Destination[],
      };
      frames.push(frame);
      try {
        const matched = rule(state, silent);
        if (matched && !silent && !suppressed) retain(frame);
        return matched;
      } finally {
        frames.pop();
      }
    });
  }
  const reference = markdown.block.ruler
    .getRules('')
    .find((candidate) => candidate.name === 'reference');
  if (!reference) throw new Error('Knowledge package Markdown parser is unavailable.');
  markdown.block.ruler.at('reference', (state, start, end, silent) => {
    const frame = { line: start, image: false, destinations: [] as Destination[] };
    frames.push(frame);
    try {
      const matched = reference(state, start, end, silent);
      if (matched && !silent) retain(frame);
      return matched;
    } finally {
      frames.pop();
    }
  });
  // Keep the standard inline parser and attach only its source line map for byte-preserving edits.
  markdown.core.ruler.at('inline', (state) => {
    for (const token of state.tokens)
      if (token.type === 'inline') {
        inlineLine = token.map?.[0] ?? 0;
        markdown.inline.parse(token.content, markdown, state.env, token.children!);
      }
  });
  markdown.parse(body, {});
  let result = body;
  for (const [start, edit] of [...edits].sort(([left], [right]) => right - left))
    result = result.slice(0, start) + edit.text + result.slice(edit.end);
  return result;
}

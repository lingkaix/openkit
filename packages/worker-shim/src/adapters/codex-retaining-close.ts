import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Native 0.160.0 context marker omitted from thread/read after a requested interruption. */
const INTERRUPTED_CONTEXT =
  '<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>';

/** Exact last settled native Turn, retained only for this binding's close qualification. */
export interface CodexCloseTerminal {
  /** Native Turn identity from the correlated terminal. */
  readonly id: string;
  /** Exact text submitted by the bound Turn. */
  readonly input: string;
  /** Native terminal classification, independent of normalized result. */
  readonly status: string;
  /** Native assistant messages observed before settlement. */
  readonly texts: readonly string[];
}

/** Reads a bounded regular rollout without following a replacement symlink or forgiving torn JSONL. */
export async function readCodexCloseRollout(path: string, threadId: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size === 0 || before.size > 16 * 1024 * 1024)
      throw new Error('Codex retained close history is outside its inspection bound.');
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await file.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) throw new Error('Codex retained close history ended early.');
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('Codex retained close history changed during inspection.');
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!lines.endsWith('\n')) throw new Error('Codex retained close history is torn.');
    const frames = lines
      .slice(0, -1)
      .split('\n')
      .map((line) => JSON.parse(line));
    const meta = frames[0];
    if (
      meta?.type !== 'session_meta' ||
      meta.payload?.id !== threadId ||
      meta.payload?.history_mode !== 'paginated' ||
      meta.payload?.cli_version !== '0.160.0'
    )
      throw new Error('Codex retained close history mode or identity is unqualified.');
    let worldStateReady = false;
    for (const [index, frame] of frames.entries()) {
      if (
        !frame ||
        typeof frame !== 'object' ||
        Array.isArray(frame) ||
        !['session_meta', 'response_item', 'turn_context', 'world_state', 'event_msg'].includes(
          frame.type
        ) ||
        !frame.payload ||
        typeof frame.payload !== 'object' ||
        Array.isArray(frame.payload) ||
        frame.ordinal !== index
      )
        throw new Error(
          'Codex retained close history is malformed, incomplete or outside the qualified path.'
        );
      if (frame.type === 'world_state') {
        if (
          typeof frame.payload.full !== 'boolean' ||
          !frame.payload.state ||
          typeof frame.payload.state !== 'object' ||
          Array.isArray(frame.payload.state) ||
          (!frame.payload.full && !worldStateReady)
        )
          throw new Error('Codex retaining close world-state checkpoint dependency is unproved.');
        worldStateReady ||= frame.payload.full;
      }
      if (
        frame.type === 'event_msg' &&
        typeof frame.payload.type === 'string' &&
        frame.payload.type.startsWith('collab_')
      )
        throw new Error('Codex retaining close child-writer context is unqualified.');
    }
    return bytes;
  } finally {
    await file.close();
  }
}

/** Reconciles the successful paginated barrier with the exact raw terminal and native assistant context. */
export function requireCodexCloseHistory(
  history: unknown,
  bytes: Buffer,
  threadId: string,
  terminal: CodexCloseTerminal
): void {
  const body = history as { thread?: { id?: unknown; historyMode?: unknown; turns?: unknown } };
  const thread = body?.thread;
  if (thread?.id !== threadId || thread.historyMode !== 'paginated' || !Array.isArray(thread.turns))
    throw new Error('Codex retaining close requires the exact paginated read barrier.');
  const last = thread.turns.at(-1);
  if (last?.id !== terminal.id || last.status !== terminal.status || !Array.isArray(last.items))
    throw new Error('Codex retaining close history does not match the settled Turn.');
  const inputs = last.items
    .filter((item: { type?: string }) => item?.type === 'userMessage')
    .flatMap((item: { content?: { type?: string; text?: unknown }[] }) =>
      Array.isArray(item.content)
        ? item.content.filter((entry) => entry?.type === 'text').map((entry) => entry.text)
        : []
    );
  if (inputs.length !== 1 || inputs[0] !== terminal.input)
    throw new Error('Codex retaining close user context does not match.');
  const texts = last.items
    .filter((item: { type?: string }) => item?.type === 'agentMessage')
    .map((item: { text?: unknown }) => item.text);
  if (JSON.stringify(texts) !== JSON.stringify(terminal.texts))
    throw new Error('Codex retaining close assistant context does not match.');
  const frames = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const retainedInput = frames.some(
    (frame) =>
      frame.type === 'response_item' &&
      frame.payload.type === 'message' &&
      frame.payload.role === 'user' &&
      frame.payload.internal_chat_message_metadata_passthrough?.turn_id === terminal.id &&
      Array.isArray(frame.payload.content) &&
      frame.payload.content.some(
        (content: { type?: string; text?: unknown }) =>
          content?.type === 'input_text' && content.text === terminal.input
      )
  );
  if (!retainedInput) throw new Error('Codex retaining close has no exact retained user input.');
  const retainedTexts = frames
    .filter(
      (frame) =>
        frame.type === 'response_item' &&
        frame.payload.type === 'message' &&
        frame.payload.role === 'assistant' &&
        frame.payload.internal_chat_message_metadata_passthrough?.turn_id === terminal.id
    )
    .map((frame) => {
      if (!Array.isArray(frame.payload.content))
        throw new Error('Codex retaining close retained assistant context is malformed.');
      return frame.payload.content
        .filter((content: { type?: string }) => content?.type === 'output_text')
        .map((content: { text?: unknown }) => {
          if (typeof content.text !== 'string')
            throw new Error('Codex retaining close retained assistant context is malformed.');
          return content.text;
        })
        .join('');
    });
  if (JSON.stringify(retainedTexts) !== JSON.stringify(terminal.texts))
    throw new Error('Codex retaining close retained assistant context does not match.');
  const terminals = frames.filter(
    (frame) =>
      frame.type === 'event_msg' &&
      ['task_complete', 'turn_aborted'].includes(frame.payload.type) &&
      frame.payload.turn_id === terminal.id
  );
  if (
    terminals.length !== 1 ||
    (terminal.status === 'completed'
      ? terminals[0].payload.type !== 'task_complete' ||
        terminals[0].payload.last_agent_message !== (terminal.texts.at(-1) ?? null)
      : terminal.status !== 'interrupted' ||
        terminals[0].payload.type !== 'turn_aborted' ||
        terminals[0].payload.reason !== 'interrupted')
  )
    throw new Error(
      `Codex retaining close has no exact raw ${terminal.status === 'interrupted' ? 'interrupted' : 'completed'} terminal.`
    );
  // The barrier represents the complete retained conversation, not only its last Turn.
  // Other item shapes stay unqualified until their native retained projection is established.
  const turnIds = new Set<string>();
  const barrierMessages: Array<{ turnId: string; role: string; texts: string[] }> = [];
  const settled: Array<{ turnId: string; status: string; lastMessage?: string | null }> = [];
  const interrupted = new Set<string>();
  for (const turn of thread.turns) {
    if (
      !turn ||
      typeof turn.id !== 'string' ||
      !turn.id ||
      turnIds.has(turn.id) ||
      !['completed', 'interrupted'].includes(turn.status) ||
      !Array.isArray(turn.items)
    )
      throw new Error('Codex retaining close earlier Turn context is unqualified.');
    turnIds.add(turn.id);
    let lastMessage: string | null = null;
    for (const item of turn.items) {
      if (
        item?.type === 'userMessage' &&
        Array.isArray(item.content) &&
        item.content.length &&
        item.content.every(
          (content: { type?: unknown; text?: unknown }) =>
            content?.type === 'text' && typeof content.text === 'string'
        )
      ) {
        barrierMessages.push({
          turnId: turn.id,
          role: 'user',
          texts: item.content.map((content: { text: string }) => content.text),
        });
      } else if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        lastMessage = item.text;
        barrierMessages.push({ turnId: turn.id, role: 'assistant', texts: [item.text] });
      } else {
        throw new Error('Codex retaining close barrier item context is unqualified.');
      }
    }
    if (turn.status === 'interrupted') interrupted.add(turn.id);
    settled.push({
      turnId: turn.id,
      status: turn.status,
      ...(turn.status === 'completed' ? { lastMessage } : {}),
    });
  }
  // thread/read omits the exact native abort marker from this qualified text-only history.
  // The unchanged-prefix proof still covers its bytes through orderly EOF.
  // Tool and child-writer histories remain unqualified; the generic warning is not cleanup proof.
  const abortPositions = new Map<string, number>();
  for (const [index, frame] of frames.entries()) {
    if (
      frame.type === 'event_msg' &&
      frame.payload.type === 'turn_aborted' &&
      frame.payload.reason === 'interrupted'
    )
      abortPositions.set(frame.payload.turn_id, index);
  }
  const markers = new Set<string>();
  for (const [index, frame] of frames.entries()) {
    if (
      frame.type !== 'response_item' ||
      JSON.stringify(
        frame.payload.internal_chat_message_metadata_passthrough?.content_item_kinds
      ) !== JSON.stringify(['generic.turn_aborted'])
    )
      continue;
    const id = frame.payload.internal_chat_message_metadata_passthrough?.turn_id;
    const abortIndex = abortPositions.get(id);
    if (
      !interrupted.has(id) ||
      markers.has(id) ||
      frame.payload.type !== 'message' ||
      frame.payload.role !== 'user' ||
      !Array.isArray(frame.payload.content) ||
      frame.payload.content.length !== 1 ||
      frame.payload.content[0]?.type !== 'input_text' ||
      frame.payload.content[0]?.text !== INTERRUPTED_CONTEXT ||
      abortIndex === undefined ||
      abortIndex <= index
    )
      throw new Error('Codex retaining close abort context is unqualified.');
    markers.add(id);
  }
  if (markers.size !== interrupted.size)
    throw new Error('Codex retaining close abort context is incomplete.');
  if (
    frames.some(
      (frame) =>
        frame.type === 'response_item' &&
        (frame.payload.type !== 'message' ||
          !['developer', 'user', 'assistant'].includes(frame.payload.role))
    )
  )
    throw new Error('Codex retaining close retained item context is unqualified.');
  const retainedMessages = frames
    .filter(
      (frame) =>
        frame.type === 'response_item' &&
        frame.payload.type === 'message' &&
        ['user', 'assistant'].includes(frame.payload.role) &&
        // The pinned native environment prelude is absent from thread/read userMessage items.
        // Its bytes remain covered by the unchanged rollout-prefix check.
        !(
          frame.payload.role === 'user' &&
          turnIds.has(frame.payload.internal_chat_message_metadata_passthrough?.turn_id) &&
          JSON.stringify(
            frame.payload.internal_chat_message_metadata_passthrough?.content_item_kinds
          ) === JSON.stringify(['environments.environment_context'])
        ) &&
        JSON.stringify(
          frame.payload.internal_chat_message_metadata_passthrough?.content_item_kinds
        ) !== JSON.stringify(['generic.turn_aborted'])
    )
    .map((frame) => {
      const { role, content, internal_chat_message_metadata_passthrough: metadata } = frame.payload;
      if (
        !turnIds.has(metadata?.turn_id) ||
        (role === 'user' &&
          (!Array.isArray(metadata?.content_item_kinds) ||
            metadata.content_item_kinds.length !== content?.length ||
            !metadata.content_item_kinds.every((kind: unknown) => kind === 'user.text'))) ||
        !Array.isArray(content) ||
        !content.length ||
        !content.every(
          (part: { type?: unknown; text?: unknown }) =>
            part?.type === (role === 'user' ? 'input_text' : 'output_text') &&
            typeof part.text === 'string'
        )
      )
        throw new Error('Codex retaining close retained message context is unqualified.');
      const texts = content.map((part: { text: string }) => part.text);
      return { turnId: metadata.turn_id, role, texts: role === 'user' ? texts : [texts.join('')] };
    });
  if (JSON.stringify(retainedMessages) !== JSON.stringify(barrierMessages))
    throw new Error('Codex retaining close whole retained history does not match the barrier.');
  const retainedSettled = frames
    .filter(
      (frame) =>
        frame.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(frame.payload.type)
    )
    .map((frame) => {
      if (frame.payload.type === 'turn_aborted') {
        if (frame.payload.reason !== 'interrupted')
          throw new Error('Codex retaining close abort reason is unqualified.');
        return { turnId: frame.payload.turn_id, status: 'interrupted' };
      }
      return {
        turnId: frame.payload.turn_id,
        status: 'completed',
        lastMessage: frame.payload.last_agent_message,
      };
    });
  if (JSON.stringify(retainedSettled) !== JSON.stringify(settled))
    throw new Error('Codex retaining close whole raw terminal history does not match the barrier.');
  const lastContext = frames.filter((frame) => frame.type === 'turn_context').at(-1);
  if (lastContext?.payload.turn_id !== terminal.id)
    throw new Error('Codex retaining close context advanced beyond the settled Turn.');
}

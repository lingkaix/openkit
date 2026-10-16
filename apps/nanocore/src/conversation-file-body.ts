import { Readable } from 'node:stream';
import { MAX_CONVERSATION_FILE_METADATA_BYTES } from '@openkit/app-api-schemas';
import { OperationError } from './operation-error.js';

export {
  CONVERSATION_FILE_MEDIA_TYPE,
  MAX_CONVERSATION_FILE_METADATA_BYTES,
} from '@openkit/app-api-schemas';

/** Reads bounded framing and lends one ordered payload stream at a time without collecting originals. */
export class ConversationFileBody {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private ended = false;
  private readonly abort = () => {
    void this.reader.cancel().catch(() => {});
  };

  /** Takes exclusive ownership of this request body until cleanup. */
  constructor(
    body: ReadableStream<Uint8Array>,
    private readonly signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    this.reader = body.getReader();
    signal?.addEventListener('abort', this.abort, { once: true });
  }

  /** Reads only the bounded metadata prefix before operation admission. */
  async metadata(): Promise<unknown> {
    const prefix = await this.bytes(4);
    const length = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, false);
    if (length === 0 || length > MAX_CONVERSATION_FILE_METADATA_BYTES) throw invalidFrame();
    const bytes = await this.bytes(length);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw invalidFrame();
    }
  }

  /** Supplies exactly one admitted part, in bounded chunks, without closing the shared request reader. */
  payload(byteLength: number): Readable {
    const source = this;
    return Readable.from(
      (async function* () {
        let remaining = byteLength;
        while (remaining > 0) {
          const bytes = await source.next(Math.min(65_536, remaining));
          if (!bytes.length) throw invalidFrame();
          remaining -= bytes.length;
          yield bytes;
        }
      })()
    );
  }

  /** Refuses undeclared bytes, including bytes after a zero-length final input. */
  async assertEnd(): Promise<void> {
    if ((await this.next(1)).length) throw invalidFrame();
  }

  /** Cancels unread retry bytes or an invalid request and releases reader ownership. */
  async cancel(): Promise<void> {
    this.signal?.removeEventListener('abort', this.abort);
    await this.reader.cancel().catch(() => {});
    this.reader.releaseLock();
  }

  /** Collects only a length prefix or bounded JSON metadata. */
  private async bytes(length: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = await this.next(length - offset);
      if (!chunk.length) throw invalidFrame();
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  /** Retains at most the source's current chunk and never reads ahead into a later part. */
  private async next(limit: number): Promise<Uint8Array> {
    while (this.offset === this.chunk.length && !this.ended) {
      const next = await this.reader.read();
      this.ended = next.done;
      this.chunk = next.value ?? new Uint8Array(0);
      this.offset = 0;
    }
    const end = Math.min(this.chunk.length, this.offset + limit);
    const bytes = this.chunk.subarray(this.offset, end);
    this.offset = end;
    return bytes;
  }
}

/** Keeps framing diagnostics independent from submitted names, paths, or content. */
function invalidFrame(): OperationError {
  return new OperationError('invalid_request', 'Conversation file framing is invalid.', 400);
}

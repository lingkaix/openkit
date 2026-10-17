import type { Readable } from 'node:stream';

/** Exact immutable file result owned by the existing Worker file-effect receipt. */
export interface CapturedWorkerFile {
  /** Actual bytes and SHA-256 verified by the retained file effect. */
  readonly byteLength: number;
  readonly contentDigest: string;
  /** One bounded-memory stream; the source owner rechecks its retained byte identity. */
  readonly source: Readable;
  /** Removes the private transport copy after capture or refusal; never accepts product work. */
  remove(): Promise<void>;
}

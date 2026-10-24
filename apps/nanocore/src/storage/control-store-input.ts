import { createHash } from 'node:crypto';
import { z } from 'zod';

type PresentFacts<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Projects validated wire facts to exact optional owner inputs; null and nested JSON remain unchanged. */
export function presentControlFacts<const T extends object>(input: T): PresentFacts<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as PresentFacts<T>;
}

/** One complete scalar in the existing request-owned UTF-8 binary carrier. */
export const ControlScalarTextSchema = z
  .object({
    byteLength: z.number().int().nonnegative().safe(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
/** Closed scalar framing; it carries no field selector or executable binding. */
export type ControlScalarText = z.infer<typeof ControlScalarTextSchema>;

/** Computes exact framing after shared binary capacity admission, without allocating a payload buffer. */
export function frameControlScalarText(text: string): ControlScalarText {
  if (!(text as string & { isWellFormed(): boolean }).isWellFormed())
    throw new TypeError('Native scalar text has no exact UTF-8 representation.');
  return {
    byteLength: Buffer.byteLength(text),
    digest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
  };
}

/** Verifies the complete transferred scalar before SQL; BOM is content and malformed UTF-8 refuses. */
export function readControlScalarText(span: ControlScalarText, content?: ArrayBuffer): string {
  if (!(content instanceof ArrayBuffer) || content.byteLength !== span.byteLength)
    throw new TypeError('Native scalar binary length is inconsistent.');
  const bytes = new Uint8Array(content);
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== span.digest)
    throw new TypeError('Native scalar binary digest is inconsistent.');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

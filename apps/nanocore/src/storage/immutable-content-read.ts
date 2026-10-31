import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContentReferenceSchema } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import type { ControlProductContentMount, ControlProductOwner } from './control-store-products.js';

/** Reads exact immutable bytes through one trusted product mount and owner binding. */
export function readImmutableContentBytes(
  mount: ControlProductContentMount,
  owner: ControlProductOwner,
  content: { readonly reference: unknown; readonly byteLength: number },
  requiredByteCap: number
): Uint8Array {
  const reference = ContentReferenceSchema.parse(content.reference);
  if (
    reference.range !== null ||
    reference.availability !== 'available' ||
    reference.knowledgeBaseId !== mount.knowledgeBaseId ||
    reference.locator.mount !== mount.mount ||
    !isDeepStrictEqual(reference.locator.ownerScope, owner) ||
    !Number.isSafeInteger(content.byteLength) ||
    content.byteLength < 0 ||
    content.byteLength > requiredByteCap
  )
    throw new Error('Control product immutable binding is recovery_required.');
  const root = realpathSync(mount.root);
  if (root !== resolve(mount.root))
    throw new Error('Control product immutable mount is recovery_required.');
  const path = resolve(root, reference.locator.path);
  const rel = relative(root, path);
  if (
    !rel ||
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    throw new Error('Control product immutable path is recovery_required.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== content.byteLength)
      throw new Error('Control product immutable size is recovery_required.');
    const bytes = readFileSync(fd);
    if (`sha256:${sha256Hex(bytes)}` !== reference.contentDigest)
      throw new Error('Control product immutable digest is recovery_required.');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

import { Buffer } from 'node:buffer';

const MAX_PAYLOAD_BYTES = 65_536;

/** Decoded signing request; algorithm compatibility and authority belong to the signer. */
export interface SshAgentSignRequest {
  /** Opaque SSH public-key blob selected by the native client. */
  readonly keyBlob: Buffer;
  /** Exact bytes to sign, including a permitted empty string. */
  readonly data: Buffer;
  /** Zero, RSA SHA-256, or RSA SHA-512 flag. */
  readonly flags: number;
}

/** Injected effects; no listener, private key or signing implementation lives in this codec. */
export interface SshAgentCallbacks {
  /** Return public identities with Buffer keyBlob and string comment, in display order. */
  identities(): unknown | Promise<unknown>;
  /** Return an encoded SSH signature Buffer, or refuse; Core owns approved signing. */
  sign(request: SshAgentSignRequest): unknown | Promise<unknown>;
}

/** Reject malformed framing or callback output without carrying their bytes into an error. */
function invalid(): never {
  throw new Error('Invalid SSH agent message.');
}

/** Encode one validated network-order integer. */
function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

/** Encode a bounded SSH string. The enclosing frame applies its own aggregate bound. */
function sshString(value: Buffer): Buffer {
  if (value.length > MAX_PAYLOAD_BYTES) invalid();
  return Buffer.concat([uint32(value.length), value]);
}

/** Encode exactly one response, counting its type byte in the payload length. */
function response(type: number, fields: readonly Buffer[]): Buffer {
  const length = 1 + fields.reduce((sum, field) => sum + field.length, 0);
  if (length > MAX_PAYLOAD_BYTES) invalid();
  return Buffer.concat([uint32(length), Buffer.from([type]), ...fields]);
}

/** Validate a whole identity answer before publishing any part of it. */
function identitiesResponse(value: unknown): Buffer {
  if (!Array.isArray(value) || value.length > Math.floor((MAX_PAYLOAD_BYTES - 5) / 9)) invalid();
  const fields = [uint32(value.length)];
  let length = 5;
  for (const identity of value) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) invalid();
    const key = identity.keyBlob;
    const comment = identity.comment;
    if (!Buffer.isBuffer(key) || key.length === 0 || typeof comment !== 'string') invalid();
    const commentLength = Buffer.byteLength(comment, 'utf8');
    length += 8 + key.length + commentLength;
    if (length > MAX_PAYLOAD_BYTES) invalid();
    fields.push(sshString(key), sshString(Buffer.from(comment, 'utf8')));
  }
  return response(12, fields);
}

/** Decode two bounded SSH strings and one exact flags word from a complete sign frame. */
function signRequest(frame: Buffer): SshAgentSignRequest {
  let offset = 5;
  const strings: Buffer[] = [];
  for (let index = 0; index < 2; index++) {
    if (offset + 4 > frame.length) invalid();
    const length = frame.readUInt32BE(offset);
    offset += 4;
    if (length > frame.length - offset) invalid();
    // Give the callback owned bytes, not views into a caller's mutable frame.
    strings.push(Buffer.from(frame.subarray(offset, offset + length)));
    offset += length;
  }
  if (offset + 4 !== frame.length || strings[0]!.length === 0) invalid();
  const flags = frame.readUInt32BE(offset);
  if (flags !== 0 && flags !== 2 && flags !== 4) invalid();
  return { keyBlob: strings[0]!, data: strings[1]!, flags };
}

/**
 * Handle one complete restricted SSH agent frame from RFC 9987 sections 5 and 8.
 * Only identities and signing are admitted; no key mutations, stream state or signing authority.
 * @param frame Exactly one length-prefixed request, with payload at most 65,536 bytes.
 * @param callbacks Injected public-identity and approved-signing effects.
 * @returns A complete identities/signature response, or the fixed SSH_AGENT_FAILURE frame.
 */
export async function handleSshAgentFrame(
  frame: Buffer,
  callbacks: SshAgentCallbacks
): Promise<Buffer> {
  try {
    if (!Buffer.isBuffer(frame) || frame.length < 5 || frame.length > MAX_PAYLOAD_BYTES + 4)
      invalid();
    const length = frame.readUInt32BE(0);
    if (length < 1 || length > MAX_PAYLOAD_BYTES || length !== frame.length - 4) invalid();
    switch (frame[4]) {
      case 11:
        if (length !== 1) invalid();
        return identitiesResponse(await callbacks.identities());
      case 13: {
        const request = signRequest(frame);
        const signature = await callbacks.sign(request);
        if (!Buffer.isBuffer(signature) || signature.length === 0) invalid();
        return response(14, [sshString(signature)]);
      }
      default:
        return Buffer.from([0, 0, 0, 1, 5]);
    }
  } catch {
    return Buffer.from([0, 0, 0, 1, 5]);
  }
}

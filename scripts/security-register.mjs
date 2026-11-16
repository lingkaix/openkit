/** Decode the private register transport without changing its JSON schema or admission authority. */
import { gunzipSync } from 'node:zlib';

const prefix = 'gzip+base64:';
const maxOutputLength = 4 * 1024 * 1024;

/** Read raw JSON or canonical base64 gzip; never reflect private bytes in a refusal. */
export function readSecurityFindingRegister(value) {
  try {
    let json = value;
    if (typeof value !== 'string') throw Error();
    if (value.startsWith(prefix)) {
      const payload = value.slice(prefix.length);
      if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload)) throw Error();
      const compressed = Buffer.from(payload, 'base64');
      // Buffer's decoder accepts ignored characters and nonzero pad bits; this transport does not.
      if (compressed.toString('base64') !== payload) throw Error();
      const bytes = gunzipSync(compressed, { maxOutputLength });
      // Fatal UTF-8 decoding prevents replacement characters from changing a private binding.
      // Preserve a BOM so JSON.parse retains the same refusal as the raw JSON path.
      json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    return JSON.parse(json);
  } catch {
    throw Error('Release finding gate refused');
  }
}

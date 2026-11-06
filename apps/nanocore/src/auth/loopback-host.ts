import { isIP } from 'node:net';

/**
 * Checks whether a hostname is loopback.
 *
 * @param hostname URL hostname.
 * @returns True for localhost, IPv4 127/8, or IPv6 loopback.
 */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');

  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }

  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHost(normalized.slice('::ffff:'.length));
  }

  return isIP(normalized) === 4 && normalized.split('.')[0] === '127';
}

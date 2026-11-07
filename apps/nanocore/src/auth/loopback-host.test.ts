import { describe, expect, it } from 'vitest';
import { isLoopbackHost } from './loopback-host.js';

describe('isLoopbackHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    '::1',
    '[::1]',
    '127.0.0.1',
    '127.0.0.2',
    '127.255.255.254',
    '::ffff:127.0.0.1',
    '[::ffff:127.0.0.1]',
    '::ffff:127.0.0.2',
    '::ffff:localhost',
  ])('admits loopback host %s', (hostname) => {
    expect(isLoopbackHost(hostname)).toBe(true);
  });

  it.each([
    '::ffff:10.0.0.1',
    '10.0.0.1',
    '128.0.0.1',
    '127.0.0.1.attacker.example',
    'localhost.attacker.example',
    '127.evil.example',
    '',
    '[::ffff:10.0.0.1]',
  ])('rejects non-loopback host %s', (hostname) => {
    expect(isLoopbackHost(hostname)).toBe(false);
  });
});

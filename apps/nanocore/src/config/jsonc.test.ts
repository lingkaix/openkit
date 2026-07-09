import { describe, expect, it } from 'vitest';

import { parseJsoncObject } from './jsonc.js';

describe('parseJsoncObject', () => {
  it('parses comments and trailing commas into a plain object', () => {
    const parsed = parseJsoncObject(
      `{
        // NanoCore mode selected by the operator.
        "mode": "server",
        "defaults": {
          "workspaceId": "ws_demo",
        },
      }`,
      'server.jsonc'
    );

    expect(parsed).toEqual({
      mode: 'server',
      defaults: {
        workspaceId: 'ws_demo',
      },
    });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it('rejects invalid JSONC with source context', () => {
    expect(() => parseJsoncObject('{ "mode": ', 'broken.server.jsonc')).toThrow(
      /Invalid JSONC in broken.server.jsonc/
    );
  });
});

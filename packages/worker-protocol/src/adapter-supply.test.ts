import { describe, expect, it } from 'vitest';
import * as workerProtocol from './index.js';

describe('release-owned adapter supply declaration', () => {
  it('exports filesystem Skill qualification for the four verified native adapters', () => {
    expect(workerProtocol).toHaveProperty('WORKER_ADAPTER_SUPPLY_FORMS', {
      codex: ['skill-filesystem-copy'],
      pi: ['skill-filesystem-copy'],
      opencode: ['skill-filesystem-copy'],
      deepseek: ['skill-filesystem-copy'],
    });
  });

  it('prevents runtime reports from mutating either membership or declared forms', () => {
    const table = Reflect.get(workerProtocol, 'WORKER_ADAPTER_SUPPLY_FORMS');
    expect(table).toBeDefined();
    expect(Object.isFrozen(table)).toBe(true);
    expect(() => Object.assign(table, { unqualified: ['skill-filesystem-copy'] })).toThrow(
      TypeError
    );
    for (const forms of Object.values(table)) {
      expect(Object.isFrozen(forms)).toBe(true);
      expect(() => Object.assign(forms, { 0: 'unqualified-supply' })).toThrow(TypeError);
    }
    expect(Object.hasOwn(table, '__proto__')).toBe(false);
  });
});

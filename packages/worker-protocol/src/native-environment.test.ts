import { describe, expect, it } from 'vitest';
import {
  AuthoredNativeEnvironmentSchema,
  canonicalNativeEnvironment,
  isProtectedNativeEnvironmentName,
  NativeEnvironmentRecordSchema,
  NativeEnvironmentValuesSchema,
} from './native-environment.js';

const emptyDigest = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
describe('native environment core', () => {
  it('keeps literal empty values and null authored removals in canonical key order', () => {
    expect(AuthoredNativeEnvironmentSchema.parse({ Z: null, A: '' })).toEqual({ Z: null, A: '' });
    expect(canonicalNativeEnvironment({ B: '', A: 'x=y\n' })).toBe('{"A":"x=y\\n","B":""}');
    expect(NativeEnvironmentValuesSchema.safeParse({ Z: null }).success).toBe(false);
  });
  it.each([
    '',
    'BAD-NAME',
    '1BAD',
    'é',
    'A'.repeat(129),
  ])('refuses consumed invalid name %j', (name) => {
    expect(AuthoredNativeEnvironmentSchema.safeParse({ [name]: 'value' }).success).toBe(false);
    expect(NativeEnvironmentValuesSchema.safeParse({ [name]: 'value' }).success).toBe(false);
  });
  it('admits exact name/count/UTF-8 boundaries and refuses one byte or entry over them', () => {
    expect(NativeEnvironmentValuesSchema.safeParse({ ['A'.repeat(128)]: '' }).success).toBe(true);
    const entries = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`NAME_${i}`, '']));
    expect(NativeEnvironmentValuesSchema.safeParse(entries).success).toBe(true);
    expect(NativeEnvironmentValuesSchema.safeParse({ ...entries, EXTRA: '' }).success).toBe(false);
    expect(NativeEnvironmentValuesSchema.safeParse({ A: 'x'.repeat(16 * 1024 - 8) }).success).toBe(
      true
    );
    expect(NativeEnvironmentValuesSchema.safeParse({ A: 'x'.repeat(16 * 1024 - 7) }).success).toBe(
      false
    );
    expect(NativeEnvironmentValuesSchema.safeParse({ A: 'é'.repeat(8192) }).success).toBe(false);
  });
  it.each(['x\0', '\ud800', '\udc00'])('refuses unrepresentable value %j', (value) => {
    expect(NativeEnvironmentValuesSchema.safeParse({ A: value }).success).toBe(false);
  });
  it('rejects non-literal maps and non-string values without silently dropping authority', () => {
    for (const value of [
      null,
      [],
      'map',
      Object.create({ A: 'inherited' }),
      { A: 1 },
      { A: undefined },
      { A: false },
      { A: {} },
      { [Symbol('hidden')]: 'value' },
      Object.defineProperty({}, 'A', { value: 'hidden' }),
    ])
      expect(NativeEnvironmentValuesSchema.safeParse(value).success).toBe(false);
  });
  it('refuses unowned required semantics and authority-bearing record fields', () => {
    const core = {
      imageDigest: `sha256:${'a'.repeat(64)}`,
      defaultsDigest: emptyDigest,
      values: {},
    };
    for (const field of ['requiredFeatures', 'minCoreVersion', 'env', 'runtimeEnvironment'])
      expect(NativeEnvironmentRecordSchema.safeParse({ ...core, [field]: {} }).success).toBe(false);
    expect(
      NativeEnvironmentRecordSchema.safeParse({ ...core, defaultsDigest: 'tag' }).success
    ).toBe(false);
  });
  it('treats prototype-looking valid identifiers as consumed literal variable names', () => {
    const values = JSON.parse('{"__proto__":"literal","constructor":"own"}');
    expect(NativeEnvironmentValuesSchema.parse(values)).toEqual(values);
  });
  it('validates required identities while discarding inert additive record metadata', () => {
    const core = {
      imageDigest: `sha256:${'a'.repeat(64)}`,
      defaultsDigest: emptyDigest,
      values: {},
    };
    expect(NativeEnvironmentRecordSchema.parse({ ...core, note: 'ignored' })).toEqual(core);
    expect(NativeEnvironmentRecordSchema.safeParse({ ...core, imageDigest: 'tag' }).success).toBe(
      false
    );
    expect(NativeEnvironmentRecordSchema.safeParse({ values: {} }).success).toBe(false);
  });
  it('protects actual bootstrap/adapter bindings while leaving benign vendor names and native PATH open', () => {
    for (const name of [
      'HOME',
      'NODE_OPTIONS',
      'OPENKIT_CONTROL',
      'NO_PROXY',
      'BASH_ENV',
      'npm_config_nodedir',
    ])
      expect(isProtectedNativeEnvironmentName(name, 'pi')).toBe(true);
    expect(isProtectedNativeEnvironmentName('PI_CODING_AGENT_DIR', 'pi')).toBe(true);
    expect(isProtectedNativeEnvironmentName('OPENCODE_CONFIG', 'opencode')).toBe(true);
    for (const name of ['PATH', 'LANG', 'VENDOR_SETTING', 'PI_SETTING', 'OPENCODE_SETTING'])
      expect(isProtectedNativeEnvironmentName(name, 'pi')).toBe(false);
    expect(isProtectedNativeEnvironmentName('OPENCODE_SETTING', 'opencode')).toBe(false);
  });
  it.each([
    'DSH_HOME',
    'DSH_PERMISSION_MODE',
    'DSH_TELEMETRY_MODE',
    'DSH_TELEMETRY_OTLP_URL',
  ])('protects the DeepSeek binding %s only for DeepSeek', (name) => {
    expect(isProtectedNativeEnvironmentName(name, 'deepseek')).toBe(true);
    for (const adapter of ['codex', 'pi', 'opencode', 'future-adapter'])
      expect(isProtectedNativeEnvironmentName(name, adapter)).toBe(false);
  });
  it.each([
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'CODEX_ROLLOUT_TRACE_ROOT',
  ])('protects the pinned Codex binding %s only for Codex', (name) => {
    expect(isProtectedNativeEnvironmentName(name, 'codex')).toBe(true);
    for (const adapter of ['deepseek', 'pi', 'opencode', 'future-adapter'])
      expect(isProtectedNativeEnvironmentName(name, adapter)).toBe(false);
  });
  it.each([
    'OPENAI_LOG',
    'CODEX_BIN',
    'CODEX_ARGS',
    'CODEX_EXECUTABLE',
  ])('admits unused Codex name %s', (name) => {
    expect(isProtectedNativeEnvironmentName(name, 'codex')).toBe(false);
  });
  it('keeps Codex home protection specific to Codex', () => {
    expect(isProtectedNativeEnvironmentName('CODEX_HOME', 'codex')).toBe(true);
    for (const adapter of ['deepseek', 'pi', 'opencode', 'future-adapter'])
      expect(isProtectedNativeEnvironmentName('CODEX_HOME', adapter)).toBe(false);
    expect(isProtectedNativeEnvironmentName('DSH_PUBLIC_SETTING', 'deepseek')).toBe(false);
  });
});

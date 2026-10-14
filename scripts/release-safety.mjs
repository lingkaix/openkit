/** Shared release evidence: credential-safe retention, canonical identities and single-shot effects. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

/** Hex SHA-256 identity for retained bytes and manifests. */
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Canonical JSON preserves array order and sorts object keys; absent optional values stay absent. */
export function canonical(value) {
  function sort(v) {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => [k, sort(v[k])])
      );
    return v;
  }
  return JSON.stringify(sort(value));
}
const SECRET =
  /\b(?:gh[pousr]_|github_pat_|okt_|okw_|sk-)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/-]{8,}=*|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|[a-z]+:\/\/[^\s/@]+:[^\s/@]+@/gi;
const secretKey =
  /^(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|headerValue|capabilityCredential|inferenceCredential)$/i;

/** Retain authority-bearing objects while redacting scalar credential leaves and text. */
export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
    return value
      .replace(SECRET, '[redacted]')
      .replace(
        /((?:password|api[_-]?key|access[_-]?token|client_secret)\s*[:=]\s*)["']?[^\s,;"'}]+["']?/gi,
        '$1[redacted]'
      );
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secretKey.test(k) && typeof v === 'string'
          ? '[redacted]'
          : /^(env|environment|headers)$/i.test(k) && v && typeof v === 'object'
            ? Object.fromEntries(Object.keys(v).map((n) => [n, '[redacted]']))
            : redact(v, secrets),
      ])
    );
  return value;
}
/** Refuse authority inputs that would need redaction rather than silently changing them. */
export function noSecrets(value) {
  if (JSON.stringify(redact(value)) !== JSON.stringify(value))
    throw Error('Secret-shaped input refused');
}
/** Decode retained JSON without transport, interpretation or recovery. */
export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
/** Write private redacted bytes exclusively unless the same owner updates its projection. */
export async function save(file, value, secrets = [], exclusive = true) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(redact(value, secrets), null, 2)}\n`, {
    flag: exclusive ? 'wx' : 'w',
    mode: 0o600,
  });
}

/** Open the credential through a non-following descriptor; never copy it to evidence. */
export async function credential(file) {
  const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (!s.isFile() || (s.mode & 0o777) !== 0o600)
      throw Error('Credential file must be regular mode 0600');
    const v = (await h.readFile('utf8')).trim();
    if (!v) throw Error('Empty credential');
    return v;
  } finally {
    await h.close();
  }
}
/** Capture child output without a shell, including timeout and process exit. */
export function execute(executable, args, { input, cwd, env, timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(executable, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false;
    c.stdout.setEncoding('utf8');
    c.stderr.setEncoding('utf8');
    c.stdout.on('data', (v) => {
      stdout += v;
    });
    c.stderr.on('data', (v) => {
      stderr += v;
    });
    c.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      c.kill('SIGKILL');
    }, timeout);
    c.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
    c.stdin.on('error', () => {});
    c.stdin.end(input);
  });
}
/** Create an exclusive receipt before an effect so ambiguity or crashes cannot replay it. */
export async function once(dir, name, input, effect, secrets = []) {
  noSecrets(input);
  const requestId = input.requestId ?? randomUUID();
  await save(path.join(dir, `${name}-intent.json`), {
    input,
    requestId,
    startedAt: new Date().toISOString(),
  });
  try {
    const result = await effect();
    await save(path.join(dir, `${name}-result.json`), result, secrets);
    return result;
  } catch (e) {
    await save(
      path.join(dir, `${name}-ambiguous.json`),
      { status: 'inspection-required', error: String(e) },
      secrets
    );
    throw e;
  }
}
/** Fail final retention if any saved bytes still contain a known or shaped credential. */
export async function scan(dir, secrets = []) {
  for (const file of await files(dir)) {
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    if (redact(raw, secrets) !== raw) throw Error(`Credential-shaped output in ${file}`);
  }
}
/** Enumerate retained evidence deterministically, refusing symlinks in new bundles. */
export async function files(dir) {
  const result = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw Error('Evidence symlink refused');
    const f = path.join(dir, item.name);
    if (item.isDirectory())
      for (const child of await files(f)) result.push(`${item.name}/${child}`);
    else if (item.isFile()) result.push(item.name);
    else throw Error('Non-regular evidence refused');
  }
  return result.sort();
}

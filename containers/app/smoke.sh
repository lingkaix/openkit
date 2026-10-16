#!/usr/bin/env bash
set -euo pipefail

print_required_version() {
  local name="$1"
  shift

  printf '%s: ' "$name"
  "$@"
}

print_required_version "node" node --version
print_required_version "pnpm" pnpm --version
print_required_version "caddy" caddy version
# Data-root process ownership needs the packaged advisory-lock utility.
command -v flock >/dev/null
test -x /usr/local/bin/openkit-operator
test -x /usr/local/bin/openkit-restore
openkit-restore --help
if openkit-restore; then
  echo "openkit-restore with no arguments must fail" >&2
  exit 1
fi

# The packaged executable and dictionaries must work without network access on this image's target.
print_required_version "retrieval-kernel" retrieval-kernel --version
test -s /usr/local/share/licenses/retrieval-kernel/IPADIC-COPYING
test -s /usr/local/share/licenses/retrieval-kernel/crates/CRATES.json
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeRetrievalServices, getRetrievalService } from '/app/nanocore/dist/retrieval-service.js';
const root = mkdtempSync(join(tmpdir(), 'openkit-retrieval-smoke-'));
const sources = join(root, 'sources');
mkdirSync(sources);
const binary = '/usr/local/bin/retrieval-kernel';
assert.equal(readFileSync(binary).readUInt16LE(18), process.arch === 'arm64' ? 183 : 62);
function run(args, frames = []) {
  const result = spawnSync(binary, args, { cwd: sources, input: frames.map(frame => JSON.stringify(frame)).join('\n') + '\n', encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}
try {
  writeFileSync(join(sources, 'chinese.txt'), '我们完成了测试，并修复了缺陷。');
  writeFileSync(join(sources, 'japanese.txt'), '検索機能を改善しました。');
  writeFileSync(join(sources, 'binary'), '\0BINARY_BODY_SECRET');
  assert.equal(run(['index'])[0].generation.length, 64);
  for (const [mode, query, id] of [['lexical', '测试', 'chinese.txt'], ['lexical', '検索', 'japanese.txt'], ['exact', '修复', 'chinese.txt'], ['regex', '検索', 'japanese.txt']]) {
    const result = run(['search', mode, query])[0];
    assert.equal(result.complete, true);
    assert.equal(result.hits[0].key.id, id);
  }
  assert.deepEqual(run(['search', 'exact', 'BINARY_BODY_SECRET'])[0].hits, []);
  const mcp = run(['mcp'], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'image-smoke', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: { mode: 'lexical', query: '検索', limit: 20 } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { mode: 'exact', query: 'secret', limit: 20, path: '/' } } },
  ]);
  assert.equal(JSON.parse(mcp[1].result.content[0].text).hits[0].key.id, 'japanese.txt');
  assert.equal(mcp[2].error.code, -32602);
  const text = 'governance-hidden\n测试 修复';
  const hash = createHash('sha256').update(text).digest('hex');
  const view = { scope: 'image-smoke', documents: [{ key: { namespace: 'fixture', id: 'text' }, revision: hash, digest: hash, size: Buffer.byteLength(text), name: 'text', media_type: 'text/plain', content: { kind: 'inline-text', text }, text_ranges: [{ start: Buffer.byteLength('governance-hidden\n'), end: Buffer.byteLength(text) }] }] };
  const args = ['service', '--sources', sources, '--store', join(root, 'service')];
  const replies = run(args, [
    { version: 1, id: 1, op: 'publish', view, expected_generation: null },
    { version: 1, id: 2, op: 'search', request: { mode: 'lexical', query: '测试', scopes: [view], limit: 20 } },
    { version: 1, id: 3, op: 'search', request: { mode: 'exact', query: 'governance-hidden', scopes: [view], limit: 20 } },
    { version: 1, id: 4, op: 'search', request: { mode: 'lexical', query: '测试', scopes: [], limit: 20 } },
  ]);
  assert.equal(replies[1].result.hits[0].key.id, 'text');
  assert.deepEqual(replies[2].result.hits, []);
  assert.deepEqual(replies[3].result.hits, []);
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('service health timeout')), 15000);
      child.once('error', reject);
      child.stdout.once('data', bytes => { clearTimeout(timer); resolve(JSON.parse(bytes.toString('utf8'))); });
    });
    child.stdin.write(JSON.stringify({ version: 1, id: 5, op: 'inspect', scope: 'image-smoke' }) + '\n');
    assert.equal((await reply).version, 1);
    const limits = readFileSync(`/proc/${child.pid}/limits`, 'utf8');
    assert.match(limits, /Max address space\s+2147483648\s/);
    assert.match(limits, /Max file size\s+536870912\s/);
    assert.match(limits, /Max cpu time\s+65\s/);
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end();
    assert.equal(await exited, 0);
  } finally { child.kill(); }
  const supervised = getRetrievalService(root, sources);
  await supervised.start();
  const generation = await supervised.publish(view, await supervised.inspect(view.scope));
  assert.equal((await supervised.search({ mode: 'lexical', query: '测试', scopes: [view], limit: 20 })).hits[0].key.id, 'text');
  await closeRetrievalServices();
  const restarted = getRetrievalService(root, sources);
  assert.equal(await restarted.inspect(view.scope), generation);
  assert.deepEqual((await restarted.search({ mode: 'lexical', query: '测试', scopes: [], limit: 20 })).hits, []);
  await closeRetrievalServices();
  console.log(`Retrieval image smoke OK (${process.arch}): CLI, MCP, supervised service/restart, CJK, sidecar isolation, ranges, revocation, limits.`);
} finally { await closeRetrievalServices(); rmSync(root, { recursive: true, force: true }); }
NODE

# Exercise the production dependency tree through the ordinary entrypoint and public route.
smoke_root="$(mktemp -d /tmp/openkit-app-smoke.XXXXXX)"
app_pid=""
cleanup() {
  if [[ -n "${app_pid}" ]]; then
    kill "${app_pid}" >/dev/null 2>&1 || true
    wait "${app_pid}" || true
  fi
  rm -rf "${smoke_root}"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

mkdir -p "${smoke_root}/data/config"
printf '%s\n' '{"schemaVersion":1,"mode":"local"}' >"${smoke_root}/data/config/server.jsonc"
OPENKIT_DATA_ROOT="${smoke_root}/data" /usr/local/bin/openkit-app-entrypoint >"${smoke_root}/startup.log" 2>&1 &
app_pid="$!"

ready=0
startup_deadline=$((SECONDS + 60))
while ((SECONDS < startup_deadline)); do
  if curl -fsS --max-time 1 "http://127.0.0.1:${CADDY_HTTP_PORT:-8080}/api/health" >"${smoke_root}/health.json" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "${app_pid}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if [[ "${ready}" -ne 1 ]]; then
  cat "${smoke_root}/startup.log" >&2
  echo "App server did not reach /api/health within 60 seconds." >&2
  exit 1
fi
cat "${smoke_root}/health.json"
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const origin = `http://127.0.0.1:${process.env.CADDY_HTTP_PORT || '8080'}`;
const request = (path, method = 'GET') => fetch(`${origin}${path}`, {
  method,
  signal: AbortSignal.timeout(5000),
});
const index = await request('/');
assert.equal(index.status, 200);
assert.match(index.headers.get('content-type'), /^text\/html\b/);
const html = await index.text();
assert.ok(html.length > 0);
for (const path of ['/workspaces/proxy-smoke', '/v1-like-web-route']) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.equal(await response.text(), html, path);
}
const head = await request('/workspaces/proxy-smoke', 'HEAD');
assert.equal(head.status, 200);
assert.match(head.headers.get('content-type'), /^text\/html\b/);
assert.equal(await head.text(), '');

// The public proxy must reject these paths without exposing the Gateway listener.
for (const path of ['/v1', '/v1/models', '/v1/responses', '/v1/chat/completions', '/v1/unknown', '/v1?model=proxy-smoke', '/v1/models?limit=1', '/v1/responses?stream=true', '/v1/chat/completions?stream=true', '/v1/unknown?probe=1', '/api', '/internal', '/mcp/unknown']) {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const response = await request(path, method);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.match(response.headers.get('content-type'), /^application\/json\b/, `${method} ${path}`);
    if (method === 'HEAD') {
      assert.equal(await response.text(), '');
    } else {
      assert.deepEqual(await response.json(), {
        error: { type: 'invalid_request_error', code: 'not_found', message: 'API route not found.' },
      }, `${method} ${path}`);
    }
  }
}
for (const path of ['/', '/workspaces/proxy-smoke']) {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await request(path, method);
    assert.equal(response.status, 405, `${method} ${path}`);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.match(response.headers.get('content-type'), /^application\/json\b/);
    assert.deepEqual(await response.json(), {
      error: { type: 'invalid_request_error', code: 'method_not_allowed', message: 'Method not allowed.' },
    });
  }
}
for (const path of ['/api/proxy-smoke-unknown', '/internal/proxy-smoke-unknown']) {
  const response = await request(path, 'POST');
  assert.equal(response.status, 404, path);
  assert.doesNotMatch(response.headers.get('content-type') || '', /text\/html/);
}
console.log('App proxy smoke OK: API errors, method rejection, and Web GET/HEAD fallback.');
NODE
echo "OpenKit app image smoke OK"

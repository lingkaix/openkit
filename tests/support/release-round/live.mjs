/** Fixed live procedures with injected CLI, SSH, and clock seams for local admission. */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonical,
  credential,
  execute,
  noSecrets,
  once,
  readJson,
  redact,
  save,
  scan,
  sha,
} from '../../../scripts/release-safety.mjs';
import { telemetry } from './evidence.mjs';
import { RUNTIMES, replySentence, validateParams } from './safety.mjs';

const here = fileURLToPath(import.meta.url),
  repo = path.resolve(path.dirname(here), '../../..');
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const reads = {
  runtime: new Set([
    'thread.dashboard',
    'thread.items',
    'thread.read',
    'turn.read',
    'artifact.read',
    'catalog.mcp-list',
    'nanohost.runtime-target',
  ]),
};
const mutations = {
  runtime: new Set(['thread.create', 'turn.start']),
};
/** Real adapters are replaced by local stand-ins during instrument admission. */
export const defaults = {
  exec: execute,
  cli: execute,
  ssh: execute,
  now: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
function q(v) {
  return `'${String(v).replaceAll("'", "'\\''")}'`;
}
function cleanEnvironment() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.OPENKIT_NANOCORE_TOKEN;
  delete env.RELEASE_ROUND_BRIDGE;
  delete env.RELEASE_ROUND_TRANSPORT;
  return env;
}
async function instrument() {
  const names = [
      'release-round.mjs',
      'release-round/safety.mjs',
      'release-round/evidence.mjs',
      'release-round/live.mjs',
    ],
    entries = [];
  for (const n of names)
    entries.push({ file: n, sha256: sha(await fs.readFile(path.join(repo, 'tests/support', n))) });
  entries.push({
    file: 'scripts/release-safety.mjs',
    sha256: sha(await fs.readFile(path.join(repo, 'scripts/release-safety.mjs'))),
  });
  return { entries, sha256: sha(canonical(entries)) };
}
async function git(io, args) {
  const v = await io.exec('git', args, { cwd: repo, timeout: 60000 });
  if (v.exitCode !== 0) throw Error('Local Git observation failed');
  return v.stdout.trim();
}

/** Verify pinned bytes before any resumed command. */
export async function pinned(dir) {
  const receipt = await readJson(path.join(dir, 'prepare.json')),
    raw = await fs.readFile(path.join(dir, 'params.json'));
  if (sha(raw) !== receipt.parameterSha256) throw Error('Pinned parameter digest mismatch');
  const code = await instrument();
  if (code.sha256 !== receipt.runnerSha256) throw Error('Pinned instrument digest mismatch');
  return { p: validateParams(JSON.parse(raw)), receipt };
}

/** Each remote batch is preceded by the exact machine identity guard. */
export async function guard(p, dir, io = defaults) {
  const v = await io.ssh(
    'ssh',
    [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      p.deployment.sshAlias,
      'cat /etc/machine-id',
    ],
    { timeout: 20000 }
  );
  await save(path.join(dir, 'guards', `${randomUUID()}.json`), {
    at: io.now(),
    exitCode: v.exitCode,
    identity: v.stdout.trim(),
  });
  if (v.exitCode !== 0 || v.stdout.trim() !== p.deployment.machineId)
    throw Error('Remote machine identity mismatch; no batch admitted');
}

/** Fixed remote code accepts data only and never evaluates a parameter as a command. */
async function remote(p, dir, io, phase, input, source) {
  await guard(p, dir, io);
  const r = await io.ssh(
    'ssh',
    ['-T', '-o', 'BatchMode=yes', p.deployment.sshAlias, `sudo -n python3 -c ${q(source)}`],
    {
      input: JSON.stringify({
        deployment: p.deployment,
        candidate: p.candidateCommit,
        roundId: p.roundId,
        ...input,
      }),
      timeout: p.bounds.processMs,
    }
  );
  await save(path.join(dir, 'host', `${phase}-process.json`), r);
  if (r.exitCode !== 0 || r.timedOut)
    throw Error(`Host ${phase} failed; inspect retained process result`);
  let body;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    throw Error(`Host ${phase} response unparseable`);
  }
  await save(path.join(dir, 'host', `${phase}.json`), body);
  return body;
}

const hostCommon = `
import sys,json,pathlib,subprocess
x=json.load(sys.stdin);d=x['deployment'];P=pathlib.Path
assert P('/etc/machine-id').read_text().strip()==d['machineId']
def run(a):
 r=subprocess.run(a,capture_output=True,text=True,timeout=3000)
 if r.returncode: raise RuntimeError('host command failed: '+a[0])
 return r.stdout
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
`;

/** Pin exact release/instrument identities; launch preflight only for a browser-dependent story. */
export async function prepare(paramsFile, dir, seams = {}, purpose = 'worker') {
  if (!['worker', 'browser-story'].includes(purpose)) throw Error('Unknown preparation purpose');
  const io = { ...defaults, ...seams },
    raw = await fs.readFile(paramsFile),
    p = validateParams(JSON.parse(raw));
  if (!p.releaseTag) throw Error('Published releaseTag required for live qualification');
  for (const key of ['configurationDigest', 'nanoHostDigest', 'workerDigest'])
    if (!/^sha256:[a-f0-9]{64}$/.test(p.deployment[key]))
      throw Error(`Exact ${key} required for live preparation`);
  const blob = await git(io, ['rev-parse', `${p.candidateCommit}:docs/cookbooks/release.md`]);
  if (blob !== p.checklistBlob) throw Error('Frozen checklist blob mismatch');
  const code = await instrument(),
    commit = await git(io, ['rev-parse', 'HEAD']);
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(dir, 'params.json'), raw, { flag: 'wx', mode: 0o600 });
  for (const r of RUNTIMES)
    await fs.mkdir(path.join(dir, 'runtimes', r), { recursive: true, mode: 0o700 });
  const receipt = {
    purpose,
    runnerCommit: commit,
    runnerSha256: code.sha256,
    instrumentFiles: code.entries,
    parameterSha256: sha(raw),
    checklistBlob: blob,
    candidateCommit: p.candidateCommit,
    preparedAt: io.now(),
  };
  await save(path.join(dir, 'prepare.json'), receipt);
  const secret = seams.credential ?? (await credential(p.cli.credentialFile));
  if (purpose === 'browser-story') {
    const commands = [];
    let launchError;
    try {
      await browserLaunch(p, io, commands, `preflight-${p.roundId}`);
    } catch (error) {
      launchError = error;
    } finally {
      await save(path.join(dir, 'browser-preflight.json'), { commands }, [secret]);
    }
    if (launchError) throw launchError;
  }
  const components = {};
  for (const component of ['nanoHost', 'worker']) {
    const changed = await git(io, [
      'diff',
      '--name-only',
      p.deployment.componentCommits[component],
      p.candidateCommit,
      '--',
      ...p.deployment.componentPaths[component],
    ]);
    if (changed && component === 'nanoHost')
      throw Error(
        'Changed NanoHost inputs require the maintained NanoHost build/install and Initial NanoHost Provisioning procedure; this runner does not update NanoHost'
      );
    components[component] = {
      unchanged: !changed,
      changedInputs: changed ? changed.split('\n') : [],
      sourceCommit: p.deployment.componentCommits[component],
      inputPaths: p.deployment.componentPaths[component],
      digest: p.deployment[component === 'nanoHost' ? 'nanoHostDigest' : 'workerDigest'],
    };
  }
  await save(path.join(dir, 'component-attribution.json'), components);
  await scan(dir, [secret]);
  await save(path.join(dir, 'prepare-complete.json'), {
    completedAt: io.now(),
    runnerSha256: receipt.runnerSha256,
  });
  return receipt;
}

/** Retain browser process evidence with the same secret-free environment as the CLI. */
async function browserCommand(p, io, commands, session, args) {
  try {
    const result = await io.exec('agent-browser', ['--session', session, ...args], {
      timeout: args[0] === 'close' ? 20000 : p.bounds.processMs,
      env: cleanEnvironment(),
    });
    commands.push({ arguments: args, ...result });
    return result;
  } catch (error) {
    commands.push({ arguments: args, exitCode: null, stdout: '', stderr: error.message });
    throw error;
  }
}
/** Prove blank-page launch and close; preserve the first failure and always attempt closure. */
async function browserLaunch(p, io, commands, session) {
  let failure;
  for (const args of [['open', 'about:blank'], ['close']]) {
    try {
      const result = await browserCommand(p, io, commands, session, args);
      if (result.exitCode !== 0 || result.timedOut || result.signal)
        failure ??= Error('Browser launch preflight failed');
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

/** A response is ambiguous until a valid product envelope is retained; mutations never retry. */
export class InspectionRequired extends Error {}
/** One phase-scoped public CLI collector with immutable ownership and mutation receipts. */
export class RoundClient {
  constructor(p, dir, io, secrets) {
    this.p = p;
    this.dir = dir;
    this.io = io;
    this.secrets = secrets;
    this.owned = new Set();
    this.phase = 'runtime';
    this.spans = [];
  }
  /** Record ownership once. */
  async own(threadId) {
    if (this.owned.has(threadId)) return;
    if (this.p.protectedIds.includes(threadId)) throw Error('Protected Thread refused');
    this.owned.add(threadId);
    const f = path.join(this.dir, 'owned', `${sha(threadId)}.json`);
    try {
      const old = await readJson(f);
      if (old.threadId !== threadId) throw Error('Owned Thread receipt conflict');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      await save(f, { threadId });
    }
  }
  /** Retain each bounded read failure; an uncertain mutation stops all dependent execution. */
  async call(op, input, mutation = false) {
    if (this.halted)
      throw new InspectionRequired('Round sealed; inspect uncertain mutation before further calls');
    noSecrets(input);
    if (input.workspaceId && input.workspaceId !== this.p.workspaceId)
      throw Error('Only the declared Workspace addressable');
    if (this.p.protectedIds.some((v) => JSON.stringify(input).includes(v)))
      throw Error('Protected identifier refused');
    if (input.threadId && !this.owned.has(input.threadId))
      throw Error('Only round-owned Threads addressable');
    if (mutation ? !mutations[this.phase]?.has(op) : !reads[this.phase]?.has(op))
      throw Error(`Public operation ${op} refused in ${this.phase}`);
    const name = `${op.replaceAll('.', '-')}-${mutation ? sha(input.requestId ?? canonical(input)) : randomUUID()}`,
      directory = path.join(this.dir, 'calls');
    const invoke = async () => {
      if (this.halted) throw new InspectionRequired('Round sealed; no further effects admitted');
      await guard(this.p, this.dir, this.io);
      if (this.halted)
        throw new InspectionRequired(
          'Round sealed during identity guard; no further call admitted'
        );
      const at = this.io.now();
      const env = {
        ...cleanEnvironment(),
        OPENKIT_NANOCORE_URL: this.p.cli.origin,
        OPENKIT_NANOCORE_TOKEN: this.secrets[0],
        RELEASE_ROUND_TRANSPORT: '1',
        NODE_OPTIONS: `--import=${pathToFileURL(here).href}`,
      };
      const r = await this.io.cli(this.p.cli.executable, ['ops', 'call', op, '--input', '-'], {
        input: JSON.stringify(input),
        env,
        timeout: this.p.bounds.processMs,
      });
      const spans = r.stderr
        .split('\n')
        .filter((v) => v.startsWith('RELEASE_HTTP '))
        .map((v) => JSON.parse(v.slice(13)));
      this.spans.push(...spans);
      if (!spans.length) this.transportIncomplete = true;
      await save(
        path.join(directory, `${name}-${randomUUID()}-transport.json`),
        { startedAt: at, endedAt: this.io.now(), ...r, http: spans },
        this.secrets
      );
      if (r.timedOut)
        throw new InspectionRequired(`Timed out ${op} response; inspect without resubmission`);
      let payload;
      try {
        payload = JSON.parse(r.stdout);
      } catch {
        throw new InspectionRequired(
          `Lost or unparseable ${op} response; inspect without resubmission`
        );
      }
      if (
        typeof payload.ok !== 'boolean' ||
        (payload.ok && !payload.data) ||
        (!payload.ok && !payload.error)
      )
        throw new InspectionRequired(`Invalid ${op} envelope; inspect without resubmission`);
      if (mutation && payload.ok) {
        const id = payload.data.id;
        if (typeof id !== 'string' || !id.length)
          throw new InspectionRequired(
            `Invalid ${op} result identity; inspect without resubmission`
          );
      }
      return redact(payload, this.secrets);
    };
    if (mutation) {
      try {
        return await once(directory, name, input, invoke, this.secrets);
      } catch (e) {
        this.halted = true;
        if (e instanceof InspectionRequired) throw e;
        throw new InspectionRequired(
          `Mutation ${op} receipt refused or incomplete; inspect without resubmission`,
          { cause: e }
        );
      }
    }
    let error;
    for (let i = 0; i < this.p.bounds.readAttempts; i++) {
      try {
        return await invoke();
      } catch (e) {
        error = e;
        await save(
          path.join(directory, `${name}-failure-${i}.json`),
          { at: this.io.now(), error: String(e) },
          this.secrets
        );
      }
    }
    throw new Error(`Bounded read ${op} exhausted; inspect retained failures`, { cause: error });
  }
  /** Require the supported full Item log without inventing a continuation operation. */
  async page(op, input) {
    if (op !== 'thread.items') throw Error('Only the owned Item collection has a coverage cursor');
    // The accepted operation returns the complete retained log; its input has no cursor field.
    const response = await this.call(op, { ...input, limit: 1000 });
    if (response.ok && (!Array.isArray(response.data.items) || response.data.nextCursor !== null))
      throw Error('Complete Item coverage unavailable; no unsupported cursor invented');
    return response;
  }
  /** Poll current public state, then preserve complete deciding Turns, Items and Artifacts. */
  async observe(tid) {
    const start = Date.parse(this.io.now());
    let board,
      timedOut = false,
      stop;
    for (;;) {
      board = await this.call('thread.dashboard', {
        workspaceId: this.p.workspaceId,
        threadId: tid,
      });
      if (!board.ok) break;
      const b = board.data;
      if (b.pendingRequests.some((q) => q.state === 'pending')) {
        try {
          await this.waitDecisions();
          if (Date.parse(this.io.now()) - start >= this.p.bounds.observationMs) {
            timedOut = true;
            break;
          }
          await this.io.sleep(this.p.bounds.pollMs);
          continue;
        } catch (e) {
          if (e instanceof InspectionRequired) throw e;
          stop = { error: String(e), name: e.name };
          break;
        }
      }
      if (
        b.turns.length &&
        b.turns.every((t) => terminal.has(t.status)) &&
        b.workStatus.activeTurnStatus === 'idle'
      )
        break;
      if (Date.parse(this.io.now()) - start >= this.p.bounds.observationMs) {
        timedOut = true;
        break;
      }
      await this.io.sleep(this.p.bounds.pollMs);
    }
    const turnReads = [];
    for (const t of board?.data?.turns ?? [])
      turnReads.push(
        await this.call('turn.read', {
          workspaceId: this.p.workspaceId,
          threadId: tid,
          turnId: t.id,
        })
      );
    const items = await this.page('thread.items', {
        workspaceId: this.p.workspaceId,
        threadId: tid,
      }),
      artifactReads = [];
    for (const a of board?.data?.artifacts ?? [])
      artifactReads.push(
        await this.call('artifact.read', {
          workspaceId: this.p.workspaceId,
          artifactId: a.id ?? a.artifactId,
        })
      );
    return {
      dashboard: board,
      turnReads,
      items,
      artifactReads,
      endedAt: this.io.now(),
      timedOut,
      stop,
    };
  }
  /** A qualification Turn has no operator decision path. */
  async waitDecisions() {
    throw Error('Unexpected runtime Pending Request; no automatic decision');
  }
}

async function create(client, name) {
  const r = await client.call(
    'thread.create',
    {
      workspaceId: client.p.workspaceId,
      name: `${client.p.roundId} ${name}`,
      visibility: 'workspace',
      requestId: randomUUID(),
    },
    true
  );
  if (!r.ok) return r;
  await client.own(r.data.id);
  return r.data.id;
}

/** Each group owns one directory and one fresh Thread, for independent concurrent execution. */
export async function runtimeGroup(client, runtime) {
  const p = client.p,
    cfg = p.runtimes[runtime],
    tid = await create(client, `runtime ${runtime}`),
    record = {
      runtime,
      threadId: typeof tid === 'string' ? tid : undefined,
      modelId: cfg.modelId,
      marker: cfg.marker,
      filename: cfg.filename,
      steps: [],
    };
  if (typeof tid !== 'string') {
    record.creationRefusal = tid;
    return record;
  }
  const prompts = {
    A: `Repeat this public, synthetic test sentence once, without quotation marks: ${replySentence(p, runtime)}`,
    B: `Using only the github MCP tools, read issue ${p.issue.number} of ${p.issue.repository} and reply with its exact title and state. Do not modify anything.`,
    C: `Write exactly the UTF-8 text ${cfg.marker} with no trailing newline to ${cfg.filename} in your admitted default output root, and the same bytes to notes/${cfg.filename} in the retained Workspace. Read both files back. Submit the actual default-output file with work_artifact_submit using its canonical absolute path, kind file, media type text/plain and title ${cfg.filename}. Report the filename, bytes and returned Artifact id. Remember the marker.`,
    D: `State the marker from conversation memory. Read notes/${cfg.filename} from the retained Workspace without rewriting or recreating it. Copy its existing bytes to ${cfg.filename} in this Turn's default output root and submit that actual file using work_artifact_submit, canonical absolute path, kind file, media type text/plain, title ${cfg.filename}, and a new submission request id. Report the marker, filename and returned Artifact id. If the file is absent report the failure; never recreate it.`,
  };
  for (const letter of ['A', 'B', 'C', 'D']) {
    const before = await client.call('thread.dashboard', {
      workspaceId: p.workspaceId,
      threadId: tid,
    });
    const s = { scenario: letter, input: prompts[letter], windowStart: client.io.now() };
    record.steps.push(s);
    if (
      !before.ok ||
      before.data.workStatus.activeTurnStatus !== 'idle' ||
      before.data.pendingRequests.some((q) => q.state === 'pending')
    ) {
      s.outcome = 'blocked';
      await save(path.join(client.dir, 'runtimes', runtime, `${letter}.json`), s, client.secrets);
      continue;
    }
    const target = await client.call('nanohost.runtime-target', {});
    if (!target.ok || !target.data.ready) {
      s.outcome = 'refused-unready';
      await save(path.join(client.dir, 'runtimes', runtime, `${letter}.json`), s, client.secrets);
      continue;
    }
    s.submitInput = {
      workspaceId: p.workspaceId,
      threadId: tid,
      requestId: randomUUID(),
      agentId: cfg.agentId,
      profileId: cfg.profileId,
      ...(cfg.modelId === 'configured default' ? {} : { modelId: cfg.modelId }),
      input: prompts[letter],
    };
    s.submission = await client.call('turn.start', s.submitInput, true);
    if (s.submission.ok) {
      s.turnId = s.submission.data.id;
      try {
        const e = await client.observe(tid);
        s.turn = e.turnReads.map((v) => v.data).find((v) => v.id === s.turnId);
        s.dashboard = e.dashboard?.data;
        s.itemCoverage = e.items?.data;
        s.items = s.itemCoverage?.items?.filter((i) => i.turnId === s.turnId);
        s.artifactReads = e.artifactReads;
        s.stop = e.stop;
        s.outcome = e.stop ? 'refused' : e.timedOut ? 'timeout' : s.turn?.status;
        s.windowEnd = client.io.now();
      } catch (e) {
        if (e instanceof InspectionRequired) throw e;
        s.observationFailure = { error: String(e) };
        s.outcome = 'observation-unavailable';
      }
    }
    await save(path.join(client.dir, 'runtimes', runtime, `${letter}.json`), s, client.secrets);
  }
  return record;
}

async function github(p, dir, io, label, route) {
  await guard(p, dir, io);
  const r = await io.exec('gh', ['api', '--include', '--method', 'GET', route], {
    timeout: p.bounds.processMs,
  });
  await save(path.join(dir, 'github', `${label}.json`), r);
  const sep = r.stdout.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n',
    parts = r.stdout.split(sep),
    headers = parts.shift(),
    body = parts.join(sep);
  const receipt = {
    at: io.now(),
    route,
    exitCode: r.exitCode,
    httpStatus: Number(headers.match(/HTTP\/[^\s]+\s+(\d+)/)?.[1]),
    hasNextPage: /^link:.*rel="next"/im.test(headers),
  };
  return { receipt, data: r.exitCode === 0 ? JSON.parse(body) : null };
}

const diagnosticsSource =
  hostCommon +
  `
start=x['start'];end=x['end']
def observed(a):
 r=subprocess.run(a,capture_output=True,text=True,timeout=120)
 return {'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
print(json.dumps({'window':[start,end],'proxy':observed(['journalctl','-u',d['diagnosticUnit'],'--since',start,'--until',end,'--no-pager','-o','short-iso']),'app':observed(['docker','logs','--timestamps','--since',start,'--until',end,d['container']])}))
`;
function diagnosticChannel(raw, start, end) {
  if (!raw || raw.exitCode !== 0)
    return {
      coverage: 'unavailable',
      reason: 'diagnostic command failed',
      http502: null,
      connectionReset: null,
    };
  const text = `${raw.stdout}\n${raw.stderr}`,
    lines = text.split('\n').filter(Boolean),
    spans = [],
    unresolved = [];
  for (const line of lines) {
    if (/sshd/i.test(line)) continue;
    const status = /(?:HTTP\/\d(?:\.\d)?"?\s+|"?status"?\s*[:=]\s*)502\b/i.test(line),
      reset = /connection reset|ECONNRESET/i.test(line);
    if (!status && !reset) continue;
    const timestamp = line.match(
      /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/
    )?.[0];
    if (
      !timestamp ||
      Date.parse(timestamp) < Date.parse(start) ||
      Date.parse(timestamp) > Date.parse(end)
    ) {
      unresolved.push(line);
      continue;
    }
    spans.push({
      startedAt: timestamp,
      status: status ? 502 : null,
      connectionReset: reset,
      safeCause: line,
    });
  }
  return {
    ...telemetry(
      spans,
      unresolved.length
        ? 'unavailable'
        : 'declared service log interval; diagnostic events, not additional client requests'
    ),
    interval: [start, end],
    unresolved,
  };
}

/** Run qualification once; any ambiguous mutation seals the round for inspection. */
export async function round(dir, seams = {}) {
  const { p, receipt } = await pinned(dir),
    io = { ...defaults, ...seams };
  const preparation = await readJson(path.join(dir, 'prepare-complete.json'));
  if (preparation.runnerSha256 !== receipt.runnerSha256)
    throw Error('Preparation incomplete; no round effects admitted');
  await save(path.join(dir, 'round-start.json'), { start: io.now() });
  const secret = seams.credential ?? (await credential(p.cli.credentialFile)),
    client = new RoundClient(p, dir, io, [secret]),
    components = await readJson(path.join(dir, 'component-attribution.json')),
    bundle = {
      attribution: {
        ...receipt,
        configurationDigest: p.deployment.configurationDigest,
        start: io.now(),
      },
      components,
      runtimes: {},
      issues: {},
      cleanup: { observed: false },
      telemetry: {
        client: { coverage: 'unavailable' },
        proxy: { coverage: 'unavailable' },
        app: { coverage: 'unavailable' },
        external: { coverage: 'unavailable' },
        health: { coverage: 'unavailable' },
      },
    };
  const persist = () => save(path.join(dir, 'round.json'), bundle, [secret], false);
  try {
    bundle.binding = await client.call('catalog.mcp-list', { workspaceId: p.workspaceId });
    // Settle all already admitted groups before closing attribution, even after a lost mutation.
    const groups = await Promise.allSettled(
      RUNTIMES.map(async (runtime) => {
        const issue = await github(
          p,
          dir,
          io,
          `${runtime}-issue`,
          `repos/${p.issue.repository}/issues/${p.issue.number}`
        );
        bundle.issues[runtime] = {
          readExit: issue.receipt.exitCode,
          issue: issue.data,
          receipt: issue.receipt,
        };
        bundle.runtimes[runtime] = await runtimeGroup(client, runtime);
      })
    );
    await persist();
    const unknown = groups.find(
      (r) => r.status === 'rejected' && r.reason instanceof InspectionRequired
    );
    if (unknown) throw unknown.reason;
    for (const [index, result] of groups.entries())
      if (result.status === 'rejected') {
        bundle.runtimes[RUNTIMES[index]] = {
          observationFailure: { error: String(result.reason), at: io.now() },
        };
      }
    const diagnosticEnd = io.now();
    let diagnostic;
    try {
      diagnostic = await remote(
        p,
        dir,
        io,
        'diagnostics',
        { start: bundle.attribution.start, end: diagnosticEnd },
        diagnosticsSource
      );
    } catch (e) {
      diagnostic = { error: String(e) };
      await save(path.join(dir, 'diagnostics-unavailable.json'), diagnostic, [secret]);
    }
    bundle.telemetry = {
      client: telemetry(
        client.spans,
        client.transportIncomplete
          ? 'unavailable'
          : 'all recorded administrator CLI requests; unsampled time unavailable'
      ),
      proxy: diagnosticChannel(diagnostic.proxy, bundle.attribution.start, diagnosticEnd),
      app: diagnosticChannel(diagnostic.app, bundle.attribution.start, diagnosticEnd),
      external: { coverage: 'unavailable' },
      health: { coverage: 'unavailable' },
    };
    const cleanup = await remote(
      p,
      dir,
      io,
      'cleanup',
      {},
      hostCommon +
        "\nold=inspect(d['container']);print(json.dumps({'running':old['State']['Running'],'container':old['Id'],'images':run(['docker','image','ls','--no-trunc',d['imageRepository']])}))\n"
    );
    bundle.cleanup = {
      observed: true,
      posture: cleanup,
      roundOwnedThreads: [...client.owned],
      retained: 'Qualification Threads and Artifacts remain; no unrelated cleanup performed',
    };
  } catch (e) {
    bundle.stop = {
      status: e instanceof InspectionRequired ? 'inspection-required' : 'failed-or-incomplete',
      error: String(e),
      at: io.now(),
    };
    await save(path.join(dir, 'round-stop.json'), bundle.stop, [secret]);
    throw e;
  } finally {
    bundle.attribution.end = io.now();
    await persist();
    await scan(dir, [secret]);
  }
  return bundle;
}

// Imported only by the maintained CLI's fetch hook; bodies and headers are never observed here.
if (process.env.RELEASE_ROUND_TRANSPORT === '1') {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const startedAt = new Date().toISOString(),
      url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    try {
      const response = await original(input, init);
      process.stderr.write(
        `RELEASE_HTTP ${JSON.stringify({ startedAt, observedAt: new Date().toISOString(), method: init?.method ?? 'GET', path: url.pathname, status: response.status })}\n`
      );
      return response;
    } catch (e) {
      const codes = [];
      for (let c = e, n = 0; c && n < 5; c = c.cause, n++)
        if (typeof c.code === 'string') codes.push(c.code);
      process.stderr.write(
        `RELEASE_HTTP ${JSON.stringify({ startedAt, observedAt: new Date().toISOString(), path: url.pathname, status: null, errorCodes: codes, connectionReset: codes.includes('ECONNRESET') })}\n`
      );
      throw e;
    }
  };
}

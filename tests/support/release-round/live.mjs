/** Fixed live procedures with injected CLI, SSH, and clock seams for local admission. */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  allowedGoalIntent,
  allowedTaskIntent,
  taskReadProjections,
  telemetry,
} from './evidence.mjs';
import {
  canonical,
  credential,
  digest,
  execute,
  noSecrets,
  once,
  RUNTIMES,
  readJson,
  redact,
  save,
  scan,
  sha,
  validateParams,
  workerActivationInput,
  workerPreparedMatches,
} from './safety.mjs';

const here = fileURLToPath(import.meta.url),
  repo = path.resolve(path.dirname(here), '../../..');
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const threadReads = [
  'thread.dashboard',
  'thread.items',
  'thread.read',
  'turn.read',
  'artifact.read',
];
const reads = {
  deployment: new Set([
    'diagnostics.app',
    'nanohost.runtime-target',
    'workspace.read',
    'catalog.mcp-list',
    'worker.list',
    'scheduler.list',
    'runtime.file-list',
    'runtime.agent-environment-read',
  ]),
  runtime: new Set([...threadReads, 'nanohost.runtime-target']),
  chat: new Set(threadReads),
  task: new Set(threadReads),
  goal: new Set([...threadReads, 'goal.read']),
  decision: new Set([...threadReads, 'goal.read']),
  'worker-decision': new Set(['runtime.agent-environment-read']),
};
const mutations = {
  deployment: new Set(['administration.conversation-submit', 'worker-environment.prepare']),
  'worker-decision': new Set(['worker-environment.activate']),
  runtime: new Set(['thread.create', 'turn.start']),
  chat: new Set(['thread.create', 'conversation.submit']),
  task: new Set(['thread.create', 'task.start']),
  goal: new Set(['goal.create', 'thread.update']),
  decision: new Set(['approval.respond', 'goal.plan.approve', 'goal.completion.accept']),
};
const externalReads = new Set([
  'conversation.navigation',
  'conversation.targets',
  'workspace.repositories',
  'workspace.context',
  'workspace.list',
  'workspace.read',
  'workspace.resources',
  'thread.list',
  'app.search',
  'thread.read',
  'thread.items',
  'thread.dashboard',
  'turn.read',
  'artifact.read',
]);
/** Real adapters are replaced by local stand-ins during instrument admission. */
export const defaults = {
  exec: execute,
  cli: execute,
  ssh: execute,
  now: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  fetch: (...args) => fetch(...args),
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
  return { entries, sha256: sha(canonical(entries)) };
}
async function git(io, args) {
  const v = await io.exec('git', args, { cwd: repo, timeout: 60000 });
  if (v.exitCode !== 0) throw Error('Local Git observation failed');
  return v.stdout.trim();
}

/** Verify pinned bytes before any resumed command or operator decision. */
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
async function remote(p, dir, io, phase, input, source, mutation = false) {
  await guard(p, dir, io);
  const run = async () => {
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
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw Error(`Host ${phase} response unparseable`);
    }
  };
  let r;
  try {
    r = mutation ? await once(path.join(dir, 'host'), phase, {}, run) : await run();
  } catch (e) {
    if (mutation)
      throw new InspectionRequired(`Host ${phase} outcome requires inspection`, { cause: e });
    throw e;
  }
  await save(path.join(dir, 'host', `${phase}.json`), r);
  return r;
}

const hostCommon = `
import sys,json,pathlib,subprocess,hashlib,os,datetime,fcntl,tarfile
x=json.load(sys.stdin);d=x['deployment'];P=pathlib.Path
assert P('/etc/machine-id').read_text().strip()==d['machineId']
def run(a):
 r=subprocess.run(a,capture_output=True,text=True,timeout=3000)
 if r.returncode: raise RuntimeError('host command failed: '+a[0])
 return r.stdout
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
def h(p):return hashlib.sha256(P(p).read_bytes()).hexdigest()
def metadata(p):
 s=P(p).stat();return {'inode':s.st_ino,'mode':s.st_mode,'uid':s.st_uid,'gid':s.st_gid,'size':s.st_size,'mtime':s.st_mtime_ns}
def settings(v):return {k:v['HostConfig'].get(k) for k in ['NetworkMode','PortBindings','RestartPolicy','LogConfig']}
def webfiles(root):return [{'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':h(p)} for p in sorted(root.rglob('*')) if p.is_file()]
def wd(entries):return 'sha256:'+hashlib.sha256(json.dumps(entries,sort_keys=True,separators=(',',':')).encode()).hexdigest()
`;
const capacitySource =
  hostCommon +
  `
s=os.statvfs('/');available=s.f_bavail*s.f_frsize
old=inspect(d['container'])
assert old['Id']==d['expectedContainer'] and old['Image']==d['expectedImage'] and old['State']['Running']
assert available>=d['minimumFreeBytes']
assert 'sha256:'+h(d['environmentFile'])==d['configurationDigest']
print(json.dumps({'availableBytes':available,'dockerSystemDf':run(['docker','system','df']),'images':run(['docker','image','ls','--digests','--no-trunc',d['imageRepository']]),'container':old['Id'],'image':old['Image']}))
`;
const buildSource =
  hostCommon +
  `
archive=P(d['archiveDirectory'])/(x['roundId']+'-'+x['candidate']+'.tar')
assert h(archive)==x['archiveSha256']
tree=P(d['buildDirectory'])/('build-'+x['candidate']+'-'+x['roundId']);assert not tree.exists()
lock=open(P(d['buildDirectory'])/'deploy.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
tree.mkdir()
with tarfile.open(archive) as t:
 assert all(not a.name.startswith('/') and '..' not in P(a.name).parts and not (a.issym() and (a.linkname.startswith('/') or '..' in P(a.linkname).parts)) for a in t.getmembers())
 t.extractall(tree,filter='data')
tag=d['imageRepository']+':'+x['candidate']
build=run(['docker','build','--file',str(tree/'containers/app/Dockerfile'),'--tag',tag,str(tree)])
smoke=run(['docker','run','--rm',tag,'openkit-app-smoke'])
image=json.loads(run(['docker','image','inspect',tag]))[0]
side=P(d['webDirectory'])/(x['candidate']+'-'+x['roundId']+'-image');assert not side.exists()
scratch=x['roundId']+'-web';assert not run(['docker','ps','-aq','--filter','name=^/'+scratch+'$']).strip()
run(['docker','create','--name',scratch,tag])
try:run(['docker','cp',scratch+':/srv/web',str(side)])
finally:run(['docker','rm',scratch])
entries=webfiles(side)
print(json.dumps({'candidate':x['candidate'],'archiveSha256':x['archiveSha256'],'buildExitCode':0,'buildOutput':build,'imageId':image['Id'],'imageCreated':image['Created'],'architecture':image['Architecture'],'smoke':{'exitCode':0,'stdout':smoke},'web':{'files':entries,'directoryDigest':wd(entries)},'buildDirectory':str(tree)}))
`;
const replaceSource =
  hostCommon +
  `
lock=open(P(d['buildDirectory'])/'deploy.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
old=inspect(d['container']);assert old['Id']==d['expectedContainer'] and old['Image']==d['expectedImage'] and old['State']['Running']
image=json.loads(run(['docker','image','inspect',x['imageId']]))[0]
assert image['Config'].get('Entrypoint')==old['Config'].get('Entrypoint') and image['Config'].get('Cmd')==old['Config'].get('Cmd')
assert P(d['environmentFile']).stat().st_mode&0o777==0o600
assert 'sha256:'+h(d['environmentFile'])==d['configurationDigest']
assert all(m['Type']=='bind' and P(m['Source']).exists() and not P(m['Source']).is_symlink() for m in old['Mounts'])
protected={p:metadata(p) for p in d['protectedMetadataPaths']}
assert all(h(p)==v for p,v in d['payloadDigests'].items())
health=old['Config'].get('Healthcheck')
assert not health or (health['Test'][0]=='CMD-SHELL' and not any(w in health['Test'][1].lower() for w in ['authorization','bearer','token','password']))
retained=d['container']+'-offline-'+x['roundId'];assert not run(['docker','ps','-aq','--filter','name=^/'+retained+'$']).strip()
side=P(d['webDirectory'])/(x['candidate']+'-'+x['roundId']+'-image');destination=P(d['webDirectory'])/x['candidate'];current=P(d['webDirectory'])/'current'
assert side.is_dir() and not side.is_symlink() and current.is_symlink()
entries=webfiles(side)
run(['docker','stop','--time','30',d['container']]);run(['docker','update','--restart=no',d['container']])
assert not (P(d['root'])/'server/runtime/nanocore.lock').exists()
if destination.exists():
 assert not destination.is_symlink()
 if webfiles(destination)!=entries:
  previous=P(d['webDirectory'])/(x['candidate']+'-before-'+x['roundId']);assert not previous.exists();destination.rename(previous);side.rename(destination)
else:side.rename(destination)
if current.resolve()!=destination:
 link=P(d['webDirectory'])/('current-'+x['roundId']);assert not link.exists();link.symlink_to(x['candidate']);os.replace(link,current)
run(['docker','rename',d['container'],retained])
args=['docker','run','-d','--name',d['container'],'--env-file',d['environmentFile'],'--network',old['HostConfig']['NetworkMode']]
rp=old['HostConfig']['RestartPolicy'];args+=['--restart',rp['Name']+(':'+str(rp['MaximumRetryCount']) if rp['Name']=='on-failure' and rp['MaximumRetryCount'] else '')]
for target,bindings in (old['HostConfig'].get('PortBindings') or {}).items():
 for binding in bindings:args+=['-p',(binding['HostIp']+':' if binding['HostIp'] else '')+binding['HostPort']+':'+target]
log=old['HostConfig']['LogConfig'];args+=['--log-driver',log['Type']]
for k,v in log['Config'].items():args+=['--log-opt',k+'='+v]
if health:
 args+=['--health-cmd',health['Test'][1]]
 for k,flag in [('Interval','--health-interval'),('Timeout','--health-timeout'),('StartPeriod','--health-start-period')]:
  if health.get(k):args+=[flag,str(health[k])+'ns']
 if health.get('Retries'):args+=['--health-retries',str(health['Retries'])]
for m in old['Mounts']:args+=['--mount','type=bind,src='+m['Source']+',dst='+m['Destination']+(',readonly' if not m['RW'] else '')]
args.append(image['Id']);run(args);new=inspect(d['container']);assert new['State']['Running']
assert settings(new)==settings(old) and new['Config'].get('Healthcheck')==old['Config'].get('Healthcheck') and sorted(new['Config']['Env'])==sorted(old['Config']['Env'])
assert {(m['Source'],m['Destination'],m['RW']) for m in new['Mounts']}=={(m['Source'],m['Destination'],m['RW']) for m in old['Mounts']}
assert protected=={p:metadata(p) for p in d['protectedMetadataPaths']} and all(h(p)==v for p,v in d['payloadDigests'].items())
print(json.dumps({'ok':True,'candidate':x['candidate'],'image':image['Id'],'newContainerId':new['Id'],'newContainerImage':new['Image'],'newContainerConfigImage':new['Config']['Image'],'oldContainerId':old['Id'],'retainedPreviousContainer':retained,'settingsBefore':settings(old),'settingsAfter':settings(new),'sameEnvironmentInMemoryComparison':True,'sameMounts':True,'protectedRootKeyTrustSlotMetadataUnchangedAtStart':True,'dataRoot':d['root'],'configurationDigest':'sha256:'+h(d['environmentFile']),'webFileCount':len(entries),'liveWebPointsAtCommitNamedDirectory':current.resolve()==destination,'webDirectoryDigest':wd(entries)}))
`;

/** Preparation pins source/instrument identities before archive transfer and client preflight. */
export async function prepare(paramsFile, dir, seams = {}) {
  const io = { ...defaults, ...seams },
    raw = await fs.readFile(paramsFile),
    p = validateParams(JSON.parse(raw));
  for (const key of ['configurationDigest', 'nanoHostDigest', 'workerDigest'])
    if (!/^sha256:[a-f0-9]{64}$/.test(p.deployment[key]))
      throw Error(`Exact ${key} required for live preparation`);
  const blob = await git(io, ['rev-parse', `${p.candidateCommit}:docs/cookbooks/release.md`]);
  if (blob !== p.checklistBlob) throw Error('Frozen checklist blob mismatch');
  const source = await git(io, ['show', `${p.candidateCommit}:docs/cookbooks/release.md`]);
  if (!source.includes('## First-Release Scenario Set'))
    throw Error('Frozen checklist section missing');
  const code = await instrument(),
    commit = await git(io, ['rev-parse', 'HEAD']);
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(dir, 'params.json'), raw, { flag: 'wx', mode: 0o600 });
  for (const r of RUNTIMES)
    await fs.mkdir(path.join(dir, 'runtimes', r), { recursive: true, mode: 0o700 });
  const receipt = {
    runnerCommit: commit,
    runnerSha256: code.sha256,
    instrumentFiles: code.entries,
    parameterSha256: sha(raw),
    checklistBlob: blob,
    checklistSectionSha256: sha(source.slice(source.indexOf('## First-Release Scenario Set'))),
    candidateCommit: p.candidateCommit,
    preparedAt: io.now(),
  };
  await save(path.join(dir, 'checklist-section.json'), {
    text: source.slice(source.indexOf('## First-Release Scenario Set')),
  });
  await save(path.join(dir, 'prepare.json'), receipt);
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
  const secret = seams.credential ?? (await credential(p.cli.credentialFile));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'release-source-')),
    archive = path.join(temp, 'source.tar');
  try {
    const result = await io.exec(
      'git',
      ['archive', '--format=tar', `--output=${archive}`, p.candidateCommit],
      { cwd: repo, timeout: 60000 }
    );
    if (result.exitCode !== 0) throw Error('Exact source archive failed');
    const archiveSha256 = sha(await fs.readFile(archive));
    await remote(p, dir, io, 'capacity', {}, capacitySource);
    await guard(p, dir, io);
    const remotePath = path.posix.join(
      p.deployment.archiveDirectory,
      `${p.roundId}-${p.candidateCommit}.tar`
    );
    // SFTP-mode scp uses the validated path literally, without remote shell quoting.
    const transfer = await io.exec(
      'scp',
      ['-o', 'BatchMode=yes', archive, `${p.deployment.sshAlias}:${remotePath}`],
      { timeout: p.bounds.processMs }
    );
    await save(path.join(dir, 'archive-transfer.json'), transfer, [secret]);
    if (transfer.exitCode !== 0) throw Error('Archive transfer failed');
    const check = await remote(
      p,
      dir,
      io,
      'archive-digest',
      { remotePath },
      `${hostCommon}\nprint(json.dumps({'sha256':h(x['remotePath'])}))\n`
    );
    if (check.sha256 !== archiveSha256) throw Error('Remote archive digest mismatch');
    await save(path.join(dir, 'archive.json'), {
      candidateCommit: p.candidateCommit,
      sha256: archiveSha256,
      remoteSha256: check.sha256,
    });

    await externalClient(p, dir, io, true, secret);
    await scan(dir, [secret]);
    await save(path.join(dir, 'prepare-complete.json'), {
      completedAt: io.now(),
      runnerSha256: receipt.runnerSha256,
    });
    return receipt;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
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
    this.phase = 'deployment';
    this.spans = [];
  }
  /** Record ownership once; a linked Goal Task may already have an ownership receipt. */
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
  async call(op, input, mutation = false, { replay = false } = {}) {
    noSecrets(input);
    if (input.workspaceId && input.workspaceId !== this.p.workspaceId)
      throw Error('Only the declared Workspace addressable');
    if (this.p.protectedIds.some((v) => JSON.stringify(input).includes(v)))
      throw Error('Protected identifier refused');
    if (input.administrationThreadId && !this.owned.has(input.administrationThreadId))
      throw Error('Only round-owned administration Threads addressable');
    if (input.threadId && !this.owned.has(input.threadId))
      throw Error('Only round-owned Threads addressable');
    if (mutation ? !mutations[this.phase]?.has(op) : !reads[this.phase]?.has(op))
      throw Error(`Public operation ${op} refused in ${this.phase}`);
    const name = `${op.replaceAll('.', '-')}-${mutation ? sha(input.requestId ?? canonical(input)) : randomUUID()}${replay ? '-replay' : ''}`,
      directory = path.join(this.dir, 'calls');
    const invoke = async () => {
      await guard(this.p, this.dir, this.io);
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
        if (
          op === 'administration.conversation-submit' &&
          (typeof payload.data.receivingThreadId !== 'string' ||
            !payload.data.receivingThreadId ||
            typeof payload.data.receivingWorkspaceId !== 'string' ||
            !payload.data.receivingWorkspaceId ||
            payload.data.receivingThreadId !== payload.data.turn?.threadId ||
            payload.data.receivingWorkspaceId !== payload.data.turn?.workspaceId ||
            !Array.isArray(payload.data.turn?.items))
        )
          throw new InspectionRequired(
            'Malformed administration Thread identity; inspect without resubmission'
          );
        if (
          op === 'worker-environment.prepare' &&
          (payload.data.requestId !== input.requestId ||
            !workerPreparedMatches(
              payload.data,
              input.target,
              input.configuration,
              input.declaration.ref
            ))
        )
          throw new InspectionRequired(
            'Malformed prepared Worker candidate; inspect without resubmission'
          );
        if (
          op === 'worker-environment.activate' &&
          (payload.data.requestId !== input.requestId ||
            canonical(payload.data.target) !== canonical(input.target) ||
            canonical(payload.data.resolvedCandidate) !== canonical(input.resolvedCandidate) ||
            payload.data.replaceNow !== null ||
            !Array.isArray(payload.data.affected) ||
            payload.data.affected.length !== 0 ||
            !Object.hasOwn(payload.data, 'configuration') ||
            (payload.data.configuration !== null &&
              (payload.data.configuration?.fileId !== input.configuration.fileId ||
                !/^sha256:[a-f0-9]{64}$/.test(payload.data.configuration?.revision))))
        )
          throw new InspectionRequired(
            'Malformed activated Worker candidate; inspect without resubmission'
          );
        const d = payload.data,
          id = ['thread.create', 'turn.start', 'thread.update'].includes(op)
            ? d.id
            : ['task.start', 'conversation.submit', 'administration.conversation-submit'].includes(
                  op
                )
              ? d.turn?.id
              : op === 'goal.create'
                ? d.goal?.goalId
                : null;
        if (id !== null && (typeof id !== 'string' || !id.length))
          throw new InspectionRequired(
            `Invalid ${op} result identity; inspect without resubmission`
          );
      }
      return redact(payload, this.secrets);
    };
    if (mutation) {
      try {
        return await once(directory, name, { ...input, replay }, invoke, this.secrets);
      } catch (e) {
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
  async observe(tid, { goalId } = {}) {
    const start = Date.parse(this.io.now());
    let board,
      goal,
      timedOut = false;
    for (;;) {
      if (goalId)
        goal = await this.call('goal.read', {
          workspaceId: this.p.workspaceId,
          threadId: tid,
          goalId,
        });
      board = await this.call('thread.dashboard', {
        workspaceId: this.p.workspaceId,
        threadId: tid,
      });
      if (!board.ok) break;
      const b = board.data;
      if (b.pendingRequests.some((q) => q.state === 'pending')) {
        try {
          await this.waitDecisions(tid, b, goal);
          if (Date.parse(this.io.now()) - start >= this.p.bounds.observationMs) {
            timedOut = true;
            break;
          }
          await this.io.sleep(this.p.bounds.pollMs);
          continue;
        } catch (e) {
          if (e instanceof InspectionRequired) throw e;
          timedOut = true;
          break;
        }
      }
      if (
        b.turns.length &&
        b.turns.every((t) => terminal.has(t.status)) &&
        b.workStatus.activeTurnStatus === 'idle' &&
        (!goalId || goal?.data?.goal?.changeRevision === goal?.data?.goal?.consideredRevision)
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
      goal,
    };
  }
  /** Hand full exact intent to the operator; expiration supplies no implicit grant. */
  async waitDecisions(tid, board, goal) {
    const pending = board.pendingRequests.filter((q) => q.state === 'pending');
    for (const request of pending) {
      if (!['task', 'goal'].includes(this.phase))
        throw Error('Unexpected runtime Pending Request; no automatic decision');
      const key = sha(request.requestId),
        f = path.join(this.dir, 'pending', `${key}.json`);
      let exists = false;
      try {
        await fs.access(f);
        exists = true;
      } catch {}
      if (!exists) {
        const full =
          goal?.data?.requests?.find((v) => v.requestId === request.requestId) ?? request;
        if (!full.approvalEffect && !full.exactIntent)
          throw Error('Full Pending Request unavailable; no unsupported read invented');
        await save(f, {
          request: full,
          phase: this.phase,
          threadId: tid,
          goal: goal?.data,
          expiresAt: new Date(Date.parse(this.io.now()) + this.p.bounds.decisionMs).toISOString(),
        });
      }
      const saved = await readJson(f);
      process.stderr.write(`Read pending/${key}.json in full, then run decide for its request.\n`);
      for (;;) {
        try {
          await fs.access(path.join(this.dir, 'decisions', `${key}-ambiguous.json`));
          throw new InspectionRequired(
            'Operator decision outcome ambiguous; inspect without resubmission'
          );
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        try {
          const outcome = await readJson(path.join(this.dir, 'decisions', `${key}-result.json`));
          if (!outcome.ok) throw Error('Decision refused by product');
          break;
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        if (Date.parse(this.io.now()) >= Date.parse(saved.expiresAt))
          throw Error('Pending Request decision timeout; no grant submitted');
        await this.io.sleep(this.p.bounds.pollMs);
      }
    }
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

/** Each group owns one directory and one fresh Thread, ready for future caller-level concurrency. */
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
    A: `Reply with exactly ${cfg.marker} and nothing else.`,
    B: `Using only the github MCP tools, read issue ${p.issue.number} of ${p.issue.repository} and reply with its exact title and state. Do not modify anything.`,
    C: `Write exactly the UTF-8 text ${cfg.marker} with no trailing newline to ${cfg.filename} in your admitted default output root, and the same bytes to notes/${cfg.filename} in the retained Workspace. Read both files back. Submit the actual default-output file with work_submit_artifact using its canonical absolute path, kind file, media type text/plain and title ${cfg.filename}. Report the filename, bytes and returned Artifact id. Remember the marker.`,
    D: `State the marker from conversation memory. Read notes/${cfg.filename} from the retained Workspace without rewriting or recreating it. Copy its existing bytes to ${cfg.filename} in this Turn's default output root and submit that actual file using work_submit_artifact, canonical absolute path, kind file, media type text/plain, title ${cfg.filename}, and a new submission request id. Report the marker, filename and returned Artifact id. If the file is absent report the failure; never recreate it.`,
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
        s.outcome = e.timedOut ? 'timeout' : s.turn?.status;
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
async function githubTask(client) {
  const { p, dir, io } = client,
    base = `repos/${p.task.repository}`,
    branch = await github(
      p,
      dir,
      io,
      'task-branch',
      `${base}/branches/${encodeURIComponent(p.task.branch)}`
    ),
    prs = await github(
      p,
      dir,
      io,
      'task-pulls',
      `${base}/pulls?state=all&base=${encodeURIComponent(p.task.base)}&head=${encodeURIComponent(`${p.task.repository.split('/')[0]}:${p.task.branch}`)}&per_page=100`
    ),
    reads = [branch.receipt, prs.receipt],
    pullRequests = [];
  for (const pr of prs.data ?? []) {
    const f = await github(
      p,
      dir,
      io,
      `task-files-${pr.number}`,
      `${base}/pulls/${pr.number}/files?per_page=100`
    );
    reads.push(f.receipt);
    pullRequests.push({
      pullRequest: pr,
      head: { ref: pr.head.ref, sha: pr.head.sha, repository: pr.head.repo.full_name },
      base: { ref: pr.base.ref, sha: pr.base.sha, repository: pr.base.repo.full_name },
      changedFiles: f.data ?? [],
    });
  }
  const proof = {
    reads,
    branch: branch.data ? { name: branch.data.name, headSha: branch.data.commit.sha } : null,
    pullRequests,
  };
  for (const projection of taskReadProjections(proof, p)) {
    const receipt = reads.find((v) => v.route === projection.route);
    if (receipt)
      Object.assign(receipt, {
        body: structuredClone(projection.body),
        bodyDigest: digest(canonical(projection.body)),
      });
  }
  return proof;
}
async function decisions(dir, phase) {
  const out = [];
  try {
    for (const f of await fs.readdir(path.join(dir, 'decisions'))) {
      if (!f.endsWith('-record.json')) continue;
      const d = await readJson(path.join(dir, 'decisions', f));
      if (d.phase === phase) out.push(d);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return out;
}

/** Operator decisions validate current exact intent and are submitted once, never granted by the runner. */
export async function decide(dir, requestId, decision, seams = {}) {
  if (!['grant', 'deny'].includes(decision)) throw Error('Decision must be grant or deny');
  try {
    await fs.access(path.join(dir, 'round-stop.json'));
    throw Error('Round sealed; inspect without a decision');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const { p } = await pinned(dir),
    io = { ...defaults, ...seams },
    key = sha(requestId),
    pending = await readJson(path.join(dir, 'pending', `${key}.json`));
  const secret = seams.credential ?? (await credential(p.cli.credentialFile));
  try {
    if (pending.kind === 'worker-environment')
      return await decideWorker(dir, requestId, decision, p, pending, io, {
        ...seams,
        credential: secret,
      });
    if (pending.request.requestId !== requestId) throw Error('Pending Request identity mismatch');
    if (Date.parse(io.now()) >= Date.parse(pending.expiresAt))
      throw Error('Pending Request expired');
    const client = new RoundClient(p, dir, io, [secret]);
    for (const f of await fs.readdir(path.join(dir, 'owned')))
      client.owned.add((await readJson(path.join(dir, 'owned', f))).threadId);
    client.phase = 'decision';
    const base = { workspaceId: p.workspaceId, threadId: pending.threadId };
    let request, current;
    if (pending.phase === 'goal') {
      current = await client.call('goal.read', { ...base, goalId: pending.goal.goal.goalId });
      request = current.data?.requests.find(
        (q) => q.requestId === requestId && q.state === 'pending'
      );
    } else {
      current = await client.call('thread.dashboard', base);
      request = current.data?.pendingRequests.find(
        (q) => q.requestId === requestId && q.state === 'pending'
      );
    }
    if (!request || !sameIntent(request, pending.request))
      throw Error('Pending exact intent changed or no longer pending');
    if (
      decision === 'grant' &&
      !(pending.phase === 'task'
        ? allowedTaskIntent(request, p)
        : allowedGoalIntent(request, current.data, p))
    )
      throw Error('Grant intent differs from the frozen allowed scenario');
    if (decision === 'grant' && pending.phase === 'task') {
      const toolOf = (q) => {
        const d = q.approvalEffect?.detail;
        return (typeof d === 'string' ? JSON.parse(d) : d)?.toolName;
      };
      const tool = toolOf(request);
      if (
        (await decisions(dir, 'task')).some(
          (v) =>
            v.pendingRequest.requestId !== requestId &&
            v.input.decision === 'granted' &&
            toolOf(v.pendingRequest) === tool
        )
      )
        throw Error(
          'A Task external write of this kind was already decided; no retry or second pull request'
        );
    }
    let taskEvidence;
    if (decision === 'grant' && request.operation === 'goal.completion.accept') {
      const link = current.data.tasks[0];
      await client.own(link.threadId);
      taskEvidence = await client.observe(link.threadId);
      const candidate = JSON.parse(request.exactIntent.bytes),
        turns = taskEvidence.turnReads.map((v) => v.data),
        items = taskEvidence.items.data;
      const artifacts = taskEvidence.artifactReads
        .filter((v) => v.ok)
        .map((v) => v.data.artifact ?? v.data);
      const valid = artifacts.filter(
        (a) =>
          a.title === p.goal.filename &&
          a.kind === 'file' &&
          a.origin?.kind === 'turn-output' &&
          a.origin.threadId === link.threadId &&
          turns.some((t) => t.id === a.origin.turnId && t.status === 'completed') &&
          typeof a.content?.body === 'string' &&
          a.contentDigest === digest(a.content.body) &&
          p.goal.requiredContent.every((v) => a.content.body.includes(v)) &&
          items.items.some(
            (i) =>
              i.type === 'artifact-reference' &&
              i.status === 'completed' &&
              i.artifactId === a.id &&
              i.turnId === a.origin.turnId
          ) &&
          candidate.evidence.some(
            (e) => e.kind === 'artifact' && e.id === a.id && e.digest === a.contentDigest
          )
      );
      if (
        items.nextCursor !== null ||
        valid.length !== 1 ||
        turns.some((t) => t.status !== 'completed') ||
        items.items.some(
          (i) =>
            i.type === 'tool-call' &&
            i.server === 'github' &&
            [
              'create_branch',
              'push_files',
              'create_pull_request',
              'issue_write',
              'merge_pull_request',
              'add_issue_comment',
            ].includes(i.tool)
        )
      )
        throw Error('Goal completion output differs from the exact allowed candidate');
    }
    const op = pending.phase === 'task' ? 'approval.respond' : request.operation,
      input = {
        ...base,
        requestId: randomUUID(),
        decision: decision === 'grant' ? 'granted' : 'denied',
        ...(pending.phase === 'task'
          ? { turnId: request.turnId ?? pending.request.turnId, approvalRequestId: requestId }
          : { goalId: pending.goal.goal.goalId, pendingRequestId: requestId }),
      };
    if (pending.phase === 'task' && !input.turnId) {
      const items = await client.page('thread.items', base);
      input.turnId = items.data?.items.find(
        (i) =>
          i.requestId === requestId || i.approvalRequestId === requestId || i.id === request.itemId
      )?.turnId;
      if (!input.turnId) throw Error('Pending Request Turn unavailable');
    }
    const record = {
      phase: pending.phase,
      pendingRequest: request,
      input,
      before: current,
      taskEvidence,
      decidingActorId: pending.phase === 'task' ? p.task.decidingActorId : p.goal.decidingActorId,
      operator: os.userInfo().username,
      decidedAt: io.now(),
    };
    await save(path.join(dir, 'decisions', `${key}-record.json`), record, [secret]);
    const result = await once(
      path.join(dir, 'decisions'),
      key,
      input,
      () => client.call(op, input, true),
      [secret]
    );
    record.response = result;
    await save(path.join(dir, 'decisions', `${key}-record.json`), record, [secret], false);
    return result;
  } finally {
    await scan(dir, [secret]);
  }
}
function sameIntent(a, b) {
  return (
    canonical(a.exactIntent ?? a.approvalEffect) === canonical(b.exactIntent ?? b.approvalEffect)
  );
}

/** The fresh client receives only persona and goal; its bridge holds the credential. */
async function externalClient(p, dir, io, preflight, secret) {
  const kind = preflight ? 'preflight' : 'external',
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'release-actor-')),
    bridgeSha256 = sha(await fs.readFile(here));
  await save(path.join(dir, `${kind}-launch.json`), {
    startedAt: io.now(),
    workingDirectory: work,
    bridgeSha256,
  });
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    work,
    '--json',
    '--color',
    'never',
    '--model',
    p.external.modelId,
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'web_search="disabled"',
  ];
  for (const feature of [
    'shell_tool',
    'unified_exec',
    'apps',
    'plugins',
    'multi_agent',
    'computer_use',
    'browser_use',
    'in_app_browser',
    'skill_mcp_dependency_install',
  ])
    args.push('--disable', feature);
  for (const [key, value] of Object.entries({
    sqlite_home: path.join(work, 'state'),
    log_dir: path.join(work, 'logs'),
    'mcp_servers.openkit.command': process.execPath,
    'mcp_servers.openkit.args': [here],
    'mcp_servers.openkit.default_tools_approval_mode': 'approve',
    'mcp_servers.openkit.startup_timeout_sec': 60,
    'mcp_servers.openkit.tool_timeout_sec': 120,
    'mcp_servers.openkit.required': true,
    'mcp_servers.openkit.enabled_tools': ['guide', 'search', 'describe', 'call'],
  }))
    args.push('-c', `${key}=${JSON.stringify(value)}`);
  args.push('-');
  await guard(p, dir, io);
  const version = await io.exec(p.external.executable, ['--version'], { timeout: 20000 });
  const prompt = preflight
    ? 'List the names of every tool you can call from the openkit MCP server. Do not call any of them.'
    : `${p.external.persona}\n\n${p.external.goal}`;
  let result;
  try {
    result = await once(
      path.join(dir, 'launches'),
      kind,
      {},
      () =>
        io.exec(p.external.executable, args, {
          input: prompt,
          cwd: work,
          timeout: p.bounds.processMs,
          env: {
            ...cleanEnvironment(),
            RELEASE_ROUND_BRIDGE: dir,
            RELEASE_ROUND_BRIDGE_PHASE: kind,
          },
        }),
      [secret]
    );
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
  const transcript = [];
  try {
    for (const f of (await fs.readdir(path.join(dir, kind, 'mcp'))).sort())
      transcript.push(await readJson(path.join(dir, kind, 'mcp', f)));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const allowedMethods = new Set(['initialize', 'notifications/initialized', 'tools/list', 'ping']);
  let passed = true;
  if (preflight)
    passed =
      result.exitCode === 0 &&
      transcript.some(
        (v) =>
          v.method === 'tools/list' &&
          v.httpStatus === 200 &&
          ['guide', 'search', 'describe', 'call'].every((n) =>
            v.response?.result?.tools?.some((t) => t.name === n)
          )
      ) &&
      transcript.every((v) => allowedMethods.has(v.method)) &&
      ['guide', 'search', 'describe', 'call'].every((n) => result.stdout.includes(n));
  const receipt = {
    ...redact(result, [secret]),
    startedAt: (await readJson(path.join(dir, `${kind}-launch.json`))).startedAt,
    finishedAt: io.now(),
    arguments: args,
    clientVersion: version.stdout.trim(),
    personaAndGoal: preflight ? undefined : prompt,
    carrierSha256: bridgeSha256,
    workingDirectory: work,
    outsideSourceCheckout: true,
    workingDirectoryRemoved: true,
    checklistExpectedAnswerSshToolsAndPreflightOutputSupplied: false,
    passed,
  };
  await save(path.join(dir, `${kind}-receipt.json`), receipt, [secret]);
  await save(path.join(dir, `${kind}-mcp-transcript.json`), transcript, [secret]);
  if (preflight && !passed)
    throw Error('External tool-visibility preflight failed; no other client variant admitted');
  return { receipt, transcript };
}

/** Recording stdio-to-remote-MCP bridge; its own executable digest is pinned by preflight. */
async function bridge(dir, phase) {
  const { p } = await pinned(dir),
    secret = await credential(p.cli.credentialFile),
    io = defaults;
  let session,
    protocol,
    n = 0;
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let request, row;
    try {
      request = JSON.parse(line);
      noSecrets(request);
      if (p.protectedIds.some((v) => line.includes(v))) throw Error('Protected identifier');
      if (
        phase === 'preflight' &&
        !['initialize', 'notifications/initialized', 'tools/list', 'ping'].includes(request.method)
      )
        throw Error('Preflight operation refused');
      if (request.method === 'tools/call') {
        const name = request.params?.name;
        if (!['guide', 'search', 'describe', 'call'].includes(name))
          throw Error('External tool refused');
        if (name === 'call') {
          const a = request.params.arguments;
          if (!externalReads.has(a.operation)) throw Error('External operation refused');
          const input = a.input ?? {};
          if (input.threadId) {
            const owned = [];
            for (const f of await fs.readdir(path.join(dir, 'owned')))
              owned.push((await readJson(path.join(dir, 'owned', f))).threadId);
            if (!owned.includes(input.threadId)) throw Error('External Thread not round-owned');
          }
          if (input.workspaceId && input.workspaceId !== p.workspaceId)
            throw Error('External Workspace refused');
        }
      } else if (
        ![
          'initialize',
          'notifications/initialized',
          'tools/list',
          'resources/list',
          'ping',
        ].includes(request.method)
      )
        throw Error('External MCP method refused');
      await guard(p, dir, io);
      const startedAt = io.now(),
        headers = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${secret}`,
        };
      if (session) headers['Mcp-Session-Id'] = session;
      if (protocol) headers['MCP-Protocol-Version'] = protocol;
      const response = await fetch(new URL('/mcp', p.cli.origin), {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(120000),
      });
      session = response.headers.get('Mcp-Session-Id') ?? session;
      const raw = await response.text(),
        text = response.headers.get('content-type')?.includes('text/event-stream')
          ? raw
              .split('\n')
              .filter((v) => v.startsWith('data:'))
              .map((v) => v.slice(5).trim())
              .join('\n')
          : raw;
      const payload = text.trim() ? JSON.parse(text) : null;
      if (request.method === 'initialize') protocol = payload?.result?.protocolVersion;
      row = {
        startedAt,
        observedAt: io.now(),
        method: request.method,
        request,
        httpStatus: response.status,
        response: redact(payload, [secret]),
      };
    } catch (e) {
      row = {
        startedAt: io.now(),
        observedAt: io.now(),
        method: request?.method,
        request: redact(request, [secret]),
        httpStatus: null,
        connectionReset: e.cause?.code === 'ECONNRESET',
        exceptionType: e.name,
        response: request?.id
          ? {
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32603, message: 'Recording bridge refused or failed' },
            }
          : null,
      };
    }
    await save(path.join(dir, phase, 'mcp', `${String(++n).padStart(6, '0')}.json`), row, [secret]);
    if (request?.id !== undefined && row.response)
      process.stdout.write(`${JSON.stringify(row.response)}\n`);
  }
}

/** A definite maintenance refusal stops dependent scenarios without classifying them as failed. */
export class DeploymentRefused extends Error {}

const workerBuildSource =
  hostCommon +
  `
# Build only the host's platform from the App's exact extracted tree; never publish an image.
tree=P(x['buildDirectory']);expected=P(d['buildDirectory'])/('build-'+x['candidate']+'-'+x['roundId'])
assert tree==expected and tree.is_dir() and not tree.is_symlink()
archive=P(d['archiveDirectory'])/(x['roundId']+'-'+x['candidate']+'.tar');assert h(archive)==x['archiveSha256']
output=P(d['archiveDirectory'])/(x['roundId']+'-'+x['candidate']+'-worker.oci.tar');assert not output.exists()
try:
 platform=run(['docker','info','--format','{{.OSType}}/{{.Architecture}}']).strip()
 platform={'linux/x86_64':'linux/amd64','linux/aarch64':'linux/arm64'}.get(platform,platform)
 assert platform in ['linux/amd64','linux/arm64']
 args=['docker','buildx','build','--file',str(tree/'containers/workers/Dockerfile'),'--target','worker-runtimes','--platform',platform,'--provenance=false','--sbom=false','--output','type=oci,oci-mediatypes=true,dest='+str(output),str(tree)]
 process=subprocess.run(args,capture_output=True,text=True,timeout=3000)
 if process.returncode:
  print(json.dumps({'ok':False,'stage':'build','exitCode':process.returncode,'stdout':process.stdout,'stderr':process.stderr}))
 else:
  with tarfile.open(output,'r:') as t:
   members=t.getmembers();assert len({m.name for m in members})==len(members)
   assert all(not m.issym() and not m.islnk() for m in members)
   def document(name):
    m=t.getmember(name);assert m.isfile() and m.size<=1048576
    return t.extractfile(m).read()
   assert json.loads(document('oci-layout'))=={'imageLayoutVersion':'1.0.0'}
   index=json.loads(document('index.json'));assert set(index)<=set(['schemaVersion','mediaType','manifests']) and index['schemaVersion']==2
   assert len(index['manifests'])==1
   descriptor=index['manifests'][0];assert descriptor['mediaType'] in ['application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.v2+json']
   imageDigest=descriptor['digest'];assert imageDigest.startswith('sha256:') and len(imageDigest)==71
   manifestBytes=document('blobs/sha256/'+imageDigest[7:]);assert 'sha256:'+hashlib.sha256(manifestBytes).hexdigest()==imageDigest and len(manifestBytes)==descriptor['size']
   manifest=json.loads(manifestBytes);config=json.loads(document('blobs/sha256/'+manifest['config']['digest'][7:]))
   assert config['os']+'/'+config['architecture']==platform
  print(json.dumps({'ok':True,'candidate':x['candidate'],'archiveSha256':x['archiveSha256'],'buildDirectory':str(tree),'platform':platform,'target':'worker-runtimes','archive':str(output),'archiveDigest':'sha256:'+h(output),'digest':imageDigest,'exitCode':0,'stdout':process.stdout,'stderr':process.stderr}))
except subprocess.TimeoutExpired:
 raise
except Exception as error:
 print(json.dumps({'ok':False,'stage':'build','safeCause':type(error).__name__}))
`;
const workerImportSource =
  hostCommon +
  `
# NanoHost validates every referenced blob; Docker inventory cannot stand in for its Image Store.
archive=P(d['archiveDirectory'])/(x['roundId']+'-'+x['candidate']+'-worker.oci.tar')
assert str(archive)==x['archive'] and 'sha256:'+h(archive)==x['archiveDigest']
assert 'sha256:'+h('/usr/lib/openkit/nanohost')==d['nanoHostDigest']
process=subprocess.run(['/usr/lib/openkit/nanohost','image','import',str(archive),x['digest']],capture_output=True,text=True,timeout=3000)
print(json.dumps({'ok':process.returncode==0,'exitCode':process.returncode,'digest':process.stdout.strip() if process.returncode==0 else None,'expectedDigest':x['digest'],'archiveDigest':x['archiveDigest'],'stdout':process.stdout,'stderr':process.stderr}))
`;

/** Build/import once, then admit each declared Agent through reviewed public owner operations. */
export async function updateWorker(client, appBuild, deployment) {
  if (deployment.components.worker.unchanged) return;
  const { p, dir, io } = client;
  deployment.workerUpdate ??= { agents: [] };
  const update = deployment.workerUpdate;
  update.agents ??= [];
  const persist = () => save(path.join(dir, 'worker-update.json'), update, client.secrets, false);
  const refuse = async (stage, proof) => {
    update.failure = { stage, proof, at: io.now() };
    await persist();
    throw new DeploymentRefused(
      `Worker maintenance ${stage} refused; no dependent scenario submitted`
    );
  };
  update.build = await remote(
    p,
    dir,
    io,
    'worker-build',
    {
      buildDirectory: appBuild.buildDirectory,
      archiveSha256: appBuild.archiveSha256,
    },
    workerBuildSource,
    true
  );
  await persist();
  if (update.build.ok === false) await refuse('build', update.build);
  if (
    update.build.ok !== true ||
    !/^sha256:[a-f0-9]{64}$/.test(update.build.digest) ||
    !/^sha256:[a-f0-9]{64}$/.test(update.build.archiveDigest) ||
    typeof update.build.archive !== 'string'
  )
    throw new InspectionRequired('Malformed Worker build result; inspect without resubmission');
  if (
    update.build.candidate !== p.candidateCommit ||
    update.build.buildDirectory !== appBuild.buildDirectory ||
    update.build.archiveSha256 !== appBuild.archiveSha256 ||
    update.build.target !== 'worker-runtimes' ||
    !['linux/amd64', 'linux/arm64'].includes(update.build.platform)
  )
    await refuse('build attribution', update.build);
  update.import = await remote(
    p,
    dir,
    io,
    'worker-import',
    {
      archive: update.build.archive,
      archiveDigest: update.build.archiveDigest,
      digest: update.build.digest,
    },
    workerImportSource,
    true
  );
  await persist();
  if (update.import.ok === false) await refuse('import', update.import);
  if (update.import.ok !== true || typeof update.import.digest !== 'string')
    throw new InspectionRequired('Malformed Worker import result; inspect without resubmission');
  if (
    update.import.digest !== update.build.digest ||
    update.import.expectedDigest !== update.build.digest ||
    update.import.archiveDigest !== update.build.archiveDigest
  )
    await refuse('import digest', update.import);
  update.administrationInput = {
    requestId: randomUUID(),
    input:
      'Reply READY to acknowledge this fresh private administration Thread for release maintenance. Perform no Tools or configuration actions.',
  };
  update.administration = await client.call(
    'administration.conversation-submit',
    update.administrationInput,
    true
  );
  await persist();
  const administration = update.administration;
  if (
    !administration.ok ||
    administration.data.outcome !== 'answered' ||
    administration.data.targetRef !== 'internal-role:administration' ||
    administration.data.turn.status !== 'completed' ||
    administration.data.turn.items.some((v) => v.type.includes('tool'))
  )
    await refuse('administration Thread', administration);
  const administrationThreadId = administration.data.receivingThreadId;
  await client.own(administrationThreadId);
  update.administrationThreadId = administrationThreadId;
  const files = await client.call('runtime.file-list', {});
  if (!files.ok) await refuse('configuration discovery', files);
  if (!Array.isArray(files.data.files)) throw Error('Agent configuration inventory unavailable');
  // The public view resolves JSONC and reports the actual authored Agent id and persisted revision.
  const views = [];
  for (const file of files.data.files.filter((f) => f.kind === 'agent' && f.exists)) {
    const view = await client.call('runtime.agent-environment-read', { fileId: file.id });
    views.push(view);
  }
  update.configurationViews = views;
  await persist();
  for (const agentId of p.deployment.workerAgents) {
    const matching = views.filter((v) => v.ok && v.data.agentId === agentId);
    if (matching.length !== 1) throw Error('Exact Agent configuration identity unavailable');
    const before = matching[0],
      configuration = {
        fileId: before.data.fileId,
        expectedRevision: before.data.persistedRevision,
      },
      target = { kind: 'agent', agentId };
    if (!/^sha256:[a-f0-9]{64}$/.test(configuration.expectedRevision))
      throw Error('Exact Agent revision unavailable');
    const entry = {
      agentId,
      before,
      input: {
        administrationThreadId,
        configuration,
        declaration: { kind: 'reference', ref: update.build.digest, pullPolicy: 'never' },
        target,
        requestId: randomUUID(),
      },
    };
    update.agents.push(entry);
    entry.prepared = await client.call('worker-environment.prepare', entry.input, true);
    await persist();
    if (!entry.prepared.ok) await refuse('preparation', entry.prepared);
    const prepared = entry.prepared.data,
      requestId = prepared.resolvedCandidate.artifactId,
      key = sha(requestId),
      expiresAt = new Date(Date.parse(io.now()) + p.bounds.decisionMs).toISOString();
    await save(path.join(dir, 'worker', 'agents', `${sha(agentId)}.json`), entry, client.secrets);
    await save(
      path.join(dir, 'pending', `${key}.json`),
      {
        kind: 'worker-environment',
        requestId,
        agentId,
        importedDigest: update.build.digest,
        prepared: entry.prepared,
        expiresAt,
      },
      client.secrets
    );
    process.stderr.write(
      `Read pending/${key}.json in full, then run decide for its Worker candidate request.\n`
    );
    for (;;) {
      try {
        await fs.access(path.join(dir, 'decisions', `${key}-ambiguous.json`));
        throw new InspectionRequired(
          'Worker activation outcome ambiguous; inspect without resubmission'
        );
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      try {
        const response = await readJson(path.join(dir, 'decisions', `${key}-result.json`));
        entry.decision = await readJson(path.join(dir, 'decisions', `${key}-record.json`));
        entry.activated = response;
        if (Array.isArray(entry.decision.transport)) client.spans.push(...entry.decision.transport);
        if (!Array.isArray(entry.decision.transport) || entry.decision.transportIncomplete)
          client.transportIncomplete = true;
        if (
          entry.decision.kind !== 'worker-environment' ||
          entry.decision.requestId !== requestId ||
          canonical(entry.decision.prepared) !== canonical(entry.prepared)
        )
          await refuse('decision subject', entry.decision);
        if (entry.decision.decision !== 'grant') await refuse('activation decision', response);
        if (!response.ok) await refuse('activation', response);
        if (
          canonical(entry.decision.input) !==
          canonical(workerActivationInput(prepared, entry.decision.input.requestId))
        )
          await refuse('activation subject', entry.decision);
        break;
      } catch (e) {
        if (e instanceof DeploymentRefused || e instanceof InspectionRequired) throw e;
        if (e.code !== 'ENOENT')
          throw new InspectionRequired(
            'Malformed Worker decision receipt; inspect without resubmission',
            { cause: e }
          );
      }
      if (Date.parse(io.now()) >= Date.parse(expiresAt)) {
        for (const suffix of ['record', 'intent']) {
          try {
            await fs.access(path.join(dir, 'decisions', `${key}-${suffix}.json`));
            throw new InspectionRequired(
              'Worker decision still in flight at the deadline; inspect without resubmission'
            );
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }
        }
        await refuse('decision timeout', { expiresAt, observedAt: io.now(), submitted: false });
      }
      await io.sleep(p.bounds.pollMs);
    }
    entry.status = await client.call('runtime.agent-environment-read', {
      fileId: configuration.fileId,
    });
    await persist();
    if (
      !entry.status.ok ||
      entry.status.data.agentId !== agentId ||
      entry.status.data.fileId !== configuration.fileId ||
      entry.status.data.desired?.imageDigest !== update.build.digest ||
      entry.status.data.reload?.matchesDesired !== true ||
      entry.activated.data.configuration?.fileId !== configuration.fileId ||
      entry.status.data.persistedRevision !== entry.activated.data.configuration?.revision
    )
      await refuse('owner status', entry.status);
  }
  deployment.components.worker = {
    ...deployment.components.worker,
    sourceCommit: p.candidateCommit,
    digest: update.build.digest,
  };
  update.readyAt = io.now();
  await persist();
}

/** An operator grants or denies the exact retained Worker candidate; only a grant submits activation. */
async function decideWorker(dir, requestId, decision, p, pending, io, seams) {
  if (
    !Number.isFinite(Date.parse(pending.expiresAt)) ||
    pending.requestId !== requestId ||
    Date.parse(io.now()) >= Date.parse(pending.expiresAt)
  )
    throw Error('Worker candidate identity mismatch or decision expired');
  try {
    await fs.access(path.join(dir, 'round-stop.json'));
    throw Error('Round sealed; inspect without activation');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const entry = await readJson(path.join(dir, 'worker', 'agents', `${sha(pending.agentId)}.json`)),
    imported = await readJson(path.join(dir, 'host', 'worker-import.json')),
    build = await readJson(path.join(dir, 'host', 'worker-build.json')),
    v = pending.prepared?.data;
  if (
    !p.deployment.workerAgents.includes(pending.agentId) ||
    !pending.prepared?.ok ||
    canonical(pending.prepared) !== canonical(entry.prepared) ||
    imported.ok !== true ||
    imported.digest !== build.digest ||
    imported.expectedDigest !== build.digest ||
    build.candidate !== p.candidateCommit ||
    pending.importedDigest !== imported.digest ||
    v?.resolvedCandidate?.artifactId !== requestId ||
    !workerPreparedMatches(v, entry.input.target, entry.input.configuration, imported.digest)
  )
    throw Error(
      'Worker activation decision differs from retained candidate, target, configuration revision or digest'
    );
  const key = sha(requestId),
    secret = seams.credential ?? (await credential(p.cli.credentialFile)),
    client = new RoundClient(p, dir, io, [secret]);
  client.phase = 'worker-decision';
  const current = await client.call('runtime.agent-environment-read', {
    fileId: v.configuration.fileId,
  });
  if (
    !current.ok ||
    current.data.agentId !== v.target.agentId ||
    current.data.persistedRevision !== v.configuration.expectedRevision
  )
    throw Error('Worker target configuration revision changed before decision');
  if (Date.parse(io.now()) >= Date.parse(pending.expiresAt))
    throw Error('Worker decision expired before activation');
  try {
    await fs.access(path.join(dir, 'round-stop.json'));
    throw Error('Round sealed; inspect without activation');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const input = workerActivationInput(v, randomUUID()),
    record = {
      kind: 'worker-environment',
      requestId,
      prepared: pending.prepared,
      decision,
      input,
      before: current,
      operator: os.userInfo().username,
      decidedAt: io.now(),
    };
  await save(path.join(dir, 'decisions', `${key}-record.json`), record, [secret]);
  const response = await once(
    path.join(dir, 'decisions'),
    key,
    input,
    async () => {
      const response =
        decision === 'grant'
          ? await client.call('worker-environment.activate', input, true)
          : { ok: false, error: { code: 'operator_denied', message: 'Worker activation denied' } };
      Object.assign(record, {
        response,
        transport: client.spans,
        transportIncomplete: client.transportIncomplete ?? false,
      });
      await save(path.join(dir, 'decisions', `${key}-record.json`), record, [secret], false);
      return response;
    },
    [secret]
  );
  return response;
}

async function deploy(client, archive, result) {
  const { p, dir, io } = client,
    start = Date.parse(io.now());
  let baseline, binding;
  // Aggregate observations gate maintenance without reading or cancelling unrelated work.
  for (;;) {
    const workers = await client.call('worker.list', { workspaceId: p.workspaceId }),
      scheduler = await client.call('scheduler.list', { workspaceId: p.workspaceId });
    binding = await client.call('catalog.mcp-list', { workspaceId: p.workspaceId });
    if (!workers.ok || !scheduler.ok || !binding.ok) throw Error('Maintenance observation refused');
    if (
      !binding.data.items.some(
        (v) =>
          v.bindingRevision === p.deployment.bindingRevision &&
          v.currentVersionDigest === p.deployment.bindingDigest
      )
    )
      throw Error('Configuration changed; attribution ended');
    if (workers.data.items.every((v) => v.status === 'idle') && scheduler.data.items.length === 0)
      break;
    if (Date.parse(io.now()) - start > p.bounds.observationMs)
      throw Error('Maintenance gate timeout; no replacement');
    await io.sleep(p.bounds.pollMs);
  }
  baseline = await client.call('nanohost.runtime-target', {});
  if (!baseline.ok) throw Error('Baseline target unavailable');
  const build = await remote(
      p,
      dir,
      io,
      'build',
      { archiveSha256: archive.sha256 },
      buildSource,
      true
    ),
    replace = await remote(p, dir, io, 'replace', { imageId: build.imageId }, replaceSource, true),
    rows = [];
  Object.assign(result, { build, replace, startup: { rows, ready: false } });
  let ready = false;
  for (;;) {
    await guard(p, dir, io);
    const health = { at: io.now() };
    try {
      const response = await io.fetch(new URL('/api/health', p.cli.origin), {
        signal: AbortSignal.timeout(20000),
      });
      health.httpStatus = response.status;
      health.body = await response.text();
    } catch (e) {
      health.httpStatus = null;
      health.safeCause = e.name;
      health.connectionReset = e.cause?.code === 'ECONNRESET';
    }
    const target = await client.call('nanohost.runtime-target', {});
    rows.push({ health, target });
    await save(path.join(dir, 'health', `${rows.length}.json`), rows.at(-1));
    ready =
      health.httpStatus === 200 &&
      target.ok &&
      target.data.connectionGeneration > baseline.data.connectionGeneration &&
      target.data.ready &&
      target.data.predecessorFenced &&
      target.data.freshEmpty;
    if (ready) break;
    if (Date.parse(io.now()) - start > p.bounds.observationMs)
      throw Error('Deployment readiness timeout; no Worker admission');
    await io.sleep(p.bounds.pollMs);
  }
  const diagnostic = await client.call('diagnostics.app', {}),
    workspace = await client.call('workspace.read', { workspaceId: p.workspaceId }),
    target = await client.call('nanohost.runtime-target', {});
  if (
    !diagnostic.ok ||
    !workspace.ok ||
    !diagnostic.data.boot.acceptingProductWork ||
    Object.values(diagnostic.data.boot.subsystems).some((s) =>
      s.reasons.some((r) => r.blocks === true || (Array.isArray(r.blocks) && r.blocks.length > 0))
    )
  )
    throw Error('Deployment public readiness refused');
  result.startup.ready = ready;
  result.components = await readJson(path.join(dir, 'component-attribution.json'));
  if (!result.components.worker.unchanged) {
    result.workerUpdate = {};
    await updateWorker(client, build, result);
  }
  // Browser automation uses a named isolated session and fixed public entry only.
  await guard(p, dir, io);
  const commands = [],
    session = `release-${p.roundId}`;
  try {
    for (const args of [
      ['open', new URL('/settings', p.cli.origin).href],
      ['wait', '--text', 'Sign in'],
      ['snapshot'],
    ]) {
      const r = await io.exec('agent-browser', ['--session', session, ...args], {
        timeout: p.bounds.processMs,
        env: cleanEnvironment(),
      });
      commands.push({ arguments: args, ...r });
      if (r.exitCode !== 0) throw Error('Rendered Web entry unavailable');
    }
  } finally {
    const r = await io.exec('agent-browser', ['--session', session, 'close'], { timeout: 20000 });
    commands.push({ arguments: ['close'], ...r });
  }
  return Object.assign(result, {
    build,
    replace,
    startup: { rows, ready },
    rendered: { commands },
    baselineGeneration: baseline.data.connectionGeneration,
    configurationDigest: replace.configurationDigest,
    public: {
      diagnostics: diagnostic,
      'workspace-retained': workspace,
      'target-1': target,
      binding,
      closedAt: io.now(),
      readyBeforeAdmission: true,
    },
  });
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

/** Run the fixed round once; any ambiguous mutation seals the round for inspection. */
export async function round(dir, seams = {}) {
  const { p, receipt } = await pinned(dir),
    io = { ...defaults, ...seams };
  const preparation = await readJson(path.join(dir, 'prepare-complete.json')),
    preflight = await readJson(path.join(dir, 'preflight-receipt.json'));
  if (preparation.runnerSha256 !== receipt.runnerSha256 || preflight.passed !== true)
    throw Error('Preparation incomplete; no round effects admitted');
  await save(path.join(dir, 'round-start.json'), { start: io.now() });
  const secret = seams.credential ?? (await credential(p.cli.credentialFile)),
    client = new RoundClient(p, dir, io, [secret]);
  const archive = await readJson(path.join(dir, 'archive.json')),
    bundle = {
      attribution: {
        ...receipt,
        archiveSha256: archive.sha256,
        configurationDigest: p.deployment.configurationDigest,
        start: io.now(),
      },
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
  const independent = async (name, effect) => {
    try {
      await effect();
    } catch (e) {
      if (e instanceof InspectionRequired) throw e;
      bundle[name] ??= {};
      bundle[name].observationFailure = { error: String(e), at: io.now() };
    }
    await persist();
  };
  try {
    bundle.deployment = {};
    await deploy(client, archive, bundle.deployment);
    await persist();
    client.phase = 'runtime';
    for (const runtime of RUNTIMES) {
      await independent('runtimes', async () => {
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
      });
    }
    await independent('chat', async () => {
      client.phase = 'chat';
      const chatThread = await create(client, 'chat assistant');
      bundle.chat = { threadId: typeof chatThread === 'string' ? chatThread : undefined };
      if (typeof chatThread === 'string') {
        bundle.chat.input = {
          workspaceId: p.workspaceId,
          threadId: chatThread,
          targetRef: 'internal-role:assistant',
          requestId: randomUUID(),
          artifactRefs: [],
          input: 'What is 19 plus 23? Explain it in one short sentence.',
        };
        bundle.chat.submission = await client.call('conversation.submit', bundle.chat.input, true);
        bundle.chat.evidence = await client.observe(chatThread);
      } else bundle.chat.submission = chatThread;
      await persist();
    });
    await independent('task', async () => {
      client.phase = 'task';
      const taskThread = await create(client, 'task');
      bundle.task = { threadId: typeof taskThread === 'string' ? taskThread : undefined };
      if (typeof taskThread === 'string') {
        const before = await client.call('thread.dashboard', {
          workspaceId: p.workspaceId,
          threadId: taskThread,
        });
        if (!before.ok || before.data.workStatus.selectedAgentId !== p.task.agentId)
          throw Error('Task selected Agent mismatch');
        bundle.task.input = {
          workspaceId: p.workspaceId,
          threadId: taskThread,
          requestId: randomUUID(),
          workerStorageChoice: { kind: 'fresh' },
          input: `Make the focused fix for issue ${p.task.issue} in ${p.task.repository}. Read it through Gateway GitHub tools, preserve accepted design, use base ${p.task.base} and exact branch ${p.task.branch}, and open one pull request into ${p.task.base}. Only exact branch creation, pushes to that branch and that pull request are authorized through individually inspected approvals. Never merge, close a pull request, write the base branch or another repository, or retry an external write. Report actual changed files and validation.`,
        };
        bundle.task.submission = await client.call('task.start', bundle.task.input, true);
        bundle.task.last = await client.observe(taskThread);
        bundle.task.decisions = await decisions(dir, 'task');
        if (
          bundle.task.submission.ok &&
          bundle.task.last.turnReads.length &&
          bundle.task.last.turnReads.every((v) => terminal.has(v.data?.status))
        ) {
          const before = await client.call('thread.dashboard', {
              workspaceId: p.workspaceId,
              threadId: taskThread,
            }),
            replay = await client.call('task.start', bundle.task.input, true, { replay: true }),
            after = await client.call('thread.dashboard', {
              workspaceId: p.workspaceId,
              threadId: taskThread,
            });
          bundle.task.replay = { input: bundle.task.input, before, replay, after };
        }
        bundle.task.github = await githubTask(client);
      } else bundle.task.submission = taskThread;
      await persist();
    });
    await independent('goal', async () => {
      client.phase = 'goal';
      bundle.goal = {
        input: { workspaceId: p.workspaceId, requestId: randomUUID(), intent: p.goal.intent },
      };
      bundle.goal.creation = await client.call('goal.create', bundle.goal.input, true);
      if (bundle.goal.creation.ok) {
        const g = bundle.goal.creation.data.goal;
        bundle.goal.goalId = g.goalId;
        bundle.goal.threadId = g.threadId;
        await client.own(g.threadId);
        bundle.goal.threadNaming = await client.call(
          'thread.update',
          {
            workspaceId: p.workspaceId,
            threadId: g.threadId,
            name: `${p.roundId} goal coordinator`,
            requestId: randomUUID(),
          },
          true
        );
        bundle.goal.evidence = await client.observe(g.threadId, { goalId: g.goalId });
        bundle.goal.lastGoal = bundle.goal.evidence.goal;
        const ds = await decisions(dir, 'goal'),
          plan = ds.find((v) => v.pendingRequest.operation === 'goal.plan.approve'),
          completion = ds.find((v) => v.pendingRequest.operation === 'goal.completion.accept');
        if (plan) {
          const v = plan.before.data.versions.find(
            (v) => v.planVersionId === plan.pendingRequest.exactIntent.planVersionId
          );
          bundle.goal.planDecision = {
            ...plan,
            exactPlan: v,
            exactPendingRequest: plan.pendingRequest,
          };
        }
        if (completion)
          bundle.goal.completionDecision = { ...completion, request: completion.pendingRequest };
        for (const task of bundle.goal.lastGoal?.data?.tasks ?? []) {
          await client.own(task.threadId);
          bundle.goal.linkedTask = await client.observe(task.threadId);
        }
      }
      await persist();
    });
    let external;
    await independent('external', async () => {
      client.phase = 'task';
      external = await externalClient(p, dir, io, false, secret);
      const preflight = await readJson(path.join(dir, 'preflight-receipt.json'));
      bundle.external = { ...external, preflight };
      if (bundle.task.threadId) {
        const dashboard = await client.call('thread.dashboard', {
            workspaceId: p.workspaceId,
            threadId: bundle.task.threadId,
          }),
          latest = dashboard.data?.turns.filter((t) => t.status === 'completed').at(-1)?.id;
        if (latest) {
          const turn = await client.call('turn.read', {
              workspaceId: p.workspaceId,
              threadId: bundle.task.threadId,
              turnId: latest,
            }),
            items = await client.page('thread.items', {
              workspaceId: p.workspaceId,
              threadId: bundle.task.threadId,
            }),
            thread = await client.call('thread.read', {
              workspaceId: p.workspaceId,
              threadId: bundle.task.threadId,
            });
          bundle.external.independent = {
            dashboard,
            turnReads: [turn],
            items,
            thread,
            latestTurnId: latest,
          };
        }
      }
      try {
        bundle.external.judgment = await readJson(p.external.judgeFile);
        await save(path.join(dir, 'external-judgment.json'), bundle.external.judgment, [secret]);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        bundle.external.judgmentUnavailable =
          'Independent deciding-fact judgment must be retained before classification';
      }
    });
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
      external: telemetry(
        (external?.transcript ?? []).map((v) => ({
          startedAt: v.startedAt,
          observedAt: v.observedAt,
          status: v.httpStatus,
          connectionReset: v.connectionReset ?? false,
        })),
        external?.transcript?.length ? 'actual external MCP requests' : 'unavailable'
      ),
      health: telemetry(
        bundle.deployment.startup.rows.map((v) => ({
          startedAt: v.health.at,
          status: v.health.httpStatus,
          connectionReset: v.health.connectionReset ?? false,
        })),
        'sampled health requests; unsampled time unavailable'
      ),
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
      retained:
        'Scenario Threads, Artifacts, open pull request and Goal remain; no unrelated cleanup performed',
    };
  } catch (e) {
    if (e instanceof DeploymentRefused) {
      try {
        const posture = await remote(
          p,
          dir,
          io,
          'cleanup',
          {},
          hostCommon +
            "\nold=inspect(d['container']);print(json.dumps({'running':old['State']['Running'],'container':old['Id']}))\n"
        );
        bundle.cleanup = {
          observed: true,
          posture,
          roundOwnedThreads: [...client.owned],
          retained:
            'Maintenance and administration receipts retained; dependent scenarios not submitted',
        };
      } catch (error) {
        bundle.cleanup.error = String(error);
      }
    }
    bundle.stop = {
      status:
        e instanceof InspectionRequired
          ? 'inspection-required'
          : e instanceof DeploymentRefused
            ? 'failed-deployment'
            : 'failed-or-incomplete',
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
if (process.env.RELEASE_ROUND_BRIDGE && process.argv[1] === here) {
  await bridge(process.env.RELEASE_ROUND_BRIDGE, process.env.RELEASE_ROUND_BRIDGE_PHASE);
}

// openkit-test-platform: posix
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import type {
  WorkerResidentAdapter,
  WorkerResidentOpenInput,
  WorkerResidentSession,
  WorkerResidentTurn,
  WorkerResidentTurnInput,
} from '../adapter-registry.js';
import { createCodexResidentAdapter } from './codex.js';
import { deepseekResidentAdapter } from './deepseek.js';
import { opencodeAdapter } from './opencode.js';
import { createPiResidentAdapter } from './pi.js';

/** Local inference gate: all requests must be live before any can complete. */
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Synthetic credential with the production session-credential grammar. */
function credential(name: string): string {
  return createHash('sha256').update(name).digest('base64url');
}

/** Samples only native descendants' RSS and command names, never credential-bearing argv. */
function nativeResourceSample() {
  const rows = execFileSync('ps', ['-axo', 'pid,ppid,rss,comm'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [pid, parent, rss, ...name] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        parent: Number(parent),
        rssKiB: Number(rss),
        name: name.join(' '),
      };
    });
  const descendants = new Set([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (descendants.has(row.parent) && row.name !== 'ps' && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        grew = true;
      }
    }
  }
  const native = rows.filter((row) => row.pid !== process.pid && descendants.has(row.pid));
  return { processes: native.length, rssKiB: native.reduce((sum, row) => sum + row.rssKiB, 0) };
}

/** Resolves the installed pin without using an image-only absolute executable path. */
function codexAdapter(): WorkerResidentAdapter {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('@openai/codex/package.json');
  const vendor = createRequire(pkg).resolve(
    `@openai/codex-${process.platform}-${process.arch}/package.json`
  );
  const triple =
    process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
  return createCodexResidentAdapter({
    binaryPath: join(dirname(vendor), 'vendor', triple, 'bin', 'codex'),
  });
}

it.each([
  'codex',
  'pi',
  'opencode',
  'deepseek',
] as const)('probes independent concurrent native sessions for %s without provider credentials', async (family) => {
  const root = await mkdtemp(join(tmpdir(), `openkit-concurrency-${family}-`));
  const imageHome = join(root, 'image-home');
  const sharedWork = join(root, 'workspace');
  await Promise.all([mkdir(imageHome), mkdir(sharedWork)]);
  vi.stubEnv('HOME', imageHome);
  const sessions: WorkerResidentSession[] = [];
  const openInputs: WorkerResidentOpenInput[] = [];
  const turns: WorkerResidentTurn[] = [];
  const names = Array.from({ length: 20 }, (_, index) => String.fromCharCode(97 + index));
  const entered = names.map(() => gate());
  const release = names.map(() => gate());
  const requests: Array<{
    authorization: string | undefined;
    model: string;
    body: string;
    auxiliary: boolean;
  }> = [];
  const responses = new Set<ServerResponse>();
  const heldResponses = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    responses.add(res);
    res.on('close', () => responses.delete(res));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body = JSON.parse(text) as {
      model: string;
      messages?: Array<{ role: string; content: unknown }>;
    };
    // The pin generates a title separately; that is not the admitted coding inference.
    const firstMessage = body.messages?.[0];
    const auxiliary =
      family === 'opencode' &&
      firstMessage?.role === 'system' &&
      typeof firstMessage.content === 'string' &&
      firstMessage.content.startsWith(
        'You are a title generator. You output ONLY a thread title. Nothing else.'
      );
    const index = names.indexOf(body.model.slice('model-'.length));
    if (index < 0) throw new Error('Unexpected native probe model.');
    requests.push({
      authorization: req.headers.authorization,
      model: body.model,
      body: text,
      auxiliary,
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    if (!auxiliary) {
      heldResponses.add(res);
      // Hold output, not headers; native startup must not manufacture a provider timeout.
      const heartbeat = setInterval(() => {
        res.write(': probe-wait\n\n');
      }, 1_000);
      res.on('close', () => {
        clearInterval(heartbeat);
        heldResponses.delete(res);
      });
      entered[index]!.resolve();
      await release[index]!.promise;
      clearInterval(heartbeat);
    }
    if (res.destroyed) return;
    if (family === 'codex') {
      const item = {
        id: `message-${index}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: `answer-${index}`, annotations: [] }],
      };
      const events = [
        {
          type: 'response.created',
          response: { id: `response-${index}`, status: 'in_progress', output: [] },
        },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: { id: `response-${index}`, status: 'completed', output: [item] },
        },
      ];
      res.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      );
    } else {
      const base = {
        id: `response-${index}`,
        created: 1,
        model: body.model,
        object: 'chat.completion.chunk',
      };
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: auxiliary ? 'Synthetic title' : `answer-${index}` } }] })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      );
      res.end('data: [DONE]\n\n');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing probe listener.');
  const adapters: Record<string, WorkerResidentAdapter> = {
    codex: codexAdapter(),
    pi: createPiResidentAdapter({
      hostCommand: [
        process.execPath,
        '--no-warnings',
        fileURLToPath(
          new URL('../../../pi-runtime-host/src/bin/openkit-pi-runtime-host.ts', import.meta.url)
        ),
      ],
    }),
    opencode: opencodeAdapter,
    deepseek: deepseekResidentAdapter,
  };
  try {
    const inputs: WorkerResidentTurnInput[] = [];
    for (const [index, name] of names.entries()) {
      const base = join(root, name);
      const state = join(base, 'state');
      const control = join(base, 'control');
      const work = sharedWork;
      const home = join(base, 'home');
      await Promise.all(
        [state, control, work, home].map((path) => mkdir(path, { recursive: true }))
      );
      const openInput: WorkerResidentOpenInput = {
        agentSessionId: `session-${name}`,
        stateRoot: state,
        controlRoot: control,
        environment: {
          HOME: home,
          PATH: process.env.PATH ?? '',
          TMPDIR: home,
          GIT_ALLOW_PROTOCOL: 'file',
        },
        resumeReference: null,
        loopback: {
          inferenceBaseUrl: `http://127.0.0.1:${address.port}/inference/v1`,
          inferenceCredential: credential(`inference-${name}`),
          capabilityBaseUrl: 'http://127.0.0.1:9',
          capabilityCredential: credential(`capability-${name}`),
        },
      };
      openInputs.push(openInput);
      const session = await adapters[family]!.openSession(openInput);
      sessions.push(session);
      const route = {
        id: `route-${name}`,
        model: `model-${name}`,
        providerInstanceId: `provider-${name}`,
        credentialVisibility: 'placeholder' as const,
        endpoint: {
          kind: 'openai-compatible' as const,
          upstream: { kind: 'nanocore-gateway' as const },
        },
        modelParameters: {
          contextWindow: 32768,
          maxOutputTokens: 4096,
          inputModalities: ['text' as const],
          reasoning: false,
        },
      };
      inputs.push({
        turnId: `turn-${name}`,
        turnInput: `private-prompt-${name}`,
        workingDirectory: work,
        turnDirectory: join(base, 'turn'),
        llmRoute: route,
        allowedLlmRoutes: [route],
        mcpServerIds: [],
        skillTargetPaths: [],
        runtimeCapture: {
          captureCoverage: { scope: 'task', value: 'off' },
          credentialValues: [credential(`inference-${name}`), credential(`capability-${name}`)],
          packageSnapshotId: `package-${index}`,
          emit: async () => undefined,
        },
      });
    }
    expect(inputs.every((input) => input.workingDirectory === sharedWork)).toBe(true);
    const started = await Promise.allSettled(
      sessions.map(async (session, index) => {
        const turn = await session.startTurn(inputs[index]!);
        turns.push(turn);
        return turn;
      })
    );
    const handles = started.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    await Promise.all(entered.map((entry) => entry.promise));
    expect(requests.filter((request) => !request.auxiliary)).toHaveLength(names.length);
    expect(heldResponses.size).toBe(names.length);
    for (const request of requests) {
      const name = request.model.slice('model-'.length);
      expect(request.authorization).toBe(`Bearer ${credential(`inference-${name}`)}`);
      expect(request.body).toContain(`private-prompt-${name}`);
      for (const sibling of names.filter((entry) => entry !== name))
        expect(request.body).not.toContain(`private-prompt-${sibling}`);
    }
    const resources = nativeResourceSample();
    await handles[0]!.interrupt();
    expect((await handles[0]!.settled).status).toBe('interrupted');
    const settled = new Set<number>();
    handles.slice(1).forEach((handle, index) => {
      void handle.settled.then(() => {
        settled.add(index + 1);
      });
    });
    await Promise.resolve();
    expect(settled.size).toBe(0);
    for (const session of sessions.slice(1)) expect(session.childState()).toBe('running');
    for (const entry of release.slice(1)) entry.resolve();
    for (const [index, handle] of handles.entries()) {
      if (index > 0)
        expect(await handle.settled).toMatchObject({
          status: 'completed',
          assistantText: `answer-${index}`,
        });
    }
    await Promise.all(sessions.slice(1).map((session) => session.close()));
    for (const session of sessions.slice(1)) expect(session.childState()).toBe('absent');
    // A clean retaining close is a separate proof from independent native interruption.
    const retainedHandle = family === 'codex' ? await sessions[0]!.nativeHandle() : undefined;
    await expect(sessions[0]!.close()).resolves.toBeUndefined();
    expect(sessions[0]!.nativeEvidence?.().persistencePreservingClose).toBe(true);
    if (family === 'codex') {
      if (retainedHandle?.state !== 'ready')
        throw new Error('Interrupted Codex handle was not proved.');
      const controlRoot = join(root, 'successor-control');
      await mkdir(controlRoot);
      release[0]!.resolve();
      const successorCredential = credential('inference-a-successor');
      const successor = await adapters.codex!.openSession({
        ...openInputs[0]!,
        agentSessionId: 'session-a-successor',
        controlRoot,
        resumeReference: retainedHandle.reference,
        loopback: {
          ...openInputs[0]!.loopback,
          inferenceCredential: successorCredential,
          capabilityCredential: credential('capability-a-successor'),
        },
      });
      sessions.push(successor);
      expect(await successor.nativeHandle()).toMatchObject({
        state: 'ready',
        reference: retainedHandle.reference,
      });
      const resumed = await successor.startTurn({
        ...inputs[0]!,
        turnId: 'successor-turn',
        turnInput: 'private-follow-up-a',
        turnDirectory: join(root, 'successor-turn'),
      });
      turns.push(resumed);
      expect(await resumed.settled).toMatchObject({
        status: 'completed',
        assistantText: 'answer-0',
      });
      expect(requests.at(-1)?.authorization).toBe(`Bearer ${successorCredential}`);
      expect(requests.at(-1)?.body).toContain('private-prompt-a');
      expect(requests.at(-1)?.body).toContain('private-follow-up-a');
      await expect(successor.close()).resolves.toBeUndefined();
      expect(successor.nativeEvidence?.().persistencePreservingClose).toBe(true);
    }
    // Report native-created filenames, not bytes or argv, from one completed synthetic binding.
    const inventoryRoot = join(root, names[1]!);
    const nativeFiles = (await readdir(inventoryRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => !entry.isDirectory())
      .map((entry) => relative(inventoryRoot, join(entry.parentPath, entry.name)))
      .sort();
    process.stdout.write(
      `${JSON.stringify({ family, nativeFiles, concurrentInference: true, independentInterruption: true, siblingClose: 'clean', interruptedClose: 'clean', interruptedChild: sessions[0]!.childState(), interruptedNativeEvidence: sessions[0]!.nativeEvidence?.(), simultaneousBindings: names.length, sharedWorkingDirectory: true, auxiliaryInferenceRequests: requests.filter((request) => request.auxiliary).length, nativeProcesses: resources.processes, nativeRssKiB: resources.rssKiB, nativeRssMiBPerBinding: Math.round(resources.rssKiB / names.length / 1024) })}\n`
    );
  } finally {
    for (const entry of release) entry.resolve();
    await Promise.all(turns.map((turn) => turn.interrupt().catch(() => undefined)));
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
    for (const response of responses) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(root, { force: true, recursive: true });
  }
}, 120_000);

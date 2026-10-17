// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { type WorkerCanonicalEventRecord, workerTurnCapturePaths } from '@openkit/worker-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerHarness } from '../harness.js';
import type { SandboxIntegrationClient } from '../integration-client.js';
import { createPiResidentAdapter } from './pi.js';
import { createPiLineReader, parsePiHostFrame } from './pi-channel.js';

const HOST_BIN = fileURLToPath(
  new URL('../../../pi-runtime-host/src/bin/openkit-pi-runtime-host.ts', import.meta.url)
);
const TIMEOUT = 120_000;
const SCRATCH = '/tmp/openkit-bootstrap';
const DIGEST = 'a'.repeat(64);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function credential(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url');
}

/** Records the actual Integration calls for fixture observation. No listener is bound. */
function fakeIntegration(
  finalStatuses: unknown[],
  observeControl?: (url: string, body: unknown) => void
): SandboxIntegrationClient {
  const loopbacks = new Set<string>();
  return {
    ready: Promise.resolve(),
    registerSessionLoopback(agentSessionId: string) {
      if (loopbacks.has(agentSessionId)) throw new Error('loopback conflict');
      loopbacks.add(agentSessionId);
    },
    destroySessionLoopback(agentSessionId: string) {
      loopbacks.delete(agentSessionId);
    },
    bindTurnRouteTokens() {
      return undefined;
    },
    clearTurnRouteTokens() {
      return undefined;
    },
    async drainTurn() {
      return 0;
    },
    workerControlFetch: async (url: string, init: { body: string }) => {
      if (url.endsWith('/final-status')) finalStatuses.push(JSON.parse(init.body) as unknown);
      observeControl?.(url, JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accepted: true, diagnostics: [], schemaVersion: 2 }),
      };
    },
  } as unknown as SandboxIntegrationClient;
}

/** Creates the existing Harness with optional passive channel and control observations. */
function harnessFor(
  root: string,
  hostCommand: readonly string[] = [process.execPath, '--no-warnings', HOST_BIN],
  observeChannel?: (channel: Duplex) => void,
  observeControl?: (url: string, body: unknown) => void
) {
  const sandboxRoot = join(root, 'openkit');
  const nativeRoot = join(root, 'sandbox', 'native');
  const finalStatuses: unknown[] = [];
  mkdirSync(sandboxRoot, { recursive: true });
  mkdirSync(nativeRoot, { recursive: true });
  const harness = new WorkerHarness({
    adapters: { pi: createPiResidentAdapter({ hostCommand, observeChannel }) },
    environment: { HOME: join(root, 'home'), PATH: process.env.PATH ?? '' },
    integration: fakeIntegration(finalStatuses, observeControl),
    threadRootDirectory: nativeRoot,
    rootDirectory: join(root, 'private'),
    sandboxRoot,
  });
  let sequence = 0;
  const send = (operation: string, body: Readonly<Record<string, unknown>>) =>
    harness.handle({
      body,
      harnessInstanceId: 'harness-one',
      operation: operation as never,
      operationId: sha256(`${root}:${sequence}:${operation}`),
      schemaVersion: 2,
      sequence: sequence++,
    });
  const selector = (agentSessionId: string) => ({
    agentSessionId,
    agentSessionRuntimeBindingId: `binding-${agentSessionId}`,
  });
  const open = (
    agentSessionId: string,
    resume: { digest: string; locator: string } | null = null,
    threadId = 'th_00000000-0000-730e-88b8-d76794f39a2f'
  ) => {
    const config = join(sandboxRoot, 'sessions', agentSessionId, 'config');
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, 'package.json'),
      JSON.stringify({
        scope: { agentSessionId, threadId, workspaceId: 'ws_00000000-0000-7ac9-b7d9-236a01857edc' },
        workspace: { root: sandboxRoot, inputs: [] },
        extensions: { openkit: { sessionWorkspace: { layout: { slots: [] } } } },
      })
    );
    return send('session.open', {
      ...selector(agentSessionId),
      adapterId: 'pi',
      agentSessionCompatibilityKey: DIGEST,
      capabilityLoopbackCredential: credential(`capability-${agentSessionId}`),
      effectiveSetupGeneration: 1,
      inferenceLoopbackCredential: credential(`inference-${agentSessionId}`),
      resume,
      threadId,
      workspaceId: 'ws_00000000-0000-7ac9-b7d9-236a01857edc',
    });
  };
  return { finalStatuses, nativeRoot, open, sandboxRoot, selector, send };
}

describe('Pi Harness integration', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
  });

  it(
    'runs a real host Turn through the Harness and resumes the same conversation',
    async () => {
      await mkdir(SCRATCH, { recursive: true });
      const root = await realpath(await mkdtemp(join(tmpdir(), 'openkit-pi-harness-')));
      vi.stubEnv('HOME', join(root, 'image-home'));
      roots.push(root);
      mkdirSync(join(root, 'home'), { recursive: true });
      const requests: Array<{ model: string }> = [];
      const turnIds = [
        'tu_00000000-0000-7e49-8268-e35715b55d0c',
        'tu_00000000-0000-7fe3-9c5f-b9c81a62a0b4',
      ];
      // Keep only terminal structure outside the fixture's temporary native files.
      const native: Array<{
        turnId: string;
        type: string;
        stopReason?: string;
        willRetry?: boolean | 'unknown';
        matchesMessage?: boolean;
        matchesSyntheticText?: boolean;
      }> = [];
      const terminalOrder: Array<{
        turnId: string;
        source: 'native' | 'host' | 'canonical';
        status?: string;
        sequence?: number;
        matchesSyntheticText?: boolean;
      }> = [];
      const canonical: WorkerCanonicalEventRecord[] = [];
      let terminalMessage: { turnId: string; message: unknown } | undefined;
      let captureFailure: 'invalid' | 'omitted' | 'overflow' | undefined;
      const proxy = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
          requests.push(body);
          const base = {
            created: 1,
            id: `harness-${requests.length}`,
            model: body.model,
            object: 'chat.completion.chunk',
          };
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [
                { index: 0, delta: { role: 'assistant', content: `answer-${requests.length}` } },
              ],
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
            })}\n\n`
          );
          res.end('data: [DONE]\n\n');
        } catch {
          res.writeHead(502).end();
        }
      });
      await new Promise<void>((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(17892, '127.0.0.1', resolve);
      });
      try {
        const harness = harnessFor(
          root,
          undefined,
          (channel) => {
            const read = createPiLineReader(
              (line) => {
                const frame = parsePiHostFrame(line);
                if (frame.kind === 'invalid' || frame.kind === 'omitted') {
                  captureFailure = frame.kind;
                } else if (frame.kind === 'native') {
                  const event = frame.data as Record<string, unknown>;
                  if (event.type === 'message_end') {
                    const message = event.message as {
                      role?: string;
                      stopReason?: string;
                      content?: Array<{ type: string; text?: string }>;
                    };
                    if (message.role !== 'assistant') return;
                    terminalMessage = { turnId: frame.turnId, message };
                    native.push({
                      turnId: frame.turnId,
                      type: 'message_end',
                      stopReason:
                        ['stop', 'error', 'aborted', 'length'].find(
                          (reason) => reason === message.stopReason
                        ) ?? 'unknown',
                      matchesSyntheticText:
                        message.content
                          ?.filter((part) => part.type === 'text')
                          .map((part) => part.text)
                          .join('') === `answer-${turnIds.indexOf(frame.turnId) + 1}`,
                    });
                  } else if (event.type === 'turn_end' || event.type === 'agent_end') {
                    const message =
                      event.type === 'turn_end'
                        ? event.message
                        : (event.messages as Array<{ role?: string }>).findLast(
                            (candidate) => candidate.role === 'assistant'
                          );
                    native.push({
                      turnId: frame.turnId,
                      type: event.type,
                      matchesMessage:
                        terminalMessage?.turnId === frame.turnId &&
                        isDeepStrictEqual(terminalMessage.message, message),
                      ...(event.type === 'agent_end'
                        ? {
                            willRetry:
                              typeof event.willRetry === 'boolean' ? event.willRetry : 'unknown',
                          }
                        : {}),
                    });
                  } else if (event.type === 'agent_settled') {
                    native.push({ turnId: frame.turnId, type: 'agent_settled' });
                    terminalOrder.push({ turnId: frame.turnId, source: 'native' });
                  }
                } else if (frame.kind === 'settled') {
                  const outcome = frame.settled.outcome as {
                    status?: string;
                    assistantText?: string;
                  };
                  terminalOrder.push({
                    turnId: frame.settled.turnId,
                    source: 'host',
                    status:
                      ['completed', 'failed', 'interrupted', 'length'].find(
                        (status) => status === outcome.status
                      ) ?? 'unknown',
                    matchesSyntheticText:
                      outcome.assistantText ===
                      `answer-${turnIds.indexOf(frame.settled.turnId) + 1}`,
                  });
                }
              },
              () => {
                captureFailure = 'overflow';
              }
            );
            channel.on('data', read);
            channel.once('end', () => read.finish());
          },
          (url, body) => {
            if (url.endsWith('/events/append')) {
              canonical.push((body as { record: WorkerCanonicalEventRecord }).record);
            } else if (url.endsWith('/final-status')) {
              const final = body as { sequence: number; body: { status: string } };
              terminalOrder.push({
                turnId: canonical.at(-1)?.lineage.turnId ?? 'unknown',
                source: 'canonical',
                sequence: final.sequence,
                status:
                  ['completed', 'failed', 'interrupted', 'blocked'].find(
                    (candidate) => candidate === final.body.status
                  ) ?? 'unknown',
              });
            }
          }
        );
        expect((await harness.open('as_00000000-0000-7f03-8682-76a52604a84a')).disposition).toBe(
          'succeeded'
        );
        const run = async (turnId: string, sequence: number) => {
          const config = join(
            harness.sandboxRoot,
            'sessions',
            'as_00000000-0000-7f03-8682-76a52604a84a',
            'config'
          );
          mkdirSync(config, { recursive: true });
          writeFileSync(
            join(config, 'package.json'),
            JSON.stringify({
              capabilities: { mode: 'disabled' },
              control: {
                adapter: { kind: 'openkit-worker-shim', targetRuntime: 'pi' },
                bindings: {
                  capabilities: {
                    pathPrefix: '/capabilities/',
                    tokenRef: 'runtime://openkit/capability-token',
                  },
                  inference: {
                    pathPrefix: '/inference/',
                    tokenRef: 'runtime://openkit/inference-token',
                  },
                  workerControl: {
                    pathPrefix: '/worker-control/',
                    tokenRef: 'runtime://openkit/worker-control-token',
                  },
                },
                mode: 'sandbox-integration',
              },
              credentials: { declarations: [] },
              extensions: { openkit: { turnInput: `input for ${turnId}` } },
              llm: {
                mode: 'gateway',
                preferredLogicalModelId: 'model-a',
                routes: [
                  {
                    credentialVisibility: 'placeholder',
                    endpoint: { kind: 'openai-compatible', upstream: { kind: 'nanocore-gateway' } },
                    id: 'worker-inference',
                    model: 'model-a',
                    providerInstanceId: 'provider-a',
                    modelParameters: {
                      contextWindow: 32000,
                      maxOutputTokens: 4000,
                      inputModalities: ['text'],
                      reasoning: false,
                    },
                  },
                ],
              },
              observability: { captureCoverage: { scope: 'server', value: 'on' } },
              runtime: {
                command: { argv: ['openkit-worker-shim'], workingDirectory: harness.sandboxRoot },
              },
              scope: {
                agentSessionId: 'as_00000000-0000-7f03-8682-76a52604a84a',
                threadId: 'th_00000000-0000-730e-88b8-d76794f39a2f',
                turnId,
                workspaceId: 'ws_00000000-0000-7ac9-b7d9-236a01857edc',
              },
              snapshotId: `package-${turnId}`,
              supply: { mcpServers: [] },
            })
          );
          return harness.send('turn.start', {
            ...harness.selector('as_00000000-0000-7f03-8682-76a52604a84a'),
            aepRef: join(config, 'package.json'),
            capabilityToken: credential(`capability-token-${turnId}`),
            contextPackageId: `ctxpkg_${turnId}`,
            contextRef: join(
              harness.sandboxRoot,
              'sessions',
              'as_00000000-0000-7f03-8682-76a52604a84a',
              'context'
            ),
            deadline: '2099-01-01T00:00:00.000Z',
            inferenceToken: credential(`inference-token-${turnId}`),
            leaseId: `lease-${turnId}`,
            packageSnapshotId: `package-${turnId}`,
            threadId: 'th_00000000-0000-730e-88b8-d76794f39a2f',
            turnId,
            turnSequence: sequence,
            workerControlToken: credential(`control-token-${turnId}`),
            workspaceId: 'ws_00000000-0000-7ac9-b7d9-236a01857edc',
          });
        };
        const first = await run(turnIds[0]!, 0);
        expect(first, JSON.stringify(first)).toMatchObject({ disposition: 'succeeded' });
        await vi.waitFor(() => expect(harness.finalStatuses).toHaveLength(1), {
          interval: 20,
          timeout: 20_000,
        });
        expect(harness.finalStatuses[0]).toMatchObject({ body: { status: 'completed' } });
        await vi.waitFor(
          async () => {
            const observed = await harness.send(
              'session.inspect',
              harness.selector('as_00000000-0000-7f03-8682-76a52604a84a')
            );
            expect(
              observed,
              `${JSON.stringify(observed)} requests=${requests.length}`
            ).toMatchObject({ body: { nativeHandleState: 'ready', state: 'open' } });
          },
          { interval: 20, timeout: 10_000 }
        );
        const second = await run(turnIds[1]!, 1);
        expect(second, JSON.stringify(second)).toMatchObject({ disposition: 'succeeded' });
        await vi.waitFor(() => expect(harness.finalStatuses).toHaveLength(2), {
          interval: 20,
          timeout: 20_000,
        });
        expect(harness.finalStatuses[1]).toMatchObject({ body: { status: 'completed' } });
        await vi.waitFor(() => expect(requests).toHaveLength(2), {
          interval: 20,
          timeout: 10_000,
        });
        await vi.waitFor(
          async () => {
            const observed = await harness.send(
              'session.inspect',
              harness.selector('as_00000000-0000-7f03-8682-76a52604a84a')
            );
            expect(observed.body.state).toBe('open');
          },
          { interval: 20, timeout: 10_000 }
        );
        expect(
          await harness.send(
            'session.close',
            harness.selector('as_00000000-0000-7f03-8682-76a52604a84a')
          )
        ).toMatchObject({
          disposition: 'succeeded',
        });
        expect(captureFailure).toBeUndefined();
        for (const [index, turnId] of turnIds.entries()) {
          expect(native.filter((event) => event.turnId === turnId)).toEqual([
            { turnId, type: 'message_end', stopReason: 'stop', matchesSyntheticText: true },
            { turnId, type: 'turn_end', matchesMessage: true },
            { turnId, type: 'agent_end', matchesMessage: true, willRetry: false },
            { turnId, type: 'agent_settled' },
          ]);
          const records = canonical.filter((record) => record.lineage.turnId === turnId);
          const paths = workerTurnCapturePaths(
            'th_00000000-0000-730e-88b8-d76794f39a2f',
            'pi',
            turnId
          );
          const retained = readFileSync(
            join(harness.nativeRoot, relative('/openkit/threads', paths.root), 'events.jsonl'),
            'utf8'
          )
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as WorkerCanonicalEventRecord);
          const terminal = retained.at(-1)!;
          expect(terminal.lineage.turnId).toBe(turnId);
          expect(terminal.event.type).toBe('turn.completed');
          expect(terminalOrder.filter((event) => event.turnId === turnId)).toEqual([
            { turnId, source: 'native' },
            { turnId, source: 'host', status: 'completed', matchesSyntheticText: true },
            { turnId, source: 'canonical', status: 'completed', sequence: terminal.sequence },
          ]);
          const final = harness.finalStatuses[index] as {
            schemaVersion: number;
            sequence: number;
            body: unknown;
          };
          expect(final.schemaVersion).toBe(2);
          expect(final.sequence).toBe(terminal.sequence);
          expect(isDeepStrictEqual(final.body, terminal.event.data)).toBe(true);
          expect(records.every((record) => record.schemaVersion === 1)).toBe(true);
          expect(records.some((record) => record.event.type === 'observation.recorded')).toBe(true);
          const content = records.filter(
            (record) => record.event.type === 'observation.content.chunk'
          );
          expect(content).toHaveLength(1);
          const chunk = content[0]!.event;
          expect(
            chunk.type === 'observation.content.chunk' &&
              Buffer.from(chunk.data.data, 'base64').toString() === `answer-${index + 1}`
          ).toBe(true);
        }
      } finally {
        process.stdout.write(
          JSON.stringify({
            issue: 130,
            scope: 'two synthetic loopback Turns in one real Pi SDK host and Harness',
            version:
              'pi-coding-agent 1.0.2 with workspace patch; worker protocol 2; canonical events 1',
            retention: 'temporary fixture only; external log contains structural metadata',
            redaction: 'no frames, reasoning, handles, paths, credentials or request content',
            native: native.map(({ turnId, ...event }) => ({
              turn: turnIds.indexOf(turnId),
              ...event,
            })),
            terminalOrder: terminalOrder.map(({ turnId, ...event }) => ({
              turn: turnIds.indexOf(turnId),
              ...event,
            })),
            captureFailure: captureFailure ?? null,
            incident: native.some((event) => event.stopReason === 'aborted')
              ? 'INCONCLUSIVE: native abort observed; inspect the correlated terminal sequence'
              : 'INCONCLUSIVE: self-stop not reproduced in the observed sequence',
          }) + '\n'
        );
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    },
    TIMEOUT
  );

  it(
    'opens a pending host, drains, and closes without creating a session file',
    async () => {
      await mkdir(SCRATCH, { recursive: true });
      const root = await realpath(await mkdtemp(join(tmpdir(), 'openkit-pi-harness-')));
      vi.stubEnv('HOME', join(root, 'image-home'));
      roots.push(root);
      mkdirSync(join(root, 'home'), { recursive: true });
      const harness = harnessFor(root);
      const opened = await harness.open('as_00000000-0000-7f03-8682-76a52604a84a');
      expect(opened).toMatchObject({
        body: { nativeHandleDigest: null, nativeHandleState: 'pending', state: 'open' },
        disposition: 'succeeded',
      });
      const stateRoot = join(
        harness.nativeRoot,
        'th_00000000-0000-730e-88b8-d76794f39a2f',
        'pi',
        'native'
      );
      expect(existsSync(join(stateRoot, 'sessions'))).toBe(false);
      const inspected = await harness.send(
        'session.inspect',
        harness.selector('as_00000000-0000-7f03-8682-76a52604a84a')
      );
      expect(inspected).toMatchObject({
        body: { childState: 'running', nativeHandleState: 'pending', state: 'open' },
        disposition: 'succeeded',
      });
      const planted = join(stateRoot, 'planted.txt');
      writeFileSync(planted, 'keep');
      expect(await harness.send('harness.drain', {})).toMatchObject({
        body: { state: 'draining' },
        disposition: 'succeeded',
      });
      expect(
        await harness.open(
          'as_00000000-0000-7ccb-a600-607d092dffc8',
          null,
          'th_00000000-0000-779e-b7fd-63d275d430ba'
        )
      ).toMatchObject({
        body: { reasonCode: 'busy' },
        disposition: 'refused',
      });
      expect(
        await harness.send('turn.start', {
          ...harness.selector('as_00000000-0000-7f03-8682-76a52604a84a'),
          aepRef: join(
            harness.sandboxRoot,
            'sessions',
            'as_00000000-0000-7f03-8682-76a52604a84a',
            'config',
            'package.json'
          ),
          capabilityToken: credential('capability-token'),
          contextPackageId: 'ctxpkg_turn-1',
          contextRef: join(
            harness.sandboxRoot,
            'sessions',
            'as_00000000-0000-7f03-8682-76a52604a84a',
            'context'
          ),
          deadline: '2099-01-01T00:00:00.000Z',
          inferenceToken: credential('inference-token'),
          leaseId: 'lease-turn-1',
          packageSnapshotId: 'package-turn-1',
          threadId: 'th_00000000-0000-730e-88b8-d76794f39a2f',
          turnId: 'tu_00000000-0000-7e49-8268-e35715b55d0c',
          turnSequence: 0,
          workerControlToken: credential('control-token'),
          workspaceId: 'ws_00000000-0000-7ac9-b7d9-236a01857edc',
        })
      ).toMatchObject({ body: { reasonCode: 'busy' }, disposition: 'refused' });
      expect(
        await harness.send(
          'session.close',
          harness.selector('as_00000000-0000-7f03-8682-76a52604a84a')
        )
      ).toMatchObject({
        body: { childState: 'absent', state: 'closed' },
        disposition: 'succeeded',
      });
      expect(readFileSync(planted, 'utf8')).toBe('keep');
    },
    TIMEOUT
  );

  it(
    'resumes a proved header and refuses a different conversation before spawn',
    async () => {
      await mkdir(SCRATCH, { recursive: true });
      const root = await realpath(await mkdtemp(join(tmpdir(), 'openkit-pi-harness-')));
      vi.stubEnv('HOME', join(root, 'image-home'));
      roots.push(root);
      mkdirSync(join(root, 'home'), { recursive: true });
      const marker = join(root, 'spawned');
      const bad = harnessFor(root, [
        process.execPath,
        '--eval',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1')`,
      ]);
      const stateRoot = join(
        bad.nativeRoot,
        'th_00000000-0000-730e-88b8-d76794f39a2f',
        'pi',
        'native'
      );
      const sessionPath = join(stateRoot, 'sessions', 'binding-proof', 'session.jsonl');
      const work = join(root, 'work');
      await mkdir(dirname(sessionPath), { recursive: true });
      await mkdir(work, { recursive: true });
      const headerId = 'sess-real';
      await mkdir(dirname(sessionPath), { recursive: true });
      writeFileSync(
        sessionPath,
        `${JSON.stringify({ cwd: work, id: 'sess-other', type: 'session' })}\n`
      );
      const handle = JSON.stringify({ cwd: work, path: sessionPath, sessionId: headerId });
      const predecessor = 'as_00000000-0000-78d8-b6a0-4df523295b90';
      const referencePath = join(
        bad.nativeRoot,
        'th_00000000-0000-730e-88b8-d76794f39a2f',
        'pi',
        'agent-session-references',
        predecessor
      );
      await mkdir(dirname(referencePath), { recursive: true });
      writeFileSync(referencePath, handle);
      const refused = await bad.open('as_00000000-0000-7f75-8638-e5ca0f7f5a57', {
        digest: sha256(handle),
        locator: predecessor,
      });
      expect(refused).toMatchObject({
        body: { reasonCode: 'dependency_failed' },
        disposition: 'refused',
      });
      expect(existsSync(marker)).toBe(false);
      expect(
        existsSync(
          join(
            bad.nativeRoot,
            'th_00000000-0000-730e-88b8-d76794f39a2f',
            'pi',
            'agent-session-references',
            'as_00000000-0000-7f75-8638-e5ca0f7f5a57'
          )
        )
      ).toBe(false);
      expect(readFileSync(referencePath, 'utf8')).toBe(handle);

      writeFileSync(
        sessionPath,
        `${JSON.stringify({ cwd: work, id: headerId, type: 'session' })}\n`
      );
      const good = harnessFor(root);
      const opened = await good.open('as_00000000-0000-7f7f-8324-3a4064fb19d5', {
        digest: sha256(handle),
        locator: predecessor,
      });
      expect(opened).toMatchObject({
        body: { nativeHandleDigest: sha256(handle), nativeHandleState: 'ready', state: 'open' },
        disposition: 'succeeded',
      });
      expect(
        await good.send('session.inspect', good.selector('as_00000000-0000-7f7f-8324-3a4064fb19d5'))
      ).toMatchObject({
        body: { nativeHandleDigest: sha256(handle), nativeHandleState: 'ready' },
        disposition: 'succeeded',
      });
      expect(
        await good.send('session.close', good.selector('as_00000000-0000-7f7f-8324-3a4064fb19d5'))
      ).toMatchObject({
        body: { childState: 'absent', state: 'closed' },
        disposition: 'succeeded',
      });
      expect(readFileSync(sessionPath, 'utf8')).toContain(headerId);
    },
    TIMEOUT
  );
});

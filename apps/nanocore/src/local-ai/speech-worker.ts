/**
 * Speech child. One transcription at a time, off the NanoCore event loop.
 * ffmpeg on PATH writes 16 kHz mono float32. sherpa-onnx then punctuates.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 2_700_000;
const PRESERVED = ['OpenKit', 'NanoCore', 'Gateway', 'SQLite', 'OAuth', 'MCP', 'PR', 'CI'];

interface SherpaModule {
  OfflineRecognizer: new (
    config: unknown
  ) => {
    createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void };
    decodeAsync(stream: unknown): Promise<{ text?: string }>;
    getResult(stream: unknown): { text?: string };
  };
  OfflinePunctuation: new (config: unknown) => { addPunct(text: string): string };
}

const modelDir = requiredEnv('OPENKIT_SPEECH_MODEL');
const punctDir = requiredEnv('OPENKIT_SPEECH_PUNCT');
const jsDir = requiredEnv('OPENKIT_SPEECH_JS');
const threads = Number(process.env.OPENKIT_SPEECH_THREADS ?? '4');

const modelFile = findFile(modelDir, (name) => name.endsWith('.onnx'));
const tokensFile = findFile(modelDir, (name) => name === 'tokens.txt');
const punctFile = findFile(punctDir, (name) => name.endsWith('.onnx'));

let chain: Promise<unknown> = Promise.resolve();
let recognizer: SherpaModule['OfflineRecognizer'] extends new (
  config: unknown
) => infer T
  ? T
  : never;
let punctuation: { addPunct(text: string): string };

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    if (response.headersSent) return;
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ error: error instanceof Error ? error.message : 'speech failed' })
    );
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address() as AddressInfo;
  process.stdout.write(`OPENKIT_LOCAL_AI_READY ${address.port}\n`);
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/audio/transcriptions') {
    response.writeHead(404);
    response.end();
    return;
  }
  const controller = new AbortController();
  request.on('close', () => {
    if (!response.writableEnded) controller.abort();
  });
  const result = await enqueue(async () => {
    if (controller.signal.aborted) throw new Error('aborted');
    const audio = await readBody(request);
    const pcm = await decodePcm(audio);
    const text = await transcribe(pcm);
    return {
      text,
      duration: pcm.byteLength / Float32Array.BYTES_PER_ELEMENT / 16_000,
    };
  });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(result));
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error('audio body exceeds the cap');
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks);
  const type = request.headers['content-type'] ?? '';
  const boundary =
    /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type)?.[1] ??
    /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type)?.[2];
  if (!boundary) return body;
  return multipartFile(body, boundary);
}

function multipartFile(body: Buffer, boundary: string): Buffer {
  const marker = Buffer.from(`--${boundary}`);
  let offset = body.indexOf(marker);
  while (offset >= 0) {
    const start = offset + marker.length;
    const next = body.indexOf(marker, start);
    const part = body.subarray(start, next < 0 ? body.length : next);
    const split = part.indexOf('\r\n\r\n');
    if (split >= 0) {
      const header = part.subarray(0, split).toString('utf8');
      if (/name="file"/i.test(header)) {
        let file = part.subarray(split + 4);
        if (file.subarray(-2).equals(Buffer.from('\r\n'))) file = file.subarray(0, -2);
        return file;
      }
    }
    offset = next;
  }
  throw new Error('multipart file part is missing');
}

function decodePcm(audio: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-f',
        'f32le',
        '-ac',
        '1',
        '-ar',
        '16000',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.on('error', reject);
    ffmpeg.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code ?? 'null'}`));
    });
    ffmpeg.stdin.end(audio);
  });
}

async function transcribe(pcm: Buffer): Promise<string> {
  const loaded = await loadSherpa();
  const aligned = new ArrayBuffer(pcm.byteLength);
  new Uint8Array(aligned).set(pcm);
  const samples = new Float32Array(aligned);
  const stream = loaded.recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: 16_000 });
  const decoded = await loaded.recognizer.decodeAsync(stream);
  const raw = decoded.text ?? loaded.recognizer.getResult(stream).text ?? '';
  return caseEnglish(loaded.punctuation.addPunct(raw));
}

async function loadSherpa(): Promise<{
  recognizer: typeof recognizer;
  punctuation: typeof punctuation;
}> {
  if (!recognizer) {
    const imported = (await import(pathToFileURL(join(jsDir, 'sherpa-onnx.js')).href)) as {
      default?: SherpaModule;
    } & SherpaModule;
    const api = imported.OfflineRecognizer ? imported : imported.default;
    if (!api) throw new Error('sherpa-onnx-node did not load.');
    recognizer = new api.OfflineRecognizer({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: modelFile,
          language: '',
          useInverseTextNormalization: 1,
        },
        tokens: tokensFile,
        numThreads: threads,
        debug: false,
      },
    });
    punctuation = new api.OfflinePunctuation({
      model: { ctTransformer: punctFile, numThreads: threads, debug: false },
    });
  }
  return { recognizer, punctuation };
}

/** Sentence-cases an all-ASCII-capitals English result and restores known tokens. */
function caseEnglish(text: string): string {
  if ([...text].some((char) => char.charCodeAt(0) > 127)) return text;
  if (!/[A-Z]/.test(text) || /[a-z]/.test(text)) return text;
  let cased = text
    .toLowerCase()
    .replace(
      /(^|[.!?]\s+)([a-z])/g,
      (_match, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`
    );
  for (const token of PRESERVED) {
    cased = cased.replace(new RegExp(`\\b${token}\\b`, 'gi'), token);
  }
  return cased;
}

function findFile(root: string, accept: (name: string) => boolean): string {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (accept(entry.name)) return path;
    }
  }
  throw new Error(`Required speech file is missing under ${root}.`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

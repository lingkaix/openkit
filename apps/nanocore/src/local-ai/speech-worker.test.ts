import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stop(child)));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

it('reports one second for one second of float32 PCM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-speech-worker-'));
  roots.push(root);
  const model = join(root, 'model');
  const punct = join(root, 'punct');
  const js = join(root, 'js');
  const bin = join(root, 'bin');
  for (const directory of [model, punct, js, bin]) mkdirSync(directory);
  // The CI image has no ffmpeg. This process-boundary stand-in emits one second of 16 kHz float32.
  writeFileSync(
    join(bin, 'ffmpeg'),
    `#!${process.execPath}\nprocess.stdin.on('data', () => undefined);\nprocess.stdin.on('end', () => { process.stdout.write(Buffer.alloc(64_000)); process.exit(0); });\n`,
    { mode: 0o755 }
  );
  writeFileSync(join(model, 'model.onnx'), 'fixture');
  writeFileSync(join(model, 'tokens.txt'), 'fixture');
  writeFileSync(join(punct, 'punct.onnx'), 'fixture');
  writeFileSync(
    join(js, 'sherpa-onnx.js'),
    `exports.OfflineRecognizer = class {
      createStream() { return { acceptWaveform() {} }; }
      async decodeAsync() { return { text: 'HELLO OPENKIT' }; }
      getResult() { return { text: 'HELLO OPENKIT' }; }
    };
    exports.OfflinePunctuation = class { addPunct(text) { return text + '.'; } };`
  );
  const worker = spawn(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(new URL('./speech-worker.ts', import.meta.url))],
    {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        OPENKIT_SPEECH_MODEL: model,
        OPENKIT_SPEECH_PUNCT: punct,
        OPENKIT_SPEECH_JS: js,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  children.push(worker);
  let stderr = '';
  worker.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const port = await new Promise<string>((resolve, reject) => {
    worker.stdout?.on('data', (chunk: Buffer) => {
      const match = /READY (\d+)/.exec(chunk.toString('utf8'));
      if (match?.[1]) resolve(match[1]);
    });
    worker.once('exit', () => reject(new Error(`worker exited before ready ${stderr}`)));
  });
  const wav = Buffer.alloc(44 + 32_000);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(32_000, 40);
  const response = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
    method: 'POST',
    body: wav,
  });
  const body = (await response.json()) as { text?: string; duration?: number };
  expect(response.status, stderr).toBe(200);
  expect(body).toEqual({ text: 'Hello OpenKit.', duration: 1 });
});

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

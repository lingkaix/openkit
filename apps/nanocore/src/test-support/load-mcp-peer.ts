/** Owns one private peer process so post-window Core verification cannot starve HTTP cleanup. */
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Starts the existing MCP fixture in its own process and joins its exit on close. */
export async function createLoadMcpPeer(): Promise<{
  url: string;
  pid: number;
  close(): Promise<void>;
}> {
  const compiled = new URL('./load-mcp-peer.child.js', import.meta.url);
  const child = fork(
    existsSync(compiled) ? compiled : new URL('./load-mcp-peer.child.ts', import.meta.url),
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }
  );
  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', (code) => {
      exitCode = code;
      resolve();
    })
  );
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (child.connected) child.send('close');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try {
        await exited;
        if (exitCode !== 0) throw new Error('Load MCP peer exited without clean shutdown.');
      } finally {
        clearTimeout(timer);
      }
    })());
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Load MCP peer did not start.')), 10_000);
      const finish = (error?: Error, url?: string) => {
        clearTimeout(timer);
        child.off('error', failed);
        child.off('exit', failedExit);
        child.off('message', ready);
        if (error) reject(error);
        else resolve(url!);
      };
      const failed = (error: Error) => finish(error);
      const failedExit = () => finish(new Error('Load MCP peer exited before readiness.'));
      const ready = (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'url' in message &&
          typeof message.url === 'string'
        )
          finish(undefined, message.url);
      };
      child.once('error', failed);
      child.once('exit', failedExit);
      child.on('message', ready);
    });
    return { url, pid: child.pid!, close };
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    throw error;
  }
}

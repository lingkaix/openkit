import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

/** The launch-selected files used by both native listener types. */
export interface NativeTlsSource {
  readonly certPath: string;
  readonly keyPath: string;
}

/** Native listener options after the certificate and key have passed startup validation. */
export interface NativeTlsListenOptions {
  readonly cert: Buffer;
  readonly key: Buffer;
}

/** Existing-plan path for same-path TLS material. */
export const LISTENER_TLS_PLAN_PATH = 'server.tlsMaterial';
/** Diagnostics for unreadable material and invalid pairs exclude source paths and bytes. */
export const INVALID_NATIVE_TLS_PAIR = 'The configured NanoCore TLS pair is unreadable or invalid.';

/** Captures the launch selectors once when a listener requires TLS. */
export function readNativeTlsSource(env: {
  readonly OPENKIT_TLS_CERT_FILE?: string;
  readonly OPENKIT_TLS_KEY_FILE?: string;
}): NativeTlsSource {
  const certPath = env.OPENKIT_TLS_CERT_FILE?.trim();
  const keyPath = env.OPENKIT_TLS_KEY_FILE?.trim();
  if (!certPath || !keyPath) {
    throw new Error('A TLS listener requires OPENKIT_TLS_CERT_FILE and OPENKIT_TLS_KEY_FILE.');
  }
  return { certPath, keyPath };
}

/** Loads the same trusted paths and checks the same pair for boot and for a reload probe. */
export async function loadNativeTlsMaterial(
  source: NativeTlsSource
): Promise<{ listenOptions: NativeTlsListenOptions; publicGeneration: string }> {
  try {
    const [cert, key] = await Promise.all([readFile(source.certPath), readFile(source.keyPath)]);
    createSecureContext({ cert, key });
    const certificates = cert
      .toString('ascii')
      .match(/-----BEGIN ((?:TRUSTED |X509 )?CERTIFICATE)-----[^-]*-----END \1-----/g);
    if (!certificates?.length) throw new Error(INVALID_NATIVE_TLS_PAIR);
    const digest = createHash('sha256');
    for (const certificate of certificates) digest.update(new X509Certificate(certificate).raw);
    return { listenOptions: { cert, key }, publicGeneration: digest.digest('hex') };
  } catch {
    throw new Error(INVALID_NATIVE_TLS_PAIR);
  }
}

/** Checks same-path material off Main. Concurrent checks share the current read, never an earlier result. */
export function createNativeTlsReloadCheck(
  source: NativeTlsSource,
  bootGeneration: string
): () => Promise<boolean> {
  let pending: Promise<boolean> | undefined;
  return () => {
    pending ??= new Promise<string>((resolve, reject) => {
      const fail = () => reject(new Error(INVALID_NATIVE_TLS_PAIR));
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { nativeListenerTlsSource: source },
      });
      worker.once('message', (generation: unknown) => {
        if (typeof generation === 'string') resolve(generation);
        else fail();
      });
      worker.once('error', fail);
      worker.once('exit', fail);
    })
      .then(
        (generation) => generation !== bootGeneration,
        () => {
          throw new Error(INVALID_NATIVE_TLS_PAIR);
        }
      )
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

// A probe returns only the public generation. Shared imports must initialize synchronously.
if (!isMainThread && parentPort && workerData?.nativeListenerTlsSource) {
  const port = parentPort;
  void loadNativeTlsMaterial(workerData.nativeListenerTlsSource as NativeTlsSource).then(
    ({ publicGeneration }) => port.postMessage(publicGeneration),
    () => port.postMessage(null)
  );
}

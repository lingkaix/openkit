/** Built-in supervised backend ids. */
export type LocalBackendId = 'sherpa-onnx-asr' | 'llama-cpp' | 'apple-native';

/** Route supply for one local backend model. */
export interface LocalSupply {
  readonly available: boolean;
  readonly reason:
    | 'local_backend_disabled'
    | 'local_model_not_downloaded'
    | 'local_backend_starting'
    | 'local_backend_unhealthy'
    | null;
  readonly baseUrl: string | null;
}

/** Points one backend at an already-listening loopback server. No download and no child. */
export interface LocalAiLoopbackFixture {
  readonly backendId: LocalBackendId;
  readonly baseUrl: string;
  readonly modelId: string;
}

type SupplyProbe = (backendId: LocalBackendId, providerModel: string) => LocalSupply;
type AbortBinder = (baseUrl: string, signal: AbortSignal) => () => void;

let supplyProbe: SupplyProbe | undefined;
let abortBinder: AbortBinder | undefined;
const pendingFixtures = new Map<LocalBackendId, LocalAiLoopbackFixture>();

/** The active supervisor publishes route supply through this probe. */
export function registerLocalSupplyProbe(probe: SupplyProbe | undefined): void {
  supplyProbe = probe;
}

/** Speech fetches notify the supervisor so a timeout can stop the child. */
export function registerLocalSpeechAbort(binder: AbortBinder | undefined): void {
  abortBinder = binder;
}

/** Resolves one local model. Absent supervision is disabled. */
export function probeLocalSupply(backendId: LocalBackendId, providerModel: string): LocalSupply {
  return (
    supplyProbe?.(backendId, providerModel) ?? {
      available: false,
      reason: 'local_backend_disabled',
      baseUrl: null,
    }
  );
}

/** Binds one in-flight speech fetch to the published speech child. The disposer removes that binding. */
export function bindLocalSpeechAbort(baseUrl: string, signal: AbortSignal): () => void {
  return abortBinder?.(baseUrl, signal) ?? (() => undefined);
}

/** Remembers a fixture until a supervisor exists, then the supervisor applies it. */
export function takePendingLoopbackFixtures(): readonly LocalAiLoopbackFixture[] {
  return [...pendingFixtures.values()];
}

/** Stores a fixture for the current or next supervisor. */
export function rememberLoopbackFixture(input: LocalAiLoopbackFixture): void {
  pendingFixtures.set(input.backendId, input);
}

/** Drops a remembered fixture after disable. */
export function forgetLoopbackFixture(backendId: LocalBackendId): void {
  pendingFixtures.delete(backendId);
}

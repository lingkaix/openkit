import type { resolveAgentEnvironmentPackageMetadata } from './agent-environment.js';
import type { WorkerGovernanceBackend } from './worker-governance-backend.js';

type AssertFalse<Value extends false> = Value;

/** Compiled by NanoCore typecheck: a planning preview cannot enter live materialization. */
export type PreviewCannotMaterialize = AssertFalse<
  ReturnType<typeof resolveAgentEnvironmentPackageMetadata> extends Parameters<
    WorkerGovernanceBackend['materialize']
  >[0]
    ? true
    : false
>;

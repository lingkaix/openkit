import * as actual from '../runtime/agent-environment.js';
import { withTestPreparedNativeEnvironment } from './native-environment.js';

export type * from '../runtime/agent-environment.js';

/** Confirmed image evidence and default-off capture for tests of unrelated AEP consumers. */
export const {
  resolveAgentEnvironmentPackage,
  resolveAgentEnvironmentPackageMetadata,
  resolveAgentSessionCompatibilityKey,
} = withTestPreparedNativeEnvironment(actual);

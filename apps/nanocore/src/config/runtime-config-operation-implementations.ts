import type { RUNTIME_CONFIG_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import type { Actor } from '../auth/identity.js';
import { type FamilyImplementations, publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import type { createAgentNativeEnvironmentService } from './agent-native-environment.js';
import type { RuntimeConfigManager } from './runtime-config.js';
import {
  type RuntimeConfigFileService,
  RuntimeConfigFileServiceError,
} from './runtime-config-files.js';

/** Existing configuration owners; authority and request cancellation come from admitted context. */
interface RuntimeConfigOperationServices {
  readonly filesForActor: (actor: Actor) => RuntimeConfigFileService;
  readonly manager: RuntimeConfigManager;
  readonly nativeEnvironment?: ReturnType<typeof createAgentNativeEnvironmentService> | undefined;
  readonly onReloadApplied?: (() => void) | undefined;
}

/** Joins the configuration family without request parsing, transport framing or a second file lifecycle. */
export function createRuntimeConfigOperationImplementations(
  services?: RuntimeConfigOperationServices
) {
  const owner = () => {
    if (!services)
      throw new OperationError('runtime_unavailable', 'Runtime configuration is unavailable.', 503);
    return services;
  };
  const nativeEnvironment = () => {
    const service = owner().nativeEnvironment;
    if (!service)
      throw new OperationError(
        'runtime_unavailable',
        'Native environment administration is unavailable.',
        503
      );
    return service;
  };
  return {
    'runtime.agent-environment-read': (input, context) =>
      runConfigOperation(() =>
        nativeEnvironment().view(publicOperationActor(context), input.fileId)
      ),
    'runtime.agent-environment-update': (input, context) =>
      runConfigOperation(() => nativeEnvironment().update(publicOperationActor(context), input)),
    'runtime.reload': (input) => {
      const response = owner().manager.reload(input);
      if (response.status === 'applied') owner().onReloadApplied?.();
      return response;
    },
    'runtime.file-list': (_input, context) =>
      runConfigOperation(() => owner().filesForActor(publicOperationActor(context)).listFiles()),
    'runtime.file-read': (input, context) =>
      runConfigOperation(() =>
        owner().filesForActor(publicOperationActor(context)).readFile(input.id)
      ),
    'runtime.file-create': (input, context) =>
      runConfigOperation(() =>
        owner().filesForActor(publicOperationActor(context)).createFile(input)
      ),
    'runtime.file-update': (input, context) =>
      runConfigOperation(() =>
        owner().filesForActor(publicOperationActor(context)).updateFile(input)
      ),
    'runtime.file-delete': (input, context) =>
      runConfigOperation(() => {
        owner().filesForActor(publicOperationActor(context)).deleteFile(input);
        return null;
      }),
    'runtime.schemas': (_input, context) =>
      runConfigOperation(() =>
        owner().filesForActor(publicOperationActor(context)).schemaCatalog()
      ),
    'runtime.validate': (input, context) =>
      runConfigOperation(() =>
        owner().filesForActor(publicOperationActor(context)).validate(input)
      ),
  } satisfies FamilyImplementations<typeof RUNTIME_CONFIG_OPERATION_DEFINITIONS>;
}

/** Classifies file-owner refusals where they originate; unexpected failures reach the shared entry error boundary. */
function runConfigOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof RuntimeConfigFileServiceError)
      throw new OperationError(error.code, error.message, error.status, { cause: error });
    throw error;
  }
}

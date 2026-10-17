import { isDeepStrictEqual } from 'node:util';
import type { RUNTIME_CONFIG_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { parse } from 'jsonc-parser';
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
      runConfigOperation(() => {
        const files = owner().filesForActor(publicOperationActor(context));
        if (input.kind === 'workspace' && input.content !== undefined)
          requireUnchangedResourcePolicy(undefined, input.content);
        return files.createFile(input);
      }),
    'runtime.file-update': (input, context) =>
      runConfigOperation(() => {
        const files = owner().filesForActor(publicOperationActor(context));
        if (input.kind === 'workspace' && input.content !== undefined)
          requireUnchangedResourcePolicy(files.readFile(input.id).content, input.content);
        return files.updateFile(input);
      }),
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

/** Reads the exact authored authority subtree without stripping unsupported configuration values. */
function authoredResourcePolicy(content: string | undefined): unknown {
  if (content === undefined) return undefined;
  const root: unknown = parse(content);
  if (!root || typeof root !== 'object') return undefined;
  const workspace: unknown = Reflect.get(root, 'workspace');
  return workspace && typeof workspace === 'object' ? Reflect.get(workspace, 'policy') : undefined;
}

/** Generic file editing cannot create, widen, revoke or remove resource authority without its confirmed request. */
function requireUnchangedResourcePolicy(previous: string | undefined, next: string): void {
  if (!isDeepStrictEqual(authoredResourcePolicy(previous), authoredResourcePolicy(next)))
    throw new OperationError(
      'resource_policy_confirmation_required',
      'Change Workspace resource Policy through its approved request and confirmation.',
      409
    );
}

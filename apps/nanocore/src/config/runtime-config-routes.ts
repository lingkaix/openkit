import {
  RestartRuntimeConfigStaleSessionResponseSchema,
  RuntimeConfigFileWriteRequestSchema,
  RuntimeConfigReloadRequestSchema,
  RuntimeConfigValidationRequestSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError, asInvalidRequestError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import { findStoredAgentSessionById } from '../runtime/agent-session-read-model.js';
import type { RuntimeConfigManager } from './runtime-config.js';
import {
  type RuntimeConfigFileService,
  RuntimeConfigFileServiceError,
} from './runtime-config-files.js';

/**
 * Converts runtime config file service errors into shared protocol API errors.
 *
 * @param error Runtime config file service or validation error.
 * @returns Product-safe API error response.
 */
function asRuntimeConfigFileError(error: unknown): Response {
  if (error instanceof RuntimeConfigFileServiceError) {
    return asApiError(error.message, error.code, error.status);
  }

  return asInvalidRequestError(error);
}

/**
 * Registers runtime configuration reload, file, validation, and stale-session routes.
 *
 * @param dependencies Hono app and runtime configuration dependencies.
 */
export function registerRuntimeConfigRoutes({
  app,
  requestStore,
  runtimeConfigFileService,
  runtimeConfigManager,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly runtimeConfigFileService: (
    context: Context<{ Variables: AuthVariables }>
  ) => RuntimeConfigFileService;
  readonly runtimeConfigManager: RuntimeConfigManager;
}): void {
  registerAppApiRoute(app, 'reloadRuntimeConfig', async (c) => {
    const parsed = RuntimeConfigReloadRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    return c.json(runtimeConfigManager.reload(parsed.data));
  });

  registerAppApiRoute(app, 'listRuntimeConfigFiles', (c) => {
    try {
      return c.json(runtimeConfigFileService(c).listFiles());
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  registerAppApiRoute(app, 'getRuntimeConfigFile', (c) => {
    const id = c.req.query('id');

    if (!id) {
      return asApiError('Runtime config file id is required.', 'missing_config_file_id', 400);
    }

    try {
      return c.json(runtimeConfigFileService(c).readFile(id));
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  registerAppApiRoute(app, 'createRuntimeConfigFile', async (c) => {
    const parsed = RuntimeConfigFileWriteRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json(runtimeConfigFileService(c).createFile(parsed.data));
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  registerAppApiRoute(app, 'updateRuntimeConfigFile', async (c) => {
    const parsed = RuntimeConfigFileWriteRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json(runtimeConfigFileService(c).updateFile(parsed.data));
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  registerAppApiRoute(app, 'getRuntimeConfigSchemas', (c) => {
    try {
      return c.json(runtimeConfigFileService(c).schemaCatalog());
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  registerAppApiRoute(app, 'validateRuntimeConfig', async (c) => {
    const parsed = RuntimeConfigValidationRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json(runtimeConfigFileService(c).validate(parsed.data));
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  registerAppApiRoute(app, 'restartRuntimeConfigStaleSession', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const sessionId = c.req.param('sessionId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);

      const session = findStoredAgentSessionById(store, workspaceId, sessionId);

      if (!session) {
        return c.json(
          RestartRuntimeConfigStaleSessionResponseSchema.parse({
            restarted: false,
            session: null,
          })
        );
      }

      const updated = store.updateAgentSession(sessionId, {
        configVersion: runtimeConfigManager.current().version,
        message: 'Runtime config stale session retired; start a new worker session.',
        stale: false,
        status: 'interrupted',
      });

      return c.json(
        RestartRuntimeConfigStaleSessionResponseSchema.parse({
          restarted: true,
          session: {
            id: updated.id,
            status: updated.status,
            message: updated.message,
            configVersion: updated.configVersion,
            workspaceRoots: updated.workspaceRoots,
            stale: false,
            sandboxSummary: updated.sandboxSummary,
          },
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'runtime_config_stale_session_restart_failed');
    }
  });
}

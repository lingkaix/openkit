import {
  RuntimeConfigFileWriteRequestSchema,
  RuntimeConfigReloadRequestSchema,
  RuntimeConfigValidationRequestSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError, asInvalidRequestError } from '../api-errors.js';
import { isDeploymentAdminActor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { registerAppApiRoute } from '../openapi.js';
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
 * Requires deployment-admin authority for global runtime configuration.
 *
 * @param c Hono context carrying the authenticated actor.
 * @returns Error response when the actor lacks deployment-admin authority.
 */
function requireRuntimeConfigAdminActor(c: Context<{ Variables: AuthVariables }>): Response | null {
  return isDeploymentAdminActor(c.get('actor'))
    ? null
    : asApiError('Server-admin authority is required.', 'runtime_config_admin_forbidden', 403);
}

/**
 * Registers runtime configuration reload, file, and validation routes.
 *
 * @param dependencies Hono app and runtime configuration dependencies.
 */
export function registerRuntimeConfigRoutes({
  app,
  runtimeConfigFileService,
  runtimeConfigManager,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly runtimeConfigFileService: (
    context: Context<{ Variables: AuthVariables }>
  ) => RuntimeConfigFileService;
  readonly runtimeConfigManager: RuntimeConfigManager;
}): void {
  registerAppApiRoute(app, 'reloadRuntimeConfig', async (c) => {
    const adminError = requireRuntimeConfigAdminActor(c);
    if (adminError) {
      return adminError;
    }

    const parsed = RuntimeConfigReloadRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    return c.json(runtimeConfigManager.reload(parsed.data));
  });

  registerAppApiRoute(app, 'listRuntimeConfigFiles', (c) => {
    const adminError = requireRuntimeConfigAdminActor(c);
    if (adminError) {
      return adminError;
    }

    try {
      return c.json(runtimeConfigFileService(c).listFiles());
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  registerAppApiRoute(app, 'getRuntimeConfigFile', (c) => {
    const adminError = requireRuntimeConfigAdminActor(c);
    if (adminError) {
      return adminError;
    }

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
    const adminError = requireRuntimeConfigAdminActor(c);
    if (adminError) {
      return adminError;
    }

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
    const adminError = requireRuntimeConfigAdminActor(c);
    if (adminError) {
      return adminError;
    }

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
    const adminError = requireRuntimeConfigAdminActor(c);
    if (adminError) {
      return adminError;
    }

    try {
      return c.json(runtimeConfigFileService(c).schemaCatalog());
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  registerAppApiRoute(app, 'validateRuntimeConfig', async (c) => {
    const adminError = requireRuntimeConfigAdminActor(c);
    if (adminError) {
      return adminError;
    }

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
}

import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { asCommandError, asInvalidRequestError, publishedErrorMessage } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import { registerThreadRoutes } from './thread-routes.js';

it('walks cyclic causes and aggregate entries before reading the baked message', () => {
  const parser = new SyntaxError('ROW_SECRET_X9');
  const aggregate = new AggregateError([], 'Baked private message');
  aggregate.errors.push(aggregate, { cause: new Error('wrapper', { cause: parser }) });
  Object.defineProperty(aggregate, 'message', {
    get: () => {
      throw new Error('Must not read the aggregate message.');
    },
  });
  expect(publishedErrorMessage(aggregate)).toBe('The retained record could not be read.');
  const authored = new Error('Authored cyclic failure.');
  Object.defineProperty(authored, 'cause', { value: authored });
  expect(publishedErrorMessage(authored)).toBe(authored.message);
});

it('keeps each caller fallback for non-Error values', () => {
  expect(publishedErrorMessage('backend failed', 'The governed worker turn failed.')).toBe(
    'The governed worker turn failed.'
  );
  expect(publishedErrorMessage(null, 'null')).toBe('null');
  expect(publishedErrorMessage({ cause: new SyntaxError('ROW_SECRET_X9') }, 'unknown')).toBe(
    'The retained record could not be read.'
  );
});

it('preserves authored errors and route-specific code and status', async () => {
  const error = new Error('Workspace not found: ws_demo');
  const command = asCommandError(error, 'command_missing', 409);
  expect(command.status).toBe(409);
  expect(await command.json()).toMatchObject({ code: 'command_missing', message: error.message });
  const app = new Hono<{ Variables: AuthVariables }>();
  registerThreadRoutes({
    app,
    inflightCommands: new WeakMap(),
    requestStore: () => {
      throw error;
    },
  });
  const response = await app.request('/api/workspaces/ws_demo/threads');
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'not_found', message: error.message });
});

it.each([
  'syntax',
  'schema',
  'cause',
  'aggregate',
  'nested',
] as const)('bounds the %s quoting error tree at command publication', async (variant) => {
  const marker = 'ROW_SECRET_X9';
  const parsed = z
    .object({ id: z.string() })
    .strict()
    .safeParse({ id: 'demo', [marker]: true });
  if (parsed.success) throw new Error('Expected invalid retained record.');
  const syntax = new SyntaxError(marker);
  const error =
    variant === 'syntax'
      ? syntax
      : variant === 'schema'
        ? parsed.error
        : variant === 'cause'
          ? new Error('Already authored', { cause: syntax })
          : variant === 'aggregate'
            ? new AggregateError([parsed.error], `Baked ${marker}`)
            : new AggregateError(
                [new Error('wrapped', { cause: new AggregateError([syntax], marker) })],
                marker
              );
  const response = asCommandError(error, 'reader_failed', 500);
  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body).toMatchObject({
    code: 'reader_failed',
    message: 'The retained record could not be read.',
  });
  expect(JSON.stringify(body)).not.toContain(marker);
});

it('preserves safeParse request-body validation detail on the real route', async () => {
  const app = new Hono<{ Variables: AuthVariables }>();
  registerOperationJsonRoutes({
    app,
    inflightCommands: new WeakMap(),
    requestStore: () => {
      throw new Error('Must not enter operation.');
    },
  });
  const response = await ((input: Record<string, unknown>) =>
    app.request('/api/app/operations/thread.create', {
      method: 'POST',
      headers: {
        ...{ ...{ 'content-type': 'application/json' }, 'content-type': 'application/json' },
        ...(typeof input.requestId === 'string' ? { 'x-openkit-request-id': input.requestId } : {}),
      },
      body: JSON.stringify(input),
    }))({ ...{ name: 42 }, workspaceId: 'ws_demo' });
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.code).toBe('invalid_request');
  expect(body.message).toContain('name');
  expect(body.message).toContain('requestId');
  const parsed = z.object({ name: z.string() }).safeParse({ name: 42 });
  if (parsed.success) throw new Error('Expected invalid request.');
  expect(await asInvalidRequestError(parsed.error).json()).toMatchObject({
    message: z.prettifyError(parsed.error),
  });
});

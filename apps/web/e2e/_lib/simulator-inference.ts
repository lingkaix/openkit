import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

/**
 * Installs the secret-free provider profile, Gateway route, and internal-role profile.
 *
 * The shipped internal-role template prefers the logical model `smart`. This seed's
 * Gateway only declares `reasoning`, so the Assistant stays unavailable unless this
 * profile is written before Core copies that template.
 *
 * @param dataRoot NanoCore data root to seed.
 * @param providerBaseUrl Optional loopback endpoint for Assistant inference.
 * @returns Resolves after the provider profile, Gateway route, and role profile are durable.
 * @throws When the config directory or any of those files cannot be written.
 */
export async function seedSimulatorInferenceConfig(
  dataRoot: string,
  providerBaseUrl?: string
): Promise<void> {
  const providersRoot = join(dataRoot, 'config', 'providers');
  await mkdir(providersRoot, { recursive: true });
  await writeFile(
    join(providersRoot, 'agent-openrouter.provider.jsonc'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'agent-openrouter',
        displayName: 'Agent OpenRouter test local',
        kind: 'local',
        ...(providerBaseUrl ? { baseUrl: providerBaseUrl } : {}),
        defaultModel: 'openai/gpt-5.2',
        models: ['openai/gpt-5.2'],
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(dataRoot, 'config', 'gateway.jsonc'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [
              {
                id: 'simulator',
                providerProfileId: 'agent-openrouter',
                providerModel: 'openai/gpt-5.2',
              },
            ],
          },
        ],
        requiredFeatures: [],
        extensions: {},
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(dataRoot, 'config', 'internal-role-profiles.jsonc'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        defaultLogicalModelId: 'reasoning',
        profiles: [
          {
            id: 'assistant-default',
            roleId: 'assistant',
            preferredLogicalModelId: 'reasoning',
            compatibleLogicalModelIds: ['reasoning'],
            requiredLogicalModelCapabilities: ['chat-completions'],
          },
          {
            id: 'knowledge-manager-default',
            roleId: 'knowledge-manager',
            preferredLogicalModelId: 'reasoning',
            compatibleLogicalModelIds: ['reasoning'],
            requiredLogicalModelCapabilities: ['chat-completions'],
          },
        ],
      },
      null,
      2
    )}\n`
  );
}

/** Fixed answer sent by the configured Assistant test provider. */
export const FIXTURE_ASSISTANT_ANSWER = 'Hello from the test provider.';

/** Serves a complete answer over the real Gateway Chat Completions transport on loopback. */
export async function startFixtureAssistantProvider(): Promise<{
  baseUrl: string;
  stop(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    request.resume();
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const chunk = {
      id: 'chatcmpl-web-e2e',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'openai/gpt-5.2',
    };
    const events = [
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: FIXTURE_ASSISTANT_ANSWER },
            finish_reason: null,
          },
        ],
      },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      {
        ...chunk,
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 6, total_tokens: 13 },
      },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = events.map((event) => JSON.stringify(event));
    frames.push('[DONE]');
    response.end(frames.map((frame) => `data: ${frame}\n\n`).join(''));
  });
  await new Promise<void>((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The fixture Assistant provider did not bind to loopback.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    stop: () =>
      new Promise<void>((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
      }),
  };
}

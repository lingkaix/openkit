import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Installs the secret-free provider profile, Gateway route, and internal-role profile.
 *
 * The shipped internal-role template prefers the logical model `smart`. This seed's
 * Gateway only declares `reasoning`, so the Assistant stays unavailable unless this
 * profile is written before Core copies that template.
 *
 * @param dataRoot NanoCore data root to seed.
 * @returns Resolves after the provider profile, Gateway route, and role profile are durable.
 * @throws When the config directory or any of those files cannot be written.
 */
export async function seedSimulatorInferenceConfig(dataRoot: string): Promise<void> {
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

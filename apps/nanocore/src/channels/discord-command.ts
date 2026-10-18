/** Exact request selectors; the Core owner still validates each identifier and its lineage. */
const targetOptions = [
  {
    type: 3,
    name: 'workspace',
    description: 'Exact OpenKit Workspace id.',
    required: true,
    max_length: 256,
  },
  {
    type: 3,
    name: 'thread',
    description: 'Exact OpenKit Thread id.',
    required: true,
    max_length: 256,
  },
  {
    type: 3,
    name: 'request',
    description: 'Exact OpenKit Pending Request id.',
    required: true,
    max_length: 256,
  },
] as const;

/** A token from a current private inspection, bound to this exact request and account binding. */
const disclosureOption = {
  type: 3,
  name: 'disclosure',
  description: 'Disclosure token from the complete private inspection.',
  required: true,
  min_length: 43,
  max_length: 43,
} as const;

/** Global slash-command registration body. Exporting it does not register or update a Discord app. */
export const DISCORD_OPENKIT_COMMAND = {
  name: 'openkit',
  type: 1,
  description: 'Pair your account and respond to exact OpenKit requests in a private bot DM.',
  contexts: [1],
  integration_types: [0],
  options: [
    {
      type: 1,
      name: 'pair',
      description: 'Pair this Discord account with your authenticated OpenKit account.',
      options: [
        {
          type: 3,
          name: 'challenge',
          description: 'One-use challenge from your OpenKit account settings.',
          required: true,
          min_length: 43,
          max_length: 43,
        },
      ],
    },
    {
      type: 1,
      name: 'inspect',
      description: 'Read the complete exact effect or non-secret question before responding.',
      options: targetOptions,
    },
    {
      type: 1,
      name: 'answer',
      description: 'Answer the exact non-secret question shown by a current inspection.',
      options: [
        ...targetOptions,
        disclosureOption,
        {
          type: 3,
          name: 'answers',
          description: 'JSON object mapping each question id to a one-string array.',
          required: true,
          max_length: 4_000,
        },
      ],
    },
    {
      type: 1,
      name: 'approve',
      description: 'Open this approval in OpenKit; grants require the complete App confirmation.',
      options: targetOptions,
    },
    {
      type: 1,
      name: 'deny',
      description: 'Deny the exact approval shown by a current inspection.',
      options: [...targetOptions, disclosureOption],
    },
  ],
} as const;

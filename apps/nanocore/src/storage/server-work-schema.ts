/** Identifies the Server work journal and the tables its native handlers require. */
export const serverWorkStorageDescriptor = {
  owner: 'server-work',
  requiredTables: [
    'capability_calls',
    'control_product_entries',
    'control_threads',
    'control_turns',
    'control_work_observations',
    'evidence_bundles',
    'server_work_intents',
    'usage_records',
  ],
} as const;

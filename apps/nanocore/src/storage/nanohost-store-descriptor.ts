/** Identifies the NanoHost extension and the native tables required at serving open. */
export const nanoHostStoreDescriptor = {
  owner: 'nanohost',
  requiredTables: [
    'agent_session_runtime_binding_image_digests',
    'agent_session_runtime_bindings',
    'harness_instance_records',
    'nanohost_integration_identities',
    'nanohost_runtime_targets',
    'nanohost_transport_tokens',
    'sandbox_runtime_records',
    'worker_backend_sessions',
    'worker_control_records',
    'worker_control_rejected_evidence',
    'worker_control_sequence_fingerprints',
    'worker_image_settlements',
    'worker_storage_bindings',
    'worker_storage_contributors',
  ],
} as const;

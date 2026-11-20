/** The closed owner descriptor sent to the shared reader and writer admission. */
export const communicationOwner = {
  owner: 'communication',
  requiredTables: [
    'channel_account_bindings',
    'channel_pairing_challenges',
    'channel_disclosures',
    'notification_attention',
    'notification_delivery_attempts',
    'communication_intents',
  ],
} as const;

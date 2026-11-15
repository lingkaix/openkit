/** Discord inbound events from the Core command log, projected as one flat row per event. */
export const DISCORD_INBOUND_ROWS = `(SELECT request_id AS event_id,
  substr(input_hash, 8) AS payload_digest, response_id AS request_id,
  json_extract(response_json,'$.state') AS state, created_at,
  json_extract(scope_json,'$.discordUserId') AS discord_user_id,
  json_extract(response_json,'$.origin.coreUserId') AS core_user_id,
  json_extract(response_json,'$.origin.bindingRevision') AS binding_revision,
  json_extract(response_json,'$.origin.operationId') AS operation_id,
  json_extract(response_json,'$.origin.workspaceId') AS workspace_id,
  json_extract(response_json,'$.origin.threadId') AS thread_id,
  json_extract(response_json,'$.origin.pendingRequestId') AS pending_request_id,
  json_extract(response_json,'$.origin.turnId') AS turn_id
  FROM idempotency_requests WHERE command_name = 'channel.discord.inbound')`;

/** Trigger condition for a Discord event state transition (settlement or restart reconciliation). */
export const DISCORD_STATE_CHANGE = `NEW.command_name = 'channel.discord.inbound'
  AND json_extract(NEW.response_json,'$.state') IS NOT json_extract(OLD.response_json,'$.state')`;

/** Trigger condition for the one responder-origin stamp. */
export const DISCORD_ORIGIN_STAMP = `NEW.command_name = 'channel.discord.inbound'
  AND json_extract(NEW.response_json,'$.origin') IS NOT NULL
  AND json_extract(OLD.response_json,'$.origin') IS NULL`;

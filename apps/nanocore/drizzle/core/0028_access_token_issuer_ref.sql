-- Legacy and otherwise unattributed credentials retain NULL; never infer an issuer from ownership.
ALTER TABLE `openkit_access_tokens` ADD COLUMN `issuer_ref_json` text;

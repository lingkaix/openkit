CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `id` text PRIMARY KEY NOT NULL,
  `applied_at` text NOT NULL
);

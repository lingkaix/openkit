import { z } from 'zod';

/** Canonical positive Discord uint64, without lossy Number conversion. */
export const DiscordSnowflakeSchema = z
  .string()
  .refine(
    (value) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n
  );

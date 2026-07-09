import { z } from 'zod';

/**
 * Phase-1 timestamps are RFC3339/ISO strings.
 */
export const TimestampSchema = z.string().min(1);

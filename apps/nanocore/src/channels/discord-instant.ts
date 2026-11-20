import { z } from 'zod';

const wireInstant = z.iso.datetime({ offset: true });

/** Normalizes to UTC while preserving the source's complete fractional instant. */
export function normalizeDiscordInstant(input: string): string | null {
  if (!wireInstant.safeParse(input).success) return null;
  const parts = /^(.*:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(input);
  if (!parts) return null;
  const base = new Date(`${parts[1]}${parts[3]}`);
  if (!Number.isFinite(base.getTime())) return null;
  const fraction = parts[2]?.replace(/0+$/, '');
  return `${base.toISOString().slice(0, -5)}${fraction ? `.${fraction}` : ''}Z`;
}

/** Retained instant bytes are canonical UTC, not a millisecond projection. */
export const DiscordInstantSchema = z
  .string()
  .refine((value) => normalizeDiscordInstant(value) === value);

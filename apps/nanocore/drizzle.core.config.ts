import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './drizzle/kit-schema.ts',
  out: './drizzle/core',
  dialect: 'sqlite',
});

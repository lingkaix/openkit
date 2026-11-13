import { mergeConfig } from 'vite';
import base from '../vite.config.ts';

export default mergeConfig(base, {
  root: new URL('.', import.meta.url).pathname,
  build: { outDir: new URL('./dist', import.meta.url).pathname, emptyOutDir: true },
  server: {
    fs: {
      allow: [new URL('..', import.meta.url).pathname, new URL('../..', import.meta.url).pathname],
    },
  },
});

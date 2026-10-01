/**
 * AgentSession-private OpenCode plugin. The source contains no credential, model, or URL.
 * At request time it reads those values from the sibling `loopback` directory.
 */
export const OPENCODE_PLUGIN_SOURCE = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'loopback');
const read = (name) => readFileSync(join(root, name), 'utf8').trim();

export default {
  id: 'openkit-loopback',
  async setup(ctx) {
    // Refresh the final native inline layer from the credential-free private configuration.
    process.env.OPENKIT_OPENCODE_CONFIG = readFileSync(join(root, '..', 'config', 'openkit.json'), 'utf8');
    // The pin debounces MCP tool-registry reloads after connection. Publish only a
    // location-specific generation, never tool names, so the adapter can await that reload.
    let generation = 0;
    await ctx.tool.transform(() => {
      const key = createHash('sha256').update(ctx.location.directory).digest('hex');
      writeFileSync(join(root, 'tools-' + key), String(++generation), { mode: 0o600 });
    });
    await ctx.session.hook('model.request', async (evt) => {
      evt.baseURL = read('inference-base');
      if (!evt.headers) evt.headers = {};
      evt.headers.authorization = 'Bearer ' + read('inference-bearer');
    });
    if (ctx.permission && typeof ctx.permission.hook === 'function') {
      await ctx.permission.hook('evaluate', async (evt) => {
        if (evt.effect !== 'ask') return;
        // Retain refusal for future user-configurable policy; the current default grants once.
        const decision = 'once';
        evt.effect = decision === 'reject' ? 'deny' : 'allow';
        appendFileSync(
          join(root, 'permission-decisions.jsonl'),
          JSON.stringify({ decision }) + '\\n',
        );
      });
    }
    if (ctx.mcp && typeof ctx.mcp.transform === 'function') {
      await ctx.mcp.transform((editor) => {
        const bearer = read('capability-bearer');
        let grants = {};
        try { grants = JSON.parse(read('mcp-grants')); } catch { return; }
        for (const [id, draft] of editor.list()) {
          if (!Object.hasOwn(grants, id) || draft.url !== grants[id]) continue;
          if (!draft.headers) draft.headers = {};
          draft.headers.authorization = 'Bearer ' + bearer;
        }
      });
    }
  },
};
`;

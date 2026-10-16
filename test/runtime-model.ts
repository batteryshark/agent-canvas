import type { Plugin } from '@opencode/plugin';

// A provider routed only to the local deterministic HTTP fixture in scripts/test-runtime.mjs.
const fixture: Plugin.Plugin = {
  id: 'canvas-runtime-test-model',
  async setup(ctx) {
    await ctx.provider.transform(editor => {
      const template = editor.list().flatMap(p => [...p.models.values()])[0];
      if (!template) throw new Error('No model template available in the OpenCode catalog');
      editor.add({
        info: { id: 'canvas-test', name: 'Canvas test', activation: 'enabled', package: '@opencode/ai/providers/openai/chat', settings: { apiKey: 'fixture', baseURL: `http://127.0.0.1:${process.env.CANVAS_TEST_MODEL_PORT}/v1` } } as any,
        models: [{ ...template, id: 'fixture', modelID: 'fixture', providerID: 'canvas-test', package: '@opencode/ai/providers/openai/chat', settings: {}, enabled: true, variants: [], cost: [], limit: { context: 100000, output: 10000 } } as any],
      });
    });
  },
};
export default fixture;

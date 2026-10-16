// Generates src/generated/openui-schema.json (what the service validates against) and
// src/generated/openui-guide.md (what canvas_guide serves). Run: node --import tsx scripts/generate-openui.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canvasLibrary } from '../src/ui/openui/library.tsx';
import { buildOpenUIGuide, guideExamples } from '../src/ui/openui/prompt.ts';

const out = fileURLToPath(new URL('../src/generated/', import.meta.url));
await mkdir(out, { recursive: true });
const guide = buildOpenUIGuide();
// Each component's signature as the guide prints it, for validation errors that agree with the guide.
const signatures = Object.fromEntries(guide.split('\n').flatMap(line => {
  const signature = line.split(' — ')[0], name = /^([A-Z][A-Za-z0-9]*)\(.*\)$/.exec(signature)?.[1];
  return name && canvasLibrary.components[name] ? [[name, signature]] : [];
}));
await writeFile(`${out}openui-schema.json`, `${JSON.stringify({ root: canvasLibrary.root, schema: canvasLibrary.toJSONSchema(), signatures })}\n`);
await writeFile(`${out}openui-guide.md`, guide);

// The validator reads the schema written above, so load it only now. A guide whose examples
// the service would reject teaches agents to write invalid views.
const { validateOpenUI } = await import('../src/shared/openui-validate.ts');
const examples = guideExamples(guide);
if (examples.length < 10) throw new Error(`Expected at least 10 examples in the OpenUI guide, found ${examples.length}.`);
const invalid = examples.map((source, i) => ({ i: i + 1, errors: validateOpenUI(source).errors })).filter(r => r.errors.length);
if (invalid.length) throw new Error(`OpenUI guide examples fail validation:\n${invalid.map(r => `Example ${r.i}: ${r.errors.join('\n  ')}`).join('\n')}`);
console.log(`Generated OpenUI schema (${Object.keys(canvasLibrary.components).length} components) and guide (${guide.length} characters, ${examples.length} examples) in src/generated/.`);

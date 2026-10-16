// Service-side validation of OpenUI Lang views. Node-safe: the library schema is generated
// at build time (scripts/generate-openui.mjs), so no React or OpenUI components load here.
import { createParser, type LibraryJSONSchema, type ParseResult, type ValidationError } from '@openuidev/lang-core';
import generated from '../generated/openui-schema.json' with { type: 'json' };
import { LIMITS, type Check } from './contract';

// signatures: each component's line from the guide (optional arguments marked "?"), so errors match what agents read.
const { root, schema, signatures = {} } = generated as unknown as { root: string; schema: LibraryJSONSchema; signatures?: Record<string, string> };
const parser = createParser(schema, root);
const START = `Start with \`root = ${root}([...])\` and put every statement on its own line as \`name = Component(arg1, arg2, ...)\`. Call canvas_guide with topic "openui" for the component reference.`;

const quote = (names: string[]) => names.map(n => `"${n}"`).join(', ');

function describe(e: ValidationError) {
  const where = e.statementId ? `Statement "${e.statementId}" (${e.component})` : e.component ? `${e.component}` : 'Source';
  const signature = e.component && signatures[e.component];
  const message = signature ? e.message.replace(/— signature: [\s\S]*$/, `— signature: ${signature}`) : e.message;
  return `${where}${e.path ? ` at ${e.path}` : ''}: ${message} [${e.code}]`;
}

/**
 * `name: value` as a call argument. Arguments are positional, and the parser reads such a name as a reference, which
 * produces misleading errors about types and undefined names; one plain error says what to change instead.
 */
function namedArguments(source: string): Array<{ call: string; name: string }> {
  const found: Array<{ call: string; name: string }> = [], open: Array<{ bracket: string; call: string }> = [];
  let quote = '', previous = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) { quote = ''; previous = 'value'; } continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if ('([{'.includes(c)) { open.push({ bracket: c, call: c === '(' ? /([A-Za-z_]\w*)\s*$/.exec(source.slice(Math.max(0, i - 80), i))?.[1] ?? '' : '' }); previous = c; continue; }
    if (')]}'.includes(c)) { open.pop(); previous = c; continue; }
    const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i, i + 80))?.[0];
    if (word) {
      const call = open[open.length - 1];
      if (call?.bracket === '(' && (previous === '(' || previous === ',') && /^\s*:/.test(source.slice(i + word.length, i + word.length + 20))) found.push({ call: call.call, name: word });
      i += word.length - 1; previous = 'value'; continue;
    }
    if (!/\s/.test(c)) previous = c;
  }
  return found;
}

/** Images that would draw a blank area: Canvas has no network and cannot read files, so only data: URLs show. */
const IMAGE_SOURCES: Record<string, (props: Record<string, unknown>) => unknown[]> = {
  Image: p => [p.src], ImageBlock: p => [p.src], ImageText: p => [p.src], ImageTextLarge: p => [p.src],
  ContextCardItem: p => [p.bgImageSrc], VisualCardItem: p => [p.bgImageSrc],
  ImageGallery: p => Array.isArray(p.images) ? p.images.map(i => (i as { src?: unknown })?.src) : [],
  ListItem: p => [(p.image as { src?: unknown } | undefined)?.src],
};

type Element = { type: 'element'; typeName: string; statementId?: string; props: Record<string, unknown> };
const isElement = (value: unknown): value is Element => !!value && typeof value === 'object' && (value as Element).type === 'element' && typeof (value as Element).typeName === 'string';

function visit(value: unknown, found: (e: Element) => void, seen = new Set<unknown>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (isElement(value)) { found(value); visit(value.props, found, seen); return; }
  for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, found, seen);
}

/** Graph checks the schema cannot express: unique node ids and edges that point at real nodes. */
function checkDiagram(d: Element, errors: string[], warnings: string[]) {
  const name = d.statementId ? `Diagram "${d.statementId}"` : 'Diagram';
  // Nodes built by @Each, $variables or other expressions are only known at render time.
  if (!Array.isArray(d.props.nodes) || !d.props.nodes.every(isElement)) return;
  const nodes = d.props.nodes, edges = (Array.isArray(d.props.edges) ? d.props.edges : []).filter(isElement);
  if (!nodes.length) { errors.push(`${name} has no nodes. Pass DiagramNode references as its first argument: Diagram([n1, n2], [e1]).`); return; }
  const ids = nodes.map(n => n.props.id).filter((id): id is string => typeof id === 'string');
  const known = new Set(ids);
  if (ids.length !== nodes.length) return;
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicates.length) errors.push(`${name} repeats node id ${quote(duplicates)}. Every DiagramNode id must be unique.`);
  for (const e of edges) {
    const { from, to } = e.props;
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    const missing = [from, to].filter(id => !known.has(id));
    if (missing.length) errors.push(`${name}: edge ${e.statementId ? `"${e.statementId}" ` : ''}${JSON.stringify(from)} → ${JSON.stringify(to)} refers to unknown node id ${quote([...new Set(missing)])}. Known ids: ${quote(ids.slice(0, 40))}${ids.length > 40 ? ', …' : ''}.`);
  }
  if (nodes.length > 80) warnings.push(`${name} has ${nodes.length} nodes; consider splitting it so it stays readable.`);
}

export function validateOpenUI(source: string): Check {
  const errors: string[] = [], warnings: string[] = [];
  if (!source.trim()) return { errors: [`The source is empty. ${START}`], warnings };
  if (source.length > LIMITS.openuiSource) return { errors: [`The source is ${source.length} characters; OpenUI views are limited to ${LIMITS.openuiSource}. Split it into several views or summarize the data.`], warnings };
  const named = namedArguments(source);
  if (named.length) {
    const calls = [...new Set(named.map(n => n.call).filter(Boolean))];
    const usage = calls.map(c => signatures[c] ?? `${c}(…)`).join('; ');
    return { errors: [`Arguments are positional, not named: remove ${quote([...new Set(named.map(n => `${n.name}:`))])} and pass the values in signature order${usage ? `: ${usage}` : ''}. Leave out trailing optional arguments you do not need.`], warnings };
  }
  let result: ParseResult;
  try { result = parser.parse(source); }
  catch (e) { return { errors: [`The source could not be parsed: ${(e as Error).message}. ${START}`], warnings }; }
  const { meta } = result;
  if (meta.incomplete) errors.push('The source is incomplete: a string, bracket or parenthesis is left open, or the last statement is cut off. Close it and make sure every statement is complete.');
  for (const e of meta.errors) (e.severity === 'warning' ? warnings : errors).push(e.code === 'no-root' ? `${e.message}. ${START}` : describe(e));
  if (meta.unresolved.length) errors.push(`Referenced but never defined: ${quote([...new Set(meta.unresolved)])}. Define each one as \`name = ...\`, or fix the spelling of the reference.`);
  if (meta.orphaned.length) errors.push(`Defined but not reachable from root, so it would not render: ${quote(meta.orphaned)}. Add each one to a parent's children (or remove it).`);
  if (result.queryStatements.length || result.mutationStatements.length) {
    const names = [...result.queryStatements, ...result.mutationStatements].map(s => s.statementId);
    errors.push(`Query() and Mutation() are not available in Agent Canvas (it has no tools or network): ${quote(names)}. Inline the data as literal arrays and objects instead.`);
  }
  if (!result.root && !result.rootExpression && !meta.errors.some(e => e.code === 'no-root')) {
    errors.push(meta.statementCount ? `No root component found. ${START}` : `This is not OpenUI Lang: no \`name = Component(...)\` statements were found. ${START}`);
  }
  const images: string[] = [];
  if (result.root) visit(result.root, e => {
    if (e.typeName === 'Diagram') checkDiagram(e, errors, warnings);
    for (const src of IMAGE_SOURCES[e.typeName]?.(e.props) ?? []) if (typeof src === 'string' && src.trim() && !/^data:image\//i.test(src.trim())) images.push(`${e.typeName} "${src.slice(0, 80)}"`);
  });
  if (images.length) warnings.push(`${images.slice(0, 3).join(', ')}${images.length > 3 ? ` and ${images.length - 3} more` : ''} will show as a blank area: Canvas has no network and cannot read files, so only data:image/… URLs load. Embed a small image as a data: URL, draw it with a chart or Diagram, or leave it out.`);
  return { errors, warnings };
}

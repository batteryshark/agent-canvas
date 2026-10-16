// Maps OpenUI action events to Canvas submissions. Node-safe: types only from OpenUI.
import type { ActionEvent } from '@openuidev/lang-core';
import { LIMITS } from '../../shared/contract';

export type OpenUISubmission = { kind: 'send'; action: string; data: unknown } | { kind: 'open'; url: string };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** OpenUI stores each field as { value, componentType }; the agent only needs the values. */
function flattenForm(fields: unknown): Record<string, unknown> {
  if (!record(fields)) return {};
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, record(field) && 'value' in field ? field.value : field]));
}

const clean = (text: string) => text.trim().replace(/\s+/g, ' ');
const label = (text: string) => text.length > LIMITS.action ? `${text.slice(0, LIMITS.action - 1)}…` : text;
const orNull = (data: Record<string, unknown>) => Object.keys(data).length ? data : null;

export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

export function toSubmission(event: ActionEvent): OpenUISubmission | null {
  const params = record(event.params) ? event.params : {};
  if (event.type === 'open_url') {
    const url = safeUrl(params.url);
    return url ? { kind: 'open', url } : null;
  }
  if (event.type === 'continue_conversation') {
    const message = clean(typeof event.humanFriendlyMessage === 'string' ? event.humanFriendlyMessage : '');
    const data: { params?: Record<string, unknown>; form?: Record<string, unknown>; message?: string } = {};
    if (Object.keys(params).length) data.params = params;
    // Without a form name, formState is the whole view's state; only a form's own fields belong to its submission.
    if (event.formName) data.form = flattenForm(record(event.formState) ? event.formState[event.formName] : undefined);
    // Submissions cap the action label, so a long message travels in full with the data.
    if (message.length > LIMITS.action) data.message = message;
    return { kind: 'send', action: label(message) || 'Continue', data: orNull(data) };
  }
  const action = label(clean(String(event.type ?? '')));
  return action ? { kind: 'send', action, data: orNull(params) } : null;
}

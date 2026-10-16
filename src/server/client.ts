import { CanvasError } from '../shared/contract';
import type { Connection } from './config';

/** Calls the Canvas service. GET without a body, POST with one. Failures keep the service's status and message. */
export async function request<T>(config: Connection, path: string, body?: unknown, token = config.token, timeoutMs = 10_000): Promise<T> {
  const response = await fetch(`${config.endpoint}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data: any;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 500) }; }
  if (!response.ok) throw new CanvasError(response.status, data?.error || `Canvas HTTP ${response.status}`);
  return data as T;
}

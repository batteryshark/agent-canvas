import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataHome, type Connection } from '../server/config';
import { SERVICE_VERSION } from '../server/http';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** What answers on the endpoint's /health, or undefined when nothing does. */
async function running(config: Connection): Promise<{ name?: unknown; version?: unknown } | undefined> {
  try {
    const response = await fetch(`${config.endpoint}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json().catch(() => ({})) : {};
  } catch { return undefined; }
}
async function healthy(config: Connection) {
  const health = await running(config);
  if (!health) return false;
  // Hard cutover: an older service or another program on this port is reported, never reused.
  if (health.name !== 'agent-canvas') throw new Error(`Something other than Agent Canvas is answering at ${config.endpoint}. Free that port, or change the endpoint in connection.json under AGENT_CANVAS_HOME.`);
  if (health.version !== SERVICE_VERSION) throw new Error(`An incompatible Agent Canvas service (version ${health.version}) is running at ${config.endpoint}. Stop it, then try again.`);
  return true;
}

/** Starts the packaged service beside this plugin when nothing answers on the configured loopback endpoint. */
export async function ensureService(config: Connection) {
  if (await healthy(config)) return;
  if (!LOOPBACK.has(new URL(config.endpoint).hostname)) throw new Error(`The Agent Canvas service at ${config.endpoint} is not reachable. Start it on its host.`);
  const home = dataHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const logPath = join(home, 'service.log'), log = openSync(logPath, 'a', 0o600);
  try {
    const service = join(dirname(fileURLToPath(import.meta.url)), 'canvas-service.cjs');
    // Detached so the service outlives this OpenCode process and is shared by every conversation on the host.
    const child = spawn(process.env.AGENT_CANVAS_NODE || 'node', [service, 'serve'], { detached: true, stdio: ['ignore', log, log], env: process.env });
    let failed = undefined as Error | undefined;
    child.on('error', error => { failed = error; });
    child.unref();
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (failed) throw new Error(`Could not start the Agent Canvas service: ${failed.message}. Install Node.js 22 or newer, or set AGENT_CANVAS_NODE to its path.`);
      if (await healthy(config)) return;
    }
    throw new Error(`The Agent Canvas service did not start. See ${logPath}.`);
  } finally { closeSync(log); }
}

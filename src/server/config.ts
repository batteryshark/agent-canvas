import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const ConnectionSchema = z.object({
  endpoint: z.string().url(), token: z.string().min(32), publicUrl: z.string().url(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const DEFAULT_PORT = 4317;
export const dataHome = () => process.env.AGENT_CANVAS_HOME || join(homedir(), '.local', 'share', 'agent-canvas');
export const statePath = (home = dataHome()) => join(home, 'state.json');

/** Reads connection.json, creating it (mode 0600) with a fresh agent token on first use. */
export function connection(home = dataHome()): Connection {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'connection.json');
  try { return ConnectionSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    const port = Number(process.env.AGENT_CANVAS_PORT || DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid AGENT_CANVAS_PORT');
    const endpoint = `http://127.0.0.1:${port}`;
    const config = { endpoint, publicUrl: endpoint, token: randomBytes(32).toString('base64url') };
    // wx: when two processes race to create it, both end up reading the winner's token.
    try { writeFileSync(path, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 }); }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    return ConnectionSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  }
}

export function saveConnection(config: Connection, home = dataHome()) {
  writeFileSync(join(home, 'connection.json'), JSON.stringify(ConnectionSchema.parse(config), null, 2), { mode: 0o600 });
}

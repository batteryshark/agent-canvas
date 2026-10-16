import type { Plugin } from '@opencode/plugin';
import type { DeliveryJob, DeliveryResult } from '../shared/contract';
import type { Connection } from '../server/config';
import { request } from '../server/client';

// The plugin's in-process session API ignores request signals, so every call is bounded here.
function within<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export async function deliverToSession(api: Pick<Plugin.Context['session'], 'get' | 'wait' | 'prompt'>, job: DeliveryJob): Promise<DeliveryResult> {
  const { action, session } = job, sessionID = session.sessionId;
  let attempted = false;
  try {
    const target = await within(api.get({ sessionID }, { signal: AbortSignal.timeout(8000) }), 8000);
    if (target.location.directory !== session.directory) {
      return { id: action.id, status: 'unsent', detail: 'This conversation moved to another directory. Reopen Canvas from that conversation before sending.' };
    }
    await within(api.wait({ sessionID }, { signal: AbortSignal.timeout(1000) }), 1000);
    attempted = true;
    await within(api.prompt({ sessionID, id: action.messageId, text: action.prompt, delivery: 'queue', resume: true }, { signal: AbortSignal.timeout(10_000) }), 10_000);
    return { id: action.id, status: 'delivered', detail: 'Accepted into this OpenCode conversation.' };
  } catch {
    // Only failures before admission are safe to retry. An interrupted admission may already be durable.
    return attempted
      ? { id: action.id, status: 'uncertain', detail: 'Delivery could not be confirmed. Check the conversation before sending again.' }
      : { id: action.id, status: 'unsent', detail: 'The agent is busy or unavailable. Your input is saved; retry when it is ready.' };
  }
}

/**
 * Claims this plugin's queued input once a second and acknowledges each outcome. Nothing is resubmitted automatically.
 * `projectRoot` lets this instance take over the project's conversations from an instance that stopped (an OpenCode restart).
 */
export function startWorker(deliver: (job: DeliveryJob) => Promise<DeliveryResult>, config: Connection, owner: string, projectRoot?: string): () => void {
  let stopped = false, working = false;
  async function tick() {
    if (stopped || working) return;
    working = true;
    try {
      const job = await request<DeliveryJob | null>(config, '/agent/claim', { owner, ...(projectRoot ? { projectRoot } : {}) });
      if (job) await request(config, '/agent/ack', { owner, result: await deliver(job) });
    } catch { /* The service may be restarting. A claim that is never acknowledged becomes uncertain through its lease. */ }
    finally { working = false; }
  }
  const timer = setInterval(tick, 1000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

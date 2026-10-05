// -----------------------------------------------------------------------------
// worker/worker.js - claim loop. Holds NO secrets: it only knows WEB_URL and
// WORKER_TOKEN, pulls jobs from web (/internal/*) and pushes results back.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { processJob } from './pipeline.js';

const WEB_URL = (process.env.WEB_URL || 'http://web:3000').replace(/\/+$/, '');
const TOKEN = process.env.WORKER_TOKEN || '';
const ID = `w-${crypto.randomBytes(3).toString('hex')}`;
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), worker: ID, ...o }));

if (!TOKEN) {
  console.error('WORKER_TOKEN missing');
  process.exit(1);
}

export async function api(path, { method = 'POST', body, retries = 3 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(WEB_URL + path, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': body && !(typeof body === 'string') && !Buffer.isBuffer(body) ? 'application/json' : 'application/octet-stream' },
        body: body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status >= 500) throw new Error(`http ${res.status}`);
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, data: await res.json() };
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw last;
}

async function handle(job) {
  log({ ev: 'job', outputs: job.outputs.length });
  await processJob(job, {
    cfg: config,
    deliver: async (output, buf) => {
      await api(`/internal/jobs/${job.id}/result?output=${output}`, { body: buf });
    },
    fail: async (output, code) => {
      await api(`/internal/jobs/${job.id}/fail?output=${output}&code=${encodeURIComponent(code)}`);
    },
  });
  await api(`/internal/jobs/${job.id}/done`);
}

let stopping = false;
async function loop(n) {
  while (!stopping) {
    try {
      const r = await api('/internal/claim', { body: { workerId: `${ID}.${n}` } });
      if (r.ok && r.data.job) {
        await handle(r.data.job);
        continue;
      }
    } catch (e) {
      log({ level: 'warn', msg: 'claim_failed', err: String(e.message).slice(0, 120) });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    stopping = true;
    process.exit(0);
  });
}
log({ ev: 'started', concurrency: config.workerConcurrency });
await Promise.all(Array.from({ length: config.workerConcurrency }, (_, i) => loop(i)));

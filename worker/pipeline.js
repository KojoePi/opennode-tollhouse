// -----------------------------------------------------------------------------
// worker/pipeline.js - YOUR PRODUCT, worker side: one job in, one result (or a
// failure code) per requested output out.
//
//   job = { id, input, outputs: ['stats', 'text', ...] }
//
// Rules of the contract with the web app:
//   * deliver(output, buffer) the moment an output exists
//   * fail(output, code)      for anything that cannot be delivered; the web app
//                             refunds exactly that output. `code` is shown to the
//                             user via the i18n key `fail.<code>`
//   * nothing may stay pending: the safety net at the bottom fails leftovers
//   * the worker holds no secrets and no volume; results travel to web via HTTP
//
// Real products plug their heavy lifting into `engine` (injected, so this file
// stays unit-testable): a headless browser, ffmpeg, an ML model, an API client.
// To fetch URLs from the worker use fetchHttp-style code that validates every
// redirect hop with assertPublicHost() from ../src/security.js; the container's
// egress firewall (entrypoint.sh) is the second line of defence.
//
// The demo below needs no engine: it only shows the plumbing.
// -----------------------------------------------------------------------------

import { UserError } from '../src/security.js';

const code = (e) => (e instanceof UserError ? e.code : 'internal');

const demo = {
  stats: (input) => JSON.stringify({ chars: input.length, words: input.split(/\s+/).filter(Boolean).length, lines: input.split(/\r?\n/).length }, null, 2),
  text: (input) => input.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() + '\n',
};

export async function processJob(job, { engine = demo, cfg, deliver, fail }) {
  const pending = new Set(job.outputs);
  const ok = async (output, buf) => { if (!pending.delete(output)) return; await deliver(output, Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8')); };
  const bad = async (output, c) => { if (pending.delete(output)) await fail(output, c); };
  const failAll = async (c) => { for (const o of [...pending]) await bad(o, c); };

  const run = async () => {
    for (const o of job.outputs) {
      try {
        if (!engine[o]) throw new UserError('unsupported');
        await ok(o, await engine[o](job.input));
      } catch (e) {
        await bad(o, code(e));
      }
    }
  };

  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), cfg.jobTimeoutSeconds * 1000); });
  try {
    const r = await Promise.race([run().then(() => 'done'), timeout]);
    if (r === 'timeout') await failAll('timeout');
  } catch (e) {
    await failAll(code(e));
  } finally {
    clearTimeout(timer);
  }
  await failAll('internal'); // safety net: nothing may stay pending
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { processJob } from '../worker/pipeline.js';
import { UserError } from '../src/security.js';

const cfg = { jobTimeoutSeconds: 1 };
const run = async (job, engine) => {
  const delivered = {}; const failed = {};
  await processJob(job, { engine, cfg, deliver: async (o, b) => { delivered[o] = b.toString(); }, fail: async (o, c) => { failed[o] = c; } });
  return { delivered, failed };
};

test('demo pipeline delivers every requested output', async () => {
  const { delivered, failed } = await run({ id: 'j', input: 'a  b\n\n\n\nc', outputs: ['stats', 'text'] });
  assert.deepEqual(failed, {});
  assert.deepEqual(JSON.parse(delivered.stats), { chars: 9, words: 3, lines: 5 });
  assert.equal(delivered.text, 'a b\n\nc\n');
});

test('one failing output does not affect the others; codes are passed through', async () => {
  const engine = { stats: () => { throw new UserError('too_large'); }, text: (i) => i.toUpperCase() };
  const { delivered, failed } = await run({ id: 'j', input: 'x', outputs: ['stats', 'text'] }, engine);
  assert.equal(delivered.text, 'X');
  assert.deepEqual(failed, { stats: 'too_large' });
});

test('unknown outputs and unexpected errors become failures, nothing stays pending', async () => {
  const engine = { stats: () => { throw new Error('boom'); } };
  const { delivered, failed } = await run({ id: 'j', input: 'x', outputs: ['stats', 'text'] }, engine);
  assert.deepEqual(delivered, {});
  assert.deepEqual(failed, { stats: 'internal', text: 'unsupported' });
});

test('a hanging engine hits the job timeout and is reported', async () => {
  const engine = { stats: () => new Promise(() => {}), text: () => 'never' };
  const { delivered, failed } = await run({ id: 'j', input: 'x', outputs: ['stats', 'text'] }, engine);
  assert.deepEqual(delivered, {});
  assert.deepEqual(failed, { stats: 'timeout', text: 'timeout' });
});

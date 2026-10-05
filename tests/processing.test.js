import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/platform/db.js';
import { WalletService, InsufficientFunds } from '../src/platform/wallet.js';
import { SessionService } from '../src/platform/identity.js';
import { ProcessingService, StorageService, PRODUCT_SCHEMA } from '../src/product/processing.js';
import { priceTable, normalizeOutputs, totalMilli } from '../src/product/pricing.js';
import { validateInput } from '../src/product/input.js';
import { config } from '../src/config.js';

const setup = (over = {}) => {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const db = openDatabase(':memory:');
  db.exec(PRODUCT_SCHEMA);
  const wallets = new WalletService(db, { now: clock.now });
  const sessions = new SessionService(db, { pepper: 'test-pepper-0123456789', now: clock.now });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-'));
  const storage = new StorageService(dir);
  const prices = priceTable(config.pricing);
  const svc = new ProcessingService(db, wallets, storage, { prices, now: clock.now, ...over });
  const u = sessions.createAnonymous();
  wallets.credit(u.walletId, 100_000, { refType: 'payment', refId: 'p', eurCents: 100 });
  return { db, wallets, svc, u, clock, storage, prices };
};
const mk = (s, outputs) => s.svc.createJob({ userId: s.u.userId, walletId: s.u.walletId, input: 'secret user text', label: 'text-16', outputs });

test('pricing: default table, sums, selection normalising', () => {
  const p = priceTable(config.pricing);
  assert.deepEqual(p, { stats: 500, text: 1000 });
  assert.equal(totalMilli(p, ['stats', 'text']), 1500);
  assert.deepEqual(normalizeOutputs(['text', 'bogus', 'stats', 'text']), ['stats', 'text']);
  assert.deepEqual(normalizeOutputs('x'), []);
});

test('input: validated before charging', () => {
  assert.deepEqual(validateInput('  hello  '), { input: 'hello', label: 'text-5' });
  assert.throws(() => validateInput(''), /bad_input/);
  assert.throws(() => validateInput(42), /bad_input/);
  assert.throws(() => validateInput('x'.repeat(5000)), /input_too_long/);
});

test('job: charges the sum; ledger keeps only the label, never the input', () => {
  const s = setup();
  const job = mk(s, ['stats', 'text']);
  assert.equal(job.status, 'queued');
  assert.equal(s.wallets.balance(s.u.walletId), 100_000 - 1500);
  const ledger = JSON.stringify(s.wallets.listTransactions(s.u.walletId));
  assert.ok(!ledger.includes('secret user text'));
  assert.ok(ledger.includes('text-16'));
});

test('job: insufficient funds -> nothing charged, nothing queued', () => {
  const s = setup();
  s.wallets.debit(s.u.walletId, 99_500, { refType: 'x', refId: 'drain' });
  assert.throws(() => mk(s, ['text']), InsufficientFunds);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM processing_jobs').get().n, 0);
  assert.equal(s.wallets.balance(s.u.walletId), 500);
});

test('job: empty selection and full queue rejected', () => {
  const s = setup({ maxQueued: 1 });
  assert.throws(() => mk(s, []), /no_output/);
  mk(s, ['text']);
  assert.throws(() => mk(s, ['text']), /busy/);
  assert.equal(s.wallets.balance(s.u.walletId), 99_000);
});

test('happy path: claim -> results -> finish -> completed, files downloadable', () => {
  const s = setup();
  const job = mk(s, ['text', 'stats']);
  const c = s.svc.claim('w1');
  assert.equal(c.id, job.id);
  assert.equal(c.input, 'secret user text');
  assert.deepEqual(c.outputs.sort(), ['stats', 'text']);
  assert.equal(s.svc.claim('w2'), null);
  s.svc.saveResult(job.id, 'text', Buffer.from('hello'));
  s.svc.saveResult(job.id, 'stats', Buffer.from('{"chars":5}'));
  s.svc.finish(job.id);
  const v = s.svc.getJob(job.id, s.u.userId);
  assert.equal(v.status, 'completed');
  assert.equal(v.label, 'text-16');
  assert.ok(v.results.every((r) => r.status === 'done' && !r.refunded));
  const f = s.svc.getFile(v.results.find((r) => r.output === 'text').id, s.u.userId);
  assert.equal(f.buf.toString(), 'hello');
  assert.equal(f.filename, 'text-16-text.txt');
  assert.equal(s.wallets.balance(s.u.walletId), 100_000 - 1500);
});

test('partial failure: only the undelivered output is refunded', () => {
  const s = setup();
  const job = mk(s, ['stats', 'text']);
  s.svc.claim('w');
  s.svc.saveResult(job.id, 'text', Buffer.from('ok'));
  s.svc.failOutput(job.id, 'stats', 'internal');
  s.svc.finish(job.id);
  const v = s.svc.getJob(job.id, s.u.userId);
  assert.equal(v.status, 'completed');
  assert.equal(v.results.find((r) => r.output === 'stats').refunded, true);
  assert.equal(s.wallets.balance(s.u.walletId), 100_000 - 1000);
  assert.ok(s.wallets.verifyLedger(s.u.walletId));
});

test('total failure: everything refunded; repeat calls never double refund', () => {
  const s = setup();
  const job = mk(s, ['stats', 'text']);
  s.svc.claim('w');
  s.svc.abort(job.id, 'internal');
  s.svc.abort(job.id, 'internal');
  s.svc.failOutput(job.id, 'text', 'x');
  s.svc.finish(job.id);
  assert.equal(s.svc.getJob(job.id, s.u.userId).status, 'refunded');
  assert.equal(s.wallets.balance(s.u.walletId), 100_000);
  assert.ok(s.wallets.verifyLedger(s.u.walletId));
});

test('worker forgets an output at finish -> treated as undelivered and refunded', () => {
  const s = setup();
  const job = mk(s, ['stats', 'text']);
  s.svc.claim('w');
  s.svc.saveResult(job.id, 'text', Buffer.from('x'));
  s.svc.finish(job.id);
  assert.equal(s.wallets.balance(s.u.walletId), 100_000 - 1000);
});

test('oversized / empty result is refunded, not stored', () => {
  const s = setup({ maxResultBytes: 10 });
  const job = mk(s, ['stats', 'text']);
  s.svc.claim('w');
  s.svc.saveResult(job.id, 'stats', Buffer.alloc(11));
  s.svc.saveResult(job.id, 'text', Buffer.alloc(0));
  s.svc.finish(job.id);
  assert.equal(s.svc.getJob(job.id, s.u.userId).status, 'refunded');
  assert.equal(s.wallets.balance(s.u.walletId), 100_000);
});

test('lease: lost worker -> requeued, then refunded after max attempts', () => {
  const s = setup({ leaseMs: 1000, maxAttempts: 2 });
  const job = mk(s, ['text']);
  s.svc.claim('w1');
  s.clock.advance(2000);
  assert.equal(s.svc.claim('w2').id, job.id);
  s.clock.advance(2000);
  assert.equal(s.svc.claim('w3'), null);
  assert.equal(s.svc.getJob(job.id, s.u.userId).status, 'refunded');
  assert.equal(s.wallets.balance(s.u.walletId), 100_000);
});

test('late delivery on a finished job is rejected; results belong to their owner', () => {
  const s = setup();
  const job = mk(s, ['text']);
  s.svc.claim('w');
  s.svc.saveResult(job.id, 'text', Buffer.from('a'));
  s.svc.finish(job.id);
  assert.throws(() => s.svc.saveResult(job.id, 'text', Buffer.from('b')), /bad_job/);
  const rid = s.svc.getJob(job.id, s.u.userId).results[0].id;
  assert.equal(s.svc.getFile(rid, 'someone-else'), null);
  assert.equal(s.svc.getJob(job.id, 'someone-else'), null);
});

test('retention: purge removes job rows and files after expiry', () => {
  const s = setup({ retentionMs: 1000 });
  const job = mk(s, ['text']);
  s.svc.claim('w');
  s.svc.saveResult(job.id, 'text', Buffer.from('secret'));
  s.svc.finish(job.id);
  const rid = s.svc.getJob(job.id, s.u.userId).results[0].id;
  assert.ok(s.storage.exists(rid));
  s.clock.advance(1500);
  assert.equal(s.svc.getFile(rid, s.u.userId), null);
  assert.equal(s.svc.purge().jobs, 1);
  assert.ok(!s.storage.exists(rid));
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM processing_results').get().n, 0);
  assert.ok(s.wallets.verifyLedger(s.u.walletId));
});

test('label history is purged after 30 days, ledger rows stay', () => {
  const s = setup();
  mk(s, ['text']);
  s.clock.advance(31 * 86_400_000);
  assert.equal(s.wallets.purgeDomains(30), 1);
  const tx = s.wallets.listTransactions(s.u.walletId);
  assert.ok(tx.every((r) => !r.domain));
  assert.equal(tx.length, 2);
});

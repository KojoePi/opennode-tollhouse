import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/platform/db.js';
import { WalletService, InsufficientFunds } from '../src/platform/wallet.js';
import { SessionService, generateKey, normalizeKey } from '../src/platform/identity.js';
import { PaymentService } from '../src/platform/payments.js';
import { createOpenNode } from '../src/platform/opennode.js';
import { centsToMilli, creditForTopup } from '../src/platform/units.js';

const setup = () => {
  const db = openDatabase(':memory:');
  const sessions = new SessionService(db, { pepper: 'test-pepper-0123456789' });
  const wallets = new WalletService(db);
  return { db, sessions, wallets };
};

test('units: half cent and bonus', () => {
  assert.equal(centsToMilli(0.5), 500);
  assert.equal(centsToMilli(3), 3000);
  assert.deepEqual(creditForTopup(500), { baseMilli: 500000, bonusMilli: 0, totalMilli: 500000 });
  assert.deepEqual(creditForTopup(1000), { baseMilli: 1000000, bonusMilli: 100000, totalMilli: 1100000 });
  assert.equal(creditForTopup(25).totalMilli, 25000);
});

test('wallet: credit/debit, insufficient funds, ledger matches balance', () => {
  const { sessions, wallets } = setup();
  const { walletId } = sessions.createAnonymous();
  wallets.credit(walletId, 10_000, { refType: 'payment', refId: 'p1', eurCents: 10 });
  wallets.debit(walletId, 500, { refType: 'job-output', refId: 'j1:meta', label: 'stats', domain: 'example.com' });
  assert.equal(wallets.balance(walletId), 9500);
  assert.throws(() => wallets.debit(walletId, 99_999, { refType: 'job-output', refId: 'x' }), InsufficientFunds);
  assert.equal(wallets.balance(walletId), 9500);
  assert.ok(wallets.verifyLedger(walletId));
  const list = wallets.listTransactions(walletId);
  assert.equal(list[0].domain, 'example.com');
});

test('wallet: idempotent booking (no double debit/refund/credit)', () => {
  const { sessions, wallets } = setup();
  const { walletId } = sessions.createAnonymous();
  wallets.credit(walletId, 5000, { refType: 'payment', refId: 'p1', eurCents: 5 });
  assert.equal(wallets.credit(walletId, 5000, { refType: 'payment', refId: 'p1', eurCents: 5 }).duplicate, true);
  wallets.debit(walletId, 1000, { refType: 'job-output', refId: 'a' });
  wallets.debit(walletId, 1000, { refType: 'job-output', refId: 'a' });
  wallets.refund(walletId, 1000, { refType: 'job-output', refId: 'a' });
  wallets.refund(walletId, 1000, { refType: 'job-output', refId: 'a' });
  assert.equal(wallets.balance(walletId), 5000);
  assert.ok(wallets.verifyLedger(walletId));
});

test('wallet: debitMany is all-or-nothing', () => {
  const { sessions, wallets } = setup();
  const { walletId } = sessions.createAnonymous();
  wallets.credit(walletId, 2000, { refType: 'payment', refId: 'p', eurCents: 2 });
  assert.throws(
    () => wallets.debitMany(walletId, [{ amountMilli: 1500, refId: 'a' }, { amountMilli: 1500, refId: 'b' }]),
    InsufficientFunds
  );
  assert.equal(wallets.balance(walletId), 2000);
  assert.equal(wallets.listTransactions(walletId).length, 1);
});

test('ledger is immutable (UPDATE/DELETE rejected)', () => {
  const { db, sessions, wallets } = setup();
  const { walletId } = sessions.createAnonymous();
  wallets.credit(walletId, 1000, { refType: 'payment', refId: 'p', eurCents: 1 });
  assert.throws(() => db.prepare('UPDATE wallet_transactions SET amount_milli = 9999999').run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM wallet_transactions').run(), /immutable/);
});

test('wallet: balance can never go negative at DB level', () => {
  const { db, sessions } = setup();
  const { walletId } = sessions.createAnonymous();
  assert.throws(() => db.prepare('UPDATE wallets SET balance_milli = -1 WHERE id = ?').run(walletId));
});

test('sessions: anonymous creation, resolve, expiry, csrf, logout', () => {
  let now = 1_000_000;
  const db = openDatabase(':memory:');
  const s = new SessionService(db, { pepper: 'test-pepper-0123456789', sessionDays: 1, now: () => now });
  const a = s.createAnonymous();
  const r = s.resolve(a.token);
  assert.equal(r.userId, a.userId);
  assert.ok(s.checkCsrf(r, a.csrf));
  assert.ok(!s.checkCsrf(r, 'nope'));
  assert.equal(s.resolve('garbage'), null);
  // tokens are stored hashed
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE id_hash = ?').get(a.token).n, 0);
  s.logout(a.token);
  assert.equal(s.resolve(a.token), null);
  const b = s.createAnonymous();
  now += 2 * 86_400_000;
  assert.equal(s.resolve(b.token), null);
});

test('key: format, normalisation, hashed storage', () => {
  const k = generateKey();
  assert.match(k, /^KEY-([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);
  assert.equal(normalizeKey(k.toLowerCase().replaceAll('-', ' ')), k);
  assert.equal(normalizeKey('KEY-1234'), null);
  const { db, sessions } = setup();
  const a = sessions.createAnonymous();
  const key = sessions.createKey(a.userId);
  const row = db.prepare('SELECT key_hash FROM users WHERE id = ?').get(a.userId);
  assert.notEqual(row.key_hash, key);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM users').all()).includes(key));
});

test('key login merges a guest wallet with balance, rotates session', () => {
  const { sessions, wallets } = setup();
  const owner = sessions.createAnonymous();
  const key = sessions.createKey(owner.userId);
  wallets.credit(owner.walletId, 3000, { refType: 'payment', refId: 'o', eurCents: 3 });

  const guest = sessions.createAnonymous();
  wallets.credit(guest.walletId, 7000, { refType: 'payment', refId: 'g', eurCents: 7 });
  const cur = sessions.resolve(guest.token);
  const res = sessions.loginWithKey(key, cur, guest.token);
  assert.equal(res.userId, owner.userId);
  assert.equal(res.merged, 7000);
  assert.equal(wallets.balance(owner.walletId), 10_000);
  assert.equal(wallets.balance(guest.walletId), 0);
  assert.ok(wallets.verifyLedger(owner.walletId) && wallets.verifyLedger(guest.walletId));
  assert.equal(sessions.resolve(guest.token), null); // old session gone
  assert.notEqual(res.token, guest.token);
  assert.equal(sessions.resolve(res.token).userId, owner.userId);
});

test('key login: wrong key rejected; pristine guest removed', () => {
  const { db, sessions } = setup();
  const owner = sessions.createAnonymous();
  const key = sessions.createKey(owner.userId);
  const guest = sessions.createAnonymous();
  assert.throws(() => sessions.loginWithKey('KEY-AAAA-AAAA-AAAA-AAAA-AAAA', sessions.resolve(guest.token), guest.token), /bad_key/);
  assert.throws(() => sessions.loginWithKey('x', null), /bad_key/);
  sessions.loginWithKey(key, sessions.resolve(guest.token), guest.token);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(guest.userId).n, 0);
});

// --- payments ---------------------------------------------------------------
const paySetup = () => {
  const ctx = setup();
  const provider = createOpenNode({ apiKey: 'k', baseUrl: 'http://localhost:3000', mock: true });
  const payments = new PaymentService(ctx.db, provider);
  return { ...ctx, provider, payments };
};

test('payments: limits and bonus quote', async () => {
  const { payments } = paySetup();
  assert.throws(() => payments.quote(24), /amount_too_low/);
  assert.throws(() => payments.quote(2501), /amount_too_high/);
  assert.throws(() => payments.quote(1.5), /amount_too_low/);
  assert.equal(payments.quote(25).totalMilli, 25_000);
  assert.equal(payments.quote(2500).bonusMilli, 250_000);
  assert.equal(payments.quote(999).bonusMilli, 0);
  assert.equal(payments.quote(1000).bonusMilli, 100_000);
});

test('payments: pay -> poll credits exactly once (idempotent settle)', async () => {
  const { sessions, wallets, payments, provider, db } = paySetup();
  const { walletId } = sessions.createAnonymous();
  const p = await payments.createTopup(walletId, 1000);
  assert.equal(p.status, 'pending');
  assert.ok(p.bolt11.startsWith('lnbc'));
  const chargeId = db.prepare('SELECT charge_id FROM payments WHERE id = ?').get(p.id).charge_id;
  provider.mockMarkPaid(chargeId);
  // Webhook + poll + webhook replay
  await payments.handleWebhook({ id: chargeId, hashed_order: 'x' });
  await payments.handleWebhook({ id: chargeId, hashed_order: 'x' });
  payments.settle(p.id);
  assert.equal(wallets.balance(walletId), 1_100_000);
  assert.equal(wallets.listTopups(walletId).length, 1);
  assert.equal(wallets.listTopups(walletId)[0].eur_cents, 1000);
  assert.ok(wallets.verifyLedger(walletId));
});

test('payments: unpaid stays pending; bad signature rejected (non-mock)', async () => {
  const ctx = setup();
  const provider = createOpenNode({ apiKey: 'secret', baseUrl: 'https://x', mock: false, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ data: { status: 'unpaid' } }) }) });
  const payments = new PaymentService(ctx.db, provider);
  await assert.rejects(payments.handleWebhook({ id: 'c1', hashed_order: 'bad' }), /bad_signature/);
  const crypto = await import('node:crypto');
  const good = crypto.createHmac('sha256', 'secret').update('c1').digest('hex');
  assert.ok(provider.verifyWebhook('c1', good));
  assert.ok(!provider.verifyWebhook('c1', good.slice(0, -1) + '0'));
});

test('payments: poll only for own wallet; too many pending', async () => {
  const { sessions, payments } = paySetup();
  const a = sessions.createAnonymous();
  const b = sessions.createAnonymous();
  const p = await payments.createTopup(a.walletId, 100);
  await assert.rejects(payments.poll(p.id, b.walletId), /not_found/);
  for (let i = 0; i < 4; i++) await payments.createTopup(a.walletId, 100);
  await assert.rejects(payments.createTopup(a.walletId, 100), /too_many_pending/);
});

test('payments: provider failure does not create a payment row', async () => {
  const ctx = setup();
  const provider = { createCharge: async () => { throw new Error('boom'); } };
  const payments = new PaymentService(ctx.db, provider);
  const { walletId } = ctx.sessions.createAnonymous();
  await assert.rejects(payments.createTopup(walletId, 500), /payment_unavailable/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0);
});

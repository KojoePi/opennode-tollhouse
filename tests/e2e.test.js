import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { processJob } from '../worker/pipeline.js';
import { reset } from '../src/ratelimit.js';

const TOKEN = 'w'.repeat(40);

async function boot(over = {}) {
  reset();
  const cfg = { ...config, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wpe-')), keyPepper: 'pepper-pepper-pepper-123456', workerToken: TOKEN, opennodeMock: true, domain: 'localhost', baseUrl: 'http://localhost:3000', trustProxy: false, secureCookies: false, ...over };
  const app = createApp(cfg);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    const jar = { cookie: '', csrf: '' };
    const call = async (method, p, body, extra = {}) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(jar.cookie ? { Cookie: jar.cookie } : {}), ...(jar.csrf ? { 'X-CSRF-Token': jar.csrf } : {}), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = res.headers.get('set-cookie');
      if (sc) jar.cookie = sc.split(';')[0];
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json() : await res.text();
      return { status: res.status, data, headers: res.headers };
    };
    jar.call = call;
    jar.init = async () => { const r = await call('GET', '/api/me'); jar.csrf = r.data.csrf; return r; };
    return jar;
  };
  // Stand-in for the worker process: claim, run the pipeline with a fake engine, post results.
  const runWorker = async (engine) => {
    const w = await fetch(base + '/internal/claim', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{"workerId":"t"}' });
    const { job } = await w.json();
    if (!job) return null;
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body });
    await processJob(job, {
      engine, cfg,
      deliver: (o, buf) => post(`/internal/jobs/${job.id}/result?output=${o}`, buf),
      fail: (o, c) => post(`/internal/jobs/${job.id}/fail?output=${o}&code=${c}`),
    });
    await post(`/internal/jobs/${job.id}/done`);
    return job;
  };
  return { app, cfg, base, client, runWorker, close: () => app.close() };
}

const engine = (over = {}) => ({
  stats: (i) => JSON.stringify({ chars: i.length }),
  text: (i) => i.trim() + '\n',
  ...over,
});

const topup = async (c, eurCents) => {
  const r = await c.call('POST', '/api/topups', { eurCents });
  assert.equal(r.status, 201);
  return r.data.payment;
};
const pay = async (t, c, payment) => {
  // mock provider: webhook-less settle via dev route, then poll
  const p = t.app.payments.get(payment.id);
  await fetch(t.base + `/dev/pay/${payment.id}`);
  return p;
};

test('e2e: security headers, health, me, csrf required', async () => {
  const t = await boot();
  try {
    const c = t.client();
    const h = await c.call('GET', '/health');
    assert.equal(h.status, 200);
    assert.match(h.headers.get('content-security-policy'), /script-src 'self'/);
    const me = await c.init();
    assert.equal(me.data.balanceMilli, 0);
    assert.ok(c.cookie.includes(`${t.cfg.cookieName}=`));
    // cookie flags
    const raw = await fetch(t.base + '/api/me');
    assert.match(raw.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    // no csrf -> 403
    const noCsrf = await c.call('POST', '/api/jobs', { input: 'hello', outputs: ['stats'] }, { 'X-CSRF-Token': 'nope' });
    assert.equal(noCsrf.status, 403);
    // wrong origin -> 403
    const badOrigin = await c.call('POST', '/api/jobs', { input: 'hello', outputs: ['stats'] }, { Origin: 'https://evil.example' });
    assert.equal(badOrigin.status, 403);
  } finally { t.close(); }
});

test('e2e: internal API is closed without token / behind proxy', async () => {
  const t = await boot();
  try {
    assert.equal((await fetch(t.base + '/internal/claim', { method: 'POST' })).status, 404);
    assert.equal((await fetch(t.base + '/internal/claim', { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 404);
    assert.equal((await fetch(t.base + '/internal/claim', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'X-Forwarded-For': '1.2.3.4' } })).status, 404);
    assert.equal((await fetch(t.base + '/dev/nothing')).status, 404);
  } finally { t.close(); }
});

test('e2e: top-up with bonus, job, per-output refund, results, transactions, csv', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.init();
    const quote = await c.call('POST', '/api/topups/quote', { eurCents: 1000 });
    assert.equal(quote.data.bonusMilli, 100_000);
    assert.equal((await c.call('POST', '/api/topups', { eurCents: 10 })).status, 400); // below minimum
    assert.equal((await c.call('POST', '/api/topups', { eurCents: 2600 })).status, 400); // above maximum

    // no balance -> 402, nothing created
    const broke = await c.call('POST', '/api/jobs', { input: 'hello', outputs: ['text'] });
    assert.equal(broke.status, 402);

    const p = await topup(c, 1000);
    await pay(t, c, p);
    const after = await c.call('GET', `/api/topups/${p.id}`);
    assert.equal(after.data.payment.status, 'paid');
    assert.equal(after.data.balanceMilli, 1_100_000); // 1000 + 100 Aktionen
    assert.equal(after.data.hasTopup, true);
    await fetch(t.base + `/dev/pay/${p.id}`); // idempotent
    assert.equal((await c.call('GET', '/api/me')).data.balanceMilli, 1_100_000);

    // invalid input is rejected BEFORE charging
    assert.equal((await c.call('POST', '/api/jobs', { input: '   ', outputs: ['text'] })).status, 400);
    assert.equal((await c.call('POST', '/api/jobs', { input: 'hello', outputs: [] })).status, 400);
    assert.equal((await c.call('GET', '/api/me')).data.balanceMilli, 1_100_000);

    const created = await c.call('POST', '/api/jobs', { input: 'secret=1 hello world', outputs: ['stats', 'text'] });
    assert.equal(created.status, 201);
    assert.equal(created.data.balanceMilli, 1_100_000 - 1500);

    // worker: PDF fails -> only the PDF is refunded
    await t.runWorker(engine({ stats: () => { throw new Error('boom'); } }));
    const job = (await c.call('GET', `/api/jobs/${created.data.job.id}`)).data.job;
    assert.equal(job.status, 'completed');
    const by = Object.fromEntries(job.results.map((r) => [r.output, r]));
    assert.equal(by.text.status, 'done');
    assert.equal(by.stats.status, 'failed');
    assert.equal(by.stats.refunded, true);
    assert.equal((await c.call('GET', '/api/me')).data.balanceMilli, 1_100_000 - 1000);

    const md = await c.call('GET', `/api/results/${by.text.id}?dl=1`);
    assert.equal(md.status, 200);
    assert.match(md.data, /secret=1 hello world/);
    assert.match(md.headers.get('content-disposition'), /attachment; filename="text-20-text.txt"/);
    // other users cannot read it
    const other = t.client();
    await other.init();
    assert.equal((await other.call('GET', `/api/results/${by.text.id}`)).status, 404);
    assert.equal((await other.call('GET', `/api/jobs/${job.id}`)).status, 404);

    // ledger: short label only, never the input
    const tx = (await c.call('GET', '/api/transactions')).data.transactions;
    assert.ok(tx.some((x) => x.type === 'topup' && x.eur_cents === 1000));
    assert.ok(tx.some((x) => x.type === 'refund'));
    assert.ok(!JSON.stringify(tx).includes('secret'));
    assert.ok(tx.some((x) => x.domain === 'text-20'));
    const csv = (await c.call('GET', '/api/transactions/topups.csv')).data;
    assert.match(csv, /^date_utc,eur,aktionen_credited,payment_id\n.+,10\.00,1100,/);
    assert.equal(t.app.wallets.verifyLedger(t.app.sessions.resolve(c.cookie.split('=')[1]).walletId), true);
  } finally { t.close(); }
});

test('e2e: key creation needs a top-up; login merges guest balance; wrong key limited', async () => {
  const t = await boot();
  try {
    const a = t.client();
    await a.init();
    assert.equal((await a.call('POST', '/api/key', {})).status, 409); // nothing to protect yet
    await pay(t, a, await topup(a, 500));
    const key = (await a.call('POST', '/api/key', {})).data.key;
    assert.match(key, new RegExp(`^${t.cfg.keyPrefix}-([A-Z2-9]{4}-){4}[A-Z2-9]{4}$`));
    assert.equal((await a.call('POST', '/api/key', {})).status, 409); // not silently replaced

    // new device with a small guest balance
    const b = t.client();
    await b.init();
    await pay(t, b, await topup(b, 100));
    const login = await b.call('POST', '/api/login', { key: key.toLowerCase().replaceAll('-', ' ') });
    assert.equal(login.status, 200);
    assert.equal(login.data.mergedMilli, 100_000);
    assert.equal(login.data.balanceMilli, 600_000);
    b.csrf = login.data.csrf;
    assert.equal((await b.call('GET', '/api/me')).data.balanceMilli, 600_000);

    // bad keys: 400 and eventually 429
    const c = t.client();
    await c.init();
    let last;
    for (let i = 0; i < config.rateKeyAttemptsPerHourPerIp + 1; i++) last = await c.call('POST', '/api/login', { key: `${t.cfg.keyPrefix}-AAAA-AAAA-AAAA-AAAA-AAAA` });
    assert.equal(last.status, 429);

    // logout kills the session
    const out = await b.call('POST', '/api/logout', {});
    assert.equal(out.status, 200);
  } finally { t.close(); }
});

test('e2e: anonymous users get the stricter job rate limit', async () => {
  const t = await boot({ rateAnonJobsPerHour: 2 });
  try {
    const c = t.client();
    await c.init();
    await pay(t, c, await topup(c, 500));
    const go = () => c.call('POST', '/api/jobs', { input: 'hello', outputs: ['stats'] });
    assert.equal((await go()).status, 201);
    assert.equal((await go()).status, 201);
    assert.equal((await go()).status, 429);
  } finally { t.close(); }
});

test('e2e: lost worker -> lease expires, retries, finally everything refunded', async () => {
  const t = await boot({ maxJobAttempts: 2, jobLeaseSeconds: 1 });
  try {
    const c = t.client();
    await c.init();
    await pay(t, c, await topup(c, 100));
    const bal = (await c.call('GET', '/api/me')).data.balanceMilli;
    const created = await c.call('POST', '/api/jobs', { input: 'hello', outputs: ['text', 'stats'] });
    for (let i = 0; i < 2; i++) {
      const w = await fetch(t.base + '/internal/claim', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}' });
      assert.ok((await w.json()).job);
      await new Promise((r) => setTimeout(r, 1100)); // worker "dies"
      t.app.processing.reapLeases();
    }
    const job = (await c.call('GET', `/api/jobs/${created.data.job.id}`)).data.job;
    assert.equal(job.status, 'refunded');
    assert.equal((await c.call('GET', '/api/me')).data.balanceMilli, bal);
  } finally { t.close(); }
});

test('e2e: static pages are served with placeholders filled, traversal blocked', async () => {
  const t = await boot({ legal: { name: 'Acme <GmbH>', address: 'A', email: 'a@b.c', vatId: '' } });
  try {
    const res = await fetch(t.base + '/../../etc/passwd');
    assert.notEqual(res.status, 200);
    const enc = await fetch(t.base + '/%2e%2e/%2e%2e/etc/passwd');
    assert.notEqual(enc.status, 200);
  } finally { t.close(); }
});

test('e2e: legal pages are served with placeholders filled and escaped; sitemap; 404', async () => {
  const t = await boot({ legal: { name: 'Acme <GmbH>', address: 'Street 1', email: 'a@b.c', vatId: '' } });
  try {
    for (const p of ['/impressum', '/agb', '/datenschutz']) {
      const r = await fetch(t.base + p);
      assert.equal(r.status, 200, p);
      const html = await r.text();
      assert.ok(!/\{\{LEGAL_[A-Z_]+\}\}/.test(html), `${p}: all LEGAL placeholders substituted`);
    }
    const imp = await (await fetch(t.base + '/impressum')).text();
    assert.ok(!imp.includes('Acme <GmbH>'), 'never unescaped');
    const home = await (await fetch(t.base + '/')).text();
    assert.ok(!home.includes('{{BASE_URL}}'));
    const sm = await (await fetch(t.base + '/sitemap.xml')).text();
    assert.ok(sm.includes('http://localhost:3000/'));
    assert.equal((await fetch(t.base + '/does-not-exist')).status, 404);
  } finally { t.close(); }
});

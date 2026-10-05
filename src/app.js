// -----------------------------------------------------------------------------
// app.js - HTTP layer: static files, JSON API for the web UI, payment webhook and
// the worker-only /internal API. No public API, no API keys: everything the
// browser can do is tied to its session cookie (+ CSRF token for writes).
// -----------------------------------------------------------------------------

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './platform/db.js';
import { WalletService, InsufficientFunds } from './platform/wallet.js';
import { SessionService } from './platform/identity.js';
import { PaymentService } from './platform/payments.js';
import { createOpenNode } from './platform/opennode.js';
import { ProcessingService, StorageService, PRODUCT_SCHEMA } from './product/processing.js';
import { priceTable, normalizeOutputs, OUTPUTS } from './product/pricing.js';
import { validateInput } from './product/input.js';
import { UserError } from './security.js';
import { hit, sweep } from './ratelimit.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

export function createApp(cfg, { provider } = {}) {
  const db = openDatabase(path.join(cfg.dataDir, 'app.db'));
  db.exec(PRODUCT_SCHEMA);
  const now = () => Date.now();
  const wallets = new WalletService(db);
  const sessions = new SessionService(db, { pepper: cfg.keyPepper, sessionDays: cfg.sessionDays, keyPrefix: cfg.keyPrefix });
  const pay = provider || createOpenNode({ apiKey: cfg.opennodeApiKey, apiBase: cfg.opennodeApiBase, baseUrl: cfg.baseUrl, ttlMinutes: cfg.invoiceTtlMinutes, mock: cfg.opennodeMock });
  const payments = new PaymentService(db, pay, { minCents: cfg.topupMinCents, maxCents: cfg.topupMaxCents, bonusThresholdCents: cfg.bonusThresholdCents, bonusPercent: cfg.bonusPercent });
  const prices = priceTable(cfg.pricing);
  const storage = new StorageService(path.join(cfg.dataDir, 'results'));
  const processing = new ProcessingService(db, wallets, storage, {
    prices, retentionMs: cfg.resultRetentionHours * 3_600_000, leaseMs: cfg.jobLeaseSeconds * 1000, maxAttempts: cfg.maxJobAttempts,
    maxQueued: cfg.maxQueuedJobs, maxResultBytes: cfg.maxResultBytes,
  });
  const kvSet = (k, v) => db.prepare('INSERT INTO kv (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').run(k, v, now());
  const kvGet = (k) => db.prepare('SELECT v, updated_at FROM kv WHERE k = ?').get(k);

  // --- helpers -----------------------------------------------------------------
  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  const parseCookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));
  const cookieHeader = (token, maxAgeSec) =>
    `${cfg.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${cfg.secureCookies ? '; Secure' : ''}`;

  const send = (res, status, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const isStr = typeof body === 'string';
    const data = isBuf || isStr ? body : JSON.stringify(body);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': isBuf || isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(data);
  };

  const readBody = (req, maxBytes) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          reject(new UserError('too_large', 'too_large', 413));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  const readJson = async (req, max = 16 * 1024) => {
    const buf = await readBody(req, max);
    if (!buf.length) return {};
    try {
      const v = JSON.parse(buf.toString('utf8'));
      return v && typeof v === 'object' ? v : {};
    } catch {
      throw new UserError('bad_request');
    }
  };

  /** Session from the cookie (null when missing/invalid). */
  const getSession = (req) => {
    const token = parseCookies(req)[cfg.cookieName];
    const s = sessions.resolve(token);
    return s ? { ...s, token } : null;
  };

  /** Session, created on demand (first visit). */
  const ensureSession = (req, res) => {
    const s = getSession(req);
    if (s) return s;
    if (!hit(`newsess:${clientIp(req)}`, cfg.rateSessionsPerHourPerIp, 3_600_000)) throw new UserError('rate_limited', 'rate_limited', 429);
    const a = sessions.createAnonymous();
    res.setHeader('Set-Cookie', cookieHeader(a.token, a.maxAgeSec));
    return { userId: a.userId, walletId: a.walletId, csrf: a.csrf, hasKey: false, token: a.token };
  };

  /** Writes need: session + matching CSRF header + same-origin (when the browser sends Origin). */
  const requireWrite = (req, res) => {
    const origin = req.headers.origin;
    if (origin && origin !== cfg.baseUrl && !(cfg.domain === 'localhost' && /^http:\/\/localhost(:\d+)?$/.test(origin))) throw new UserError('forbidden', 'forbidden', 403);
    const s = getSession(req);
    if (!s || !sessions.checkCsrf(s, req.headers['x-csrf-token'])) throw new UserError('csrf', 'csrf', 403);
    return s;
  };

  const me = (s) => ({
    balanceMilli: wallets.balance(s.walletId),
    hasKey: s.hasKey,
    hasTopup: !!db.prepare("SELECT 1 FROM wallet_transactions WHERE wallet_id = ? AND type = 'topup' LIMIT 1").get(s.walletId),
    csrf: s.csrf,
  });

  const workerAuth = (req) => {
    if (req.headers['x-forwarded-for']) return false; // came through the proxy = from the internet
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(cfg.workerToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // --- routing ---------------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, pattern });
  };

  route('GET', '/health', async (req, res) => send(res, 200, { ok: true }));
  route('GET', '/ready', async (req, res) => {
    db.prepare('SELECT 1').get();
    const w = kvGet('worker_seen');
    send(res, 200, { ok: true, worker: !!w && now() - w.updated_at < 60_000 });
  });

  route('GET', '/api/config', async (req, res) =>
    send(res, 200, {
      prices: prices, outputs: OUTPUTS,
      topup: { minCents: cfg.topupMinCents, maxCents: cfg.topupMaxCents, presets: [100, 200, 500, 1000], bonusThresholdCents: cfg.bonusThresholdCents, bonusPercent: cfg.bonusPercent },
      retentionHours: cfg.resultRetentionHours, mock: cfg.opennodeMock,
    }, { 'Cache-Control': 'public, max-age=300' }));

  route('GET', '/api/me', async (req, res) => {
    const s = ensureSession(req, res);
    send(res, 200, me(s));
  });

  route('POST', '/api/jobs', async (req, res) => {
    const s = requireWrite(req, res);
    const body = await readJson(req);
    const outputs = normalizeOutputs(body.outputs);
    if (!outputs.length) throw new UserError('no_output');
    const limit = s.hasKey ? cfg.rateUserJobsPerHour : cfg.rateAnonJobsPerHour;
    if (!hit(`jobs:${s.userId}`, limit, 3_600_000) || !hit(`jobsip:${clientIp(req)}`, limit * 2, 3_600_000)) throw new UserError('rate_limited', 'rate_limited', 429);
    // Reject invalid input BEFORE charging.
    const { input, label } = validateInput(body.input);
    const job = processing.createJob({ userId: s.userId, walletId: s.walletId, input, label, outputs });
    log({ ev: 'job_created', outputs: outputs.length });
    send(res, 201, { job, balanceMilli: wallets.balance(s.walletId) });
  });

  route('GET', '/api/jobs', async (req, res) => {
    const s = getSession(req);
    send(res, 200, { jobs: s ? processing.listJobs(s.userId) : [], balanceMilli: s ? wallets.balance(s.walletId) : 0 });
  });
  route('GET', '/api/jobs/:id', async (req, res, p) => {
    const s = getSession(req);
    const job = s && processing.getJob(p.id, s.userId);
    if (!job) throw new UserError('not_found', 'not_found', 404);
    send(res, 200, { job, balanceMilli: wallets.balance(s.walletId) });
  });
  route('GET', '/api/results/:id', async (req, res, p, url) => {
    const s = getSession(req);
    const f = s && processing.getFile(p.id, s.userId);
    if (!f) throw new UserError('not_found', 'not_found', 404);
    const dl = url.searchParams.get('dl') === '1';
    const type = f.mime.startsWith('text/html') ? 'text/plain; charset=utf-8' : f.mime; // never render fetched HTML on our origin
    send(res, 200, f.buf, {
      'Content-Type': dl && !f.mime.startsWith('text/html') ? f.mime : type,
      'Content-Disposition': `${dl ? 'attachment' : 'inline'}; filename="${f.filename.replace(/[^\w.-]/g, '_')}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
  });

  route('POST', '/api/topups/quote', async (req, res) => {
    const body = await readJson(req);
    send(res, 200, payments.quote(Number(body.eurCents)));
  });
  route('POST', '/api/topups', async (req, res) => {
    const s = requireWrite(req, res);
    if (!hit(`topup:${s.userId}`, cfg.rateTopupsPerHour, 3_600_000)) throw new UserError('rate_limited', 'rate_limited', 429);
    const body = await readJson(req);
    const p = await payments.createTopup(s.walletId, Number(body.eurCents));
    log({ ev: 'topup_created', eurCents: p.eurCents });
    send(res, 201, { payment: p });
  });
  route('GET', '/api/topups/:id', async (req, res, p) => {
    const s = getSession(req);
    if (!s) throw new UserError('not_found', 'not_found', 404);
    const payment = await payments.poll(p.id, s.walletId);
    send(res, 200, { payment, ...me(s) });
  });

  // OpenNode webhook: body is form-encoded (or JSON); never trusted without signature + status re-check.
  route('POST', '/opennode_webhook', async (req, res) => {
    const raw = (await readBody(req, 64 * 1024)).toString('utf8');
    let data;
    try {
      data = raw.trim().startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    } catch {
      throw new UserError('bad_request');
    }
    const r = await payments.handleWebhook(data);
    log({ ev: 'webhook', status: r.status || (r.ignored ? 'ignored' : 'ok') });
    send(res, 200, { ok: true });
  });

  route('POST', '/api/key', async (req, res) => {
    const s = requireWrite(req, res);
    const body = await readJson(req);
    const m = me(s);
    if (!m.hasTopup) throw new UserError('no_topup_yet', 'no_topup_yet', 409);
    if (s.hasKey && body.replace !== true) throw new UserError('key_exists', 'key_exists', 409);
    const key = sessions.createKey(s.userId);
    log({ ev: 'key_created' });
    send(res, 200, { key });
  });

  route('POST', '/api/login', async (req, res) => {
    const origin = req.headers.origin;
    if (origin && origin !== cfg.baseUrl && !(cfg.domain === 'localhost' && /^http:\/\/localhost(:\d+)?$/.test(origin))) throw new UserError('forbidden', 'forbidden', 403);
    if (!hit(`key:${clientIp(req)}`, cfg.rateKeyAttemptsPerHourPerIp, 3_600_000)) throw new UserError('rate_limited', 'rate_limited', 429);
    const cur = getSession(req);
    if (cur && !sessions.checkCsrf(cur, req.headers['x-csrf-token'])) throw new UserError('csrf', 'csrf', 403);
    const body = await readJson(req);
    const r = sessions.loginWithKey(body.key, cur, cur?.token);
    res.setHeader('Set-Cookie', cookieHeader(r.token, r.maxAgeSec));
    log({ ev: 'key_login', merged: r.merged > 0 });
    send(res, 200, { mergedMilli: r.merged, balanceMilli: wallets.balance(r.walletId), csrf: r.csrf, hasKey: true });
  });

  route('POST', '/api/logout', async (req, res) => {
    const s = requireWrite(req, res);
    sessions.logout(s.token);
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    send(res, 200, { ok: true });
  });

  route('GET', '/api/transactions', async (req, res, p, url) => {
    const s = getSession(req);
    if (!s) return send(res, 200, { transactions: [] });
    const before = Number(url.searchParams.get('before')) || null;
    send(res, 200, { transactions: wallets.listTransactions(s.walletId, { limit: 50, before }) });
  });

  route('GET', '/api/transactions/topups.csv', async (req, res) => {
    const s = getSession(req);
    if (!s) throw new UserError('not_found', 'not_found', 404);
    const rows = wallets.listTopups(s.walletId);
    const csv = ['date_utc,eur,aktionen_credited,payment_id', ...rows.map((r) => `${new Date(r.created_at).toISOString()},${(r.eur_cents / 100).toFixed(2)},${r.amount_milli / 1000},${r.payment_id}`)].join('\n') + '\n';
    send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${cfg.projectName}-topups.csv"` });
  });

  // Local testing only (OPENNODE_MOCK=1, DOMAIN=localhost): pretend the invoice was paid.
  route('GET', '/dev/pay/:id', async (req, res, p) => {
    if (!cfg.opennodeMock || cfg.domain !== 'localhost') throw new UserError('not_found', 'not_found', 404);
    const pay1 = payments.get(p.id);
    if (!pay1) throw new UserError('not_found', 'not_found', 404);
    pay.mockMarkPaid(pay1.charge_id);
    payments.settle(pay1.id);
    send(res, 200, 'paid (mock)');
  });

  // --- worker API (Bearer token, never reachable through the proxy) -----------------
  const internal = (method, pattern, handler) =>
    route(method, pattern, async (req, res, p, url) => {
      if (!workerAuth(req)) throw new UserError('not_found', 'not_found', 404);
      return handler(req, res, p, url);
    });
  internal('POST', '/internal/claim', async (req, res) => {
    const body = await readJson(req, 1024);
    kvSet('worker_seen', String(body.workerId || 'w').slice(0, 40));
    const job = processing.claim(String(body.workerId || 'w').slice(0, 40));
    send(res, 200, { job });
  });
  internal('POST', '/internal/jobs/:id/result', async (req, res, p, url) => {
    const output = url.searchParams.get('output');
    if (!OUTPUTS.includes(output)) throw new UserError('bad_request');
    const buf = await readBody(req, cfg.maxResultBytes + 1);
    processing.saveResult(p.id, output, buf);
    send(res, 200, { ok: true });
  });
  internal('POST', '/internal/jobs/:id/fail', async (req, res, p, url) => {
    const output = url.searchParams.get('output');
    if (!OUTPUTS.includes(output)) throw new UserError('bad_request');
    processing.failOutput(p.id, output, url.searchParams.get('code') || 'internal');
    send(res, 200, { ok: true });
  });
  internal('POST', '/internal/jobs/:id/done', async (req, res, p) => {
    processing.finish(p.id);
    send(res, 200, { ok: true });
  });

  // --- static files ---------------------------------------------------------------------
  const legalVars = { LEGAL_NAME: cfg.legal.name, LEGAL_ADDRESS: cfg.legal.address, LEGAL_EMAIL: cfg.legal.email, LEGAL_VAT_ID: cfg.legal.vatId, DOMAIN: cfg.domain, BASE_URL: cfg.baseUrl,
    RETENTION_HOURS: String(cfg.resultRetentionHours), TOPUP_MIN: (cfg.topupMinCents / 100).toFixed(2), TOPUP_MAX: (cfg.topupMaxCents / 100).toFixed(2), BONUS_PERCENT: String(cfg.bonusPercent), BONUS_FROM: (cfg.bonusThresholdCents / 100).toFixed(0) };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const PAGES = new Map([['/', 'index.html'], ['/agb', 'agb.html'], ['/datenschutz', 'datenschutz.html'], ['/impressum', 'impressum.html']]);

  const serveStatic = (req, res, pathname) => {
    let rel = PAGES.get(pathname.replace(/\/+$/, '') || '/') || decodeURIComponent(pathname).replace(/^\/+/, '');
    let file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
    // Pretty URLs: /foo -> foo.html, /foo/ -> foo/index.html
    if (!path.extname(file)) for (const c of [`${file}.html`, path.join(file, 'index.html')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) { file = c; break; }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const ext = path.extname(file).toLowerCase();
    if (!MIME[ext] || path.basename(file).startsWith('.')) return false;
    let body = fs.readFileSync(file);
    if (ext === '.html' || ext === '.txt' || ext === '.xml') body = Buffer.from(body.toString('utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => (k in legalVars ? esc(legalVars[k]) : `{{${k}}}`)));
    res.writeHead(200, {
      ...SECURITY_HEADERS, 'Content-Type': MIME[ext],
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };

  // --- server ---------------------------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const started = now();
    const url = new URL(req.url, 'http://x');
    let matched = 'static';
    try {
      if (url.pathname.startsWith('/internal/') && req.headers['x-forwarded-for']) return send(res, 404, { code: 'not_found' });
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        matched = r.pattern;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        await r.handler(req, res, params, url);
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;
      const nf = path.join(PUBLIC_DIR, '404.html');
      if (req.method === 'GET' && fs.existsSync(nf) && !url.pathname.startsWith('/api/')) {
        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': MIME['.html'] });
        return res.end(fs.readFileSync(nf));
      }
      send(res, 404, { code: 'not_found' });
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof InsufficientFunds) return send(res, 402, { code: 'insufficient_funds', neededMilli: e.needed, balanceMilli: e.available });
      if (e.code && e.status) return send(res, e.status, { code: e.code });
      if (e.code === 'bad_key') return send(res, 400, { code: 'bad_key' });
      log({ level: 'error', msg: 'unhandled', route: matched, err: String(e.message).slice(0, 200) });
      send(res, 500, { code: 'internal' });
    } finally {
      if (!matched.startsWith('static')) log({ ev: 'req', m: req.method, r: matched, s: res.statusCode, ms: now() - started });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;

  // --- housekeeping ------------------------------------------------------------------------------
  const housekeeping = () => {
    try {
      processing.reapLeases();
      const a = processing.purge();
      payments.expireStale();
      sessions.purge();
      wallets.purgeDomains(cfg.domainHistoryDays);
      sweep();
      if (a.jobs) log({ ev: 'purged', jobs: a.jobs });
    } catch (e) {
      log({ level: 'error', msg: 'housekeeping', err: e.message });
    }
  };
  const backup = () => {
    try {
      const dir = path.join(cfg.dataDir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `app-${new Date().toISOString().slice(0, 10)}.db`);
      if (!fs.existsSync(f)) db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
      const old = fs.readdirSync(dir).filter((n) => n.endsWith('.db')).sort().slice(0, -7);
      for (const n of old) fs.rmSync(path.join(dir, n));
    } catch (e) {
      log({ level: 'error', msg: 'backup', err: e.message });
    }
  };
  const timers = [];
  return {
    server, db, wallets, sessions, payments, processing, storage, prices, housekeeping, backup,
    startTimers() {
      timers.push(setInterval(housekeeping, 5 * 60_000), setInterval(backup, 6 * 3_600_000));
      setTimeout(backup, 5000).unref?.();
      timers.forEach((t) => t.unref?.());
    },
    close() {
      timers.forEach(clearInterval);
      server.close();
      server.closeAllConnections?.();
      db.close();
    },
  };
}

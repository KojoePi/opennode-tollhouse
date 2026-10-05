// -----------------------------------------------------------------------------
// product/processing.js - ProcessingService + StorageService.
//
// Lifecycle of a job:  queued -> processing -> completed | refunded
//   * createJob charges the wallet for ALL chosen outputs up front (atomically,
//     together with inserting the job). Invalid input must be rejected BEFORE.
//   * the worker claims a job (lease), delivers each output or reports a failure
//   * every output that is not delivered is refunded individually (idempotent)
//   * a job with no delivered output ends as "refunded"
//   * results + job rows disappear after the retention period
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tx } from '../platform/db.js';
import { UserError } from '../security.js';
import { FILE_INFO, OUTPUTS } from './pricing.js';

export const PRODUCT_SCHEMA = `
CREATE TABLE IF NOT EXISTS processing_jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id   TEXT NOT NULL REFERENCES wallets(id),
  input       TEXT NOT NULL,
  label       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued','processing','completed','failed','refunded')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  worker_id   TEXT,
  cost_milli  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON processing_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user   ON processing_jobs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_exp    ON processing_jobs(expires_at);

CREATE TABLE IF NOT EXISTS processing_results (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  output      TEXT NOT NULL,
  price_milli INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  filename    TEXT,
  bytes       INTEGER,
  error       TEXT,
  refunded    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (job_id, output)
);
CREATE INDEX IF NOT EXISTS idx_results_job ON processing_results(job_id);
`;

export class StorageService {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  #file(id) {
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) throw new Error('bad_id');
    return path.join(this.dir, id);
  }
  save(id, buf) {
    fs.writeFileSync(this.#file(id), buf, { mode: 0o600 });
  }
  read(id) {
    return fs.readFileSync(this.#file(id));
  }
  remove(id) {
    fs.rmSync(this.#file(id), { force: true });
  }
  exists(id) {
    return fs.existsSync(this.#file(id));
  }
  /** Delete files that no result row references (crash leftovers). */
  sweepOrphans(knownIds) {
    let n = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!knownIds.has(f)) {
        fs.rmSync(path.join(this.dir, f), { force: true });
        n++;
      }
    }
    return n;
  }
}

const safeName = (s) => String(s).replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'result';

export class ProcessingService {
  constructor(db, wallets, storage, o) {
    this.db = db;
    this.wallets = wallets;
    this.storage = storage;
    this.o = { retentionMs: 86_400_000, leaseMs: 180_000, maxAttempts: 3, maxQueued: 200, maxResultBytes: 20 * 1024 * 1024, now: () => Date.now(), ...o };
    this.prices = o.prices; // { output: milli }
  }
  get now() {
    return this.o.now;
  }

  /** Charge + enqueue. `input`/`label` must already be validated by the caller (product/input.js). */
  createJob({ userId, walletId, input, label, outputs }) {
    if (!outputs.length) throw new UserError('no_output');
    return tx(this.db, () => {
      const queued = this.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE status = 'queued'").get().n;
      if (queued >= this.o.maxQueued) throw new UserError('busy', 'busy', 503);
      const id = crypto.randomBytes(16).toString('base64url');
      const now = this.now();
      const cost = outputs.reduce((s, x) => s + this.prices[x], 0);
      // Throws InsufficientFunds (HTTP 402) and leaves everything untouched.
      this.wallets.debitMany(
        walletId,
        outputs.map((x) => ({ amountMilli: this.prices[x], refId: `${id}:${x}`, label: x })),
        { refType: 'job-output', domain: label }
      );
      this.db
        .prepare(`INSERT INTO processing_jobs (id,user_id,wallet_id,input,label,status,cost_milli,created_at,expires_at) VALUES (?,?,?,?,?, 'queued', ?,?,?)`)
        .run(id, userId, walletId, input, label, cost, now, now + this.o.retentionMs);
      const ins = this.db.prepare('INSERT INTO processing_results (id,job_id,output,price_milli) VALUES (?,?,?,?)');
      for (const x of outputs) ins.run(crypto.randomBytes(16).toString('base64url'), id, x, this.prices[x]);
      return this.getJob(id, userId);
    });
  }

  // --- worker side -------------------------------------------------------------
  /** Hand the oldest queued job to a worker. Returns { id, input, outputs } or null. */
  claim(workerId) {
    return tx(this.db, () => {
      this.reapLeases();
      const job = this.db.prepare("SELECT * FROM processing_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get();
      if (!job) return null;
      this.db
        .prepare("UPDATE processing_jobs SET status='processing', attempts = attempts + 1, lease_until = ?, worker_id = ? WHERE id = ?")
        .run(this.now() + this.o.leaseMs, workerId, job.id);
      const outputs = this.db.prepare("SELECT output FROM processing_results WHERE job_id = ? AND status = 'pending'").all(job.id).map((r) => r.output);
      return { id: job.id, input: job.input, outputs };
    });
  }

  /** Jobs whose worker vanished: retry, or give up (and refund) after maxAttempts. */
  reapLeases() {
    const stale = this.db.prepare("SELECT id, attempts FROM processing_jobs WHERE status='processing' AND lease_until < ?").all(this.now());
    for (const j of stale) {
      if (j.attempts >= this.o.maxAttempts) this.abort(j.id, 'worker_lost');
      else this.db.prepare("UPDATE processing_jobs SET status='queued', lease_until=NULL, worker_id=NULL WHERE id = ?").run(j.id);
    }
    return stale.length;
  }

  #result(jobId, output) {
    return this.db.prepare('SELECT r.*, j.label, j.status AS job_status FROM processing_results r JOIN processing_jobs j ON j.id = r.job_id WHERE r.job_id = ? AND r.output = ?').get(jobId, output);
  }

  saveResult(jobId, output, buf) {
    const r = this.#result(jobId, output);
    if (!r || r.job_status !== 'processing') throw new UserError('bad_job', 'bad_job', 409);
    if (r.status !== 'pending') return; // duplicate delivery: ignore
    if (buf.length > this.o.maxResultBytes) return this.failOutput(jobId, output, 'too_large');
    if (buf.length === 0) return this.failOutput(jobId, output, 'empty');
    const ext = FILE_INFO[output].ext;
    tx(this.db, () => {
      this.storage.save(r.id, buf);
      this.db.prepare("UPDATE processing_results SET status='done', bytes=?, filename=? WHERE id = ?").run(buf.length, `${safeName(r.label)}-${output}.${ext}`, r.id);
    });
  }

  /** Output not delivered -> mark failed and refund exactly that output. */
  failOutput(jobId, output, code) {
    tx(this.db, () => {
      const r = this.#result(jobId, output);
      if (!r || r.status !== 'pending') return;
      const job = this.db.prepare('SELECT wallet_id FROM processing_jobs WHERE id = ?').get(jobId);
      this.wallets.refund(job.wallet_id, r.price_milli, { refType: 'job-output', refId: `${jobId}:${output}`, label: output });
      this.db.prepare("UPDATE processing_results SET status='failed', error=?, refunded=1 WHERE id = ?").run(String(code).slice(0, 40), r.id);
    });
  }

  abort(jobId, code) {
    tx(this.db, () => {
      for (const r of this.db.prepare("SELECT output FROM processing_results WHERE job_id = ? AND status='pending'").all(jobId)) this.failOutput(jobId, r.output, code);
      this.#finalize(jobId);
    });
  }

  /** Worker says "I'm done": anything still pending counts as not delivered. */
  finish(jobId) {
    this.abort(jobId, 'internal');
  }

  #finalize(jobId) {
    const rows = this.db.prepare('SELECT status FROM processing_results WHERE job_id = ?').all(jobId);
    const done = rows.filter((r) => r.status === 'done').length;
    this.db
      .prepare("UPDATE processing_jobs SET status = ?, finished_at = ?, lease_until = NULL WHERE id = ? AND status IN ('queued','processing')")
      .run(done > 0 ? 'completed' : 'refunded', this.now(), jobId);
  }

  // --- customer side ------------------------------------------------------------
  getJob(id, userId) {
    const j = this.db.prepare('SELECT * FROM processing_jobs WHERE id = ? AND user_id = ?').get(id, userId);
    return j ? this.#view(j) : null;
  }

  listJobs(userId, limit = 30) {
    return this.db.prepare('SELECT * FROM processing_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit).map((j) => this.#view(j));
  }

  #view(j) {
    const results = this.db.prepare('SELECT * FROM processing_results WHERE job_id = ?').all(j.id);
    return {
      id: j.id, label: j.label, status: j.status, costMilli: j.cost_milli, createdAt: j.created_at, expiresAt: j.expires_at,
      results: OUTPUTS.filter((o) => results.some((r) => r.output === o)).map((o) => {
        const r = results.find((x) => x.output === o);
        return { id: r.id, output: o, status: r.status, bytes: r.bytes, filename: r.filename, error: r.error, refunded: !!r.refunded, priceMilli: r.price_milli };
      }),
    };
  }

  /** Result file for its owner. Returns { buf, filename, mime } or null. */
  getFile(resultId, userId) {
    const r = this.db
      .prepare(`SELECT r.*, j.expires_at FROM processing_results r JOIN processing_jobs j ON j.id = r.job_id WHERE r.id = ? AND j.user_id = ? AND r.status = 'done'`)
      .get(resultId, userId);
    if (!r || r.expires_at < this.now() || !this.storage.exists(r.id)) return null;
    return { buf: this.storage.read(r.id), filename: r.filename, mime: FILE_INFO[r.output].mime };
  }

  // --- housekeeping -----------------------------------------------------------------
  /** Delete expired jobs (+ files) and files without a row. */
  purge() {
    const now = this.now();
    const jobs = this.db.prepare('SELECT id FROM processing_jobs WHERE expires_at < ?').all(now);
    for (const j of jobs) {
      for (const r of this.db.prepare('SELECT id FROM processing_results WHERE job_id = ?').all(j.id)) this.storage.remove(r.id);
      this.db.prepare('DELETE FROM processing_jobs WHERE id = ?').run(j.id);
    }
    const known = new Set(this.db.prepare('SELECT id FROM processing_results').all().map((r) => r.id));
    const orphans = this.storage.sweepOrphans(known);
    return { jobs: jobs.length, orphans };
  }

  queueStats() {
    return this.db.prepare("SELECT status, COUNT(*) n FROM processing_jobs WHERE status IN ('queued','processing') GROUP BY status").all();
  }
}

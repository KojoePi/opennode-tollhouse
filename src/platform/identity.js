// -----------------------------------------------------------------------------
// platform/identity.js - SessionService: anonymous users, sessions, recovery key.
//
// * First visit -> anonymous user + wallet + session (cookie holds a random
//   token; only its SHA-256 is stored).
// * Recovery key: 100 random bits, shown exactly once, stored as HMAC(pepper).
//   No e-mail, no password. Lost key = lost balance (the UI says so).
// * Key login on a session that holds a guest wallet with balance merges that
//   balance into the key's wallet through ledger bookings.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import { tx } from './db.js';
import { WalletService } from './wallet.js';

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export class SessionError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function generateKey(prefix = 'KEY') {
  const bytes = crypto.randomBytes(20);
  let s = '';
  for (const b of bytes) s += B32[b % 32]; // 32 divides 256 -> unbiased
  return `${prefix}-` + s.match(/.{4}/g).join('-');
}

/** Accept lowercase, missing dashes, spaces, missing prefix. Returns canonical form or null. */
export function normalizeKey(input, prefix = 'KEY') {
  const raw = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // The prefix is cosmetic: whatever precedes the 20 key characters is ignored
  // (so keys survive a change of KEY_PREFIX, and pasting without it works).
  const body = raw.length > 20 ? raw.slice(-20) : raw;
  if (body.length !== 20 || [...body].some((c) => !B32.includes(c))) return null;
  return `${prefix}-` + body.match(/.{4}/g).join('-');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class SessionService {
  constructor(db, { pepper, sessionDays = 90, keyPrefix = 'KEY', now = () => Date.now() } = {}) {
    if (!pepper || pepper.length < 16) throw new Error('KEY_PEPPER must be at least 16 characters');
    this.db = db;
    this.pepper = pepper;
    this.keyPrefix = keyPrefix;
    this.ttlMs = sessionDays * 86_400_000;
    this.now = now;
    this.wallets = new WalletService(db, { now });
  }

  /** HMAC over the 20 key characters only, so the (cosmetic) prefix can change without invalidating keys. */
  keyHash(key) {
    const body = String(key).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-20);
    return crypto.createHmac('sha256', this.pepper).update(body).digest('hex');
  }

  #newSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const now = this.now();
    this.db
      .prepare('INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at) VALUES (?,?,?,?,?)')
      .run(sha256(token), userId, csrf, now, now + this.ttlMs);
    return { token, csrf, maxAgeSec: Math.floor(this.ttlMs / 1000) };
  }

  /** Create user + wallet + session. Returns { token, csrf, userId, walletId }. */
  createAnonymous() {
    return tx(this.db, () => {
      const now = this.now();
      const userId = crypto.randomUUID();
      const walletId = crypto.randomUUID();
      this.db.prepare('INSERT INTO users (id, created_at, last_seen_at) VALUES (?,?,?)').run(userId, now, now);
      this.db.prepare('INSERT INTO wallets (id, user_id, balance_milli, created_at) VALUES (?,?,0,?)').run(walletId, userId, now);
      return { ...this.#newSession(userId), userId, walletId };
    });
  }

  /** Resolve a cookie token. Returns { userId, walletId, csrf, hasKey } or null. */
  resolve(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const row = this.db
      .prepare(
        `SELECT s.user_id, s.csrf, s.expires_at, w.id AS wallet_id, u.key_hash, u.last_seen_at
           FROM sessions s JOIN users u ON u.id = s.user_id JOIN wallets w ON w.user_id = u.id
          WHERE s.id_hash = ?`
      )
      .get(sha256(token));
    if (!row) return null;
    const now = this.now();
    if (row.expires_at < now) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
      return null;
    }
    if (now - row.last_seen_at > 3_600_000) {
      this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, row.user_id);
    }
    return { userId: row.user_id, walletId: row.wallet_id, csrf: row.csrf, hasKey: !!row.key_hash };
  }

  checkCsrf(session, header) {
    if (!session || !header) return false;
    const a = Buffer.from(session.csrf);
    const b = Buffer.from(String(header));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Create (or replace) the recovery key. Returns the plain key - ONCE. */
  createKey(userId) {
    const key = generateKey(this.keyPrefix);
    this.db.prepare('UPDATE users SET key_hash = ?, key_created_at = ? WHERE id = ?').run(this.keyHash(key), this.now(), userId);
    return key;
  }

  /**
   * Log in with a key. `current` is the present session (may hold a guest
   * wallet). Returns { token, csrf, userId, walletId, merged } with a NEW session
   * token (session fixation protection); the old session is deleted.
   */
  loginWithKey(input, current, oldToken) {
    const key = normalizeKey(input, this.keyPrefix);
    if (!key) throw new SessionError('bad_key');
    return tx(this.db, () => {
      const target = this.db
        .prepare('SELECT u.id AS user_id, w.id AS wallet_id FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.key_hash = ?')
        .get(this.keyHash(key));
      if (!target) throw new SessionError('bad_key');

      let merged = 0;
      if (current && current.userId !== target.user_id) {
        merged = this.wallets.merge(current.walletId, target.wallet_id);
        // A guest without recovery key has no other use for its session.
        const guest = this.db.prepare('SELECT key_hash FROM users WHERE id = ?').get(current.userId);
        if (guest && !guest.key_hash) this.#deleteGuestIfEmpty(current.userId);
      }
      if (oldToken) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(oldToken));
      return { ...this.#newSession(target.user_id), userId: target.user_id, walletId: target.wallet_id, merged };
    });
  }

  #deleteGuestIfEmpty(userId) {
    // The ledger is immutable and references the wallet, so a guest that ever
    // booked anything keeps its (now empty) wallet; only pristine guests vanish.
    const w = this.wallets.getWalletByUser(userId);
    const used = this.db.prepare('SELECT 1 FROM wallet_transactions WHERE wallet_id = ? LIMIT 1').get(w.id);
    if (!used) this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  logout(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
  }

  /** Housekeeping: expired sessions, and anonymous users idle > `idleDays` with nothing in the wallet. */
  purge({ idleDays = 180 } = {}) {
    const now = this.now();
    const sessions = this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now).changes;
    const old = this.db
      .prepare(
        `DELETE FROM users WHERE key_hash IS NULL AND last_seen_at < ?
            AND id IN (SELECT user_id FROM wallets w WHERE w.balance_milli = 0
                        AND NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.wallet_id = w.id))`
      )
      .run(now - idleDays * 86_400_000).changes;
    return { sessions, users: old };
  }
}

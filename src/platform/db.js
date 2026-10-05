// -----------------------------------------------------------------------------
// platform/db.js - SQLite storage for the reusable platform (users, wallets,
// ledger, payments, sessions). Product tables live in product/schema.js and are
// added on top of the same connection.
//
// Ledger immutability: triggers reject UPDATE and DELETE on wallet_transactions.
// Idempotency: UNIQUE(type, ref_type, ref_id) - the same business event can
// never be booked twice, even under races or webhook replays.
// -----------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`);
  db.exec(PLATFORM_SCHEMA);
  return db;
}

/** Run `fn` inside an IMMEDIATE transaction; nested calls join the outer one. */
const depth = new WeakMap();
export function tx(db, fn) {
  const d = depth.get(db) || 0;
  if (d > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

export const PLATFORM_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  key_hash     TEXT UNIQUE,            -- HMAC of the recovery key; the key itself is never stored
  key_created_at INTEGER
);

CREATE TABLE IF NOT EXISTS wallets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance_milli INTEGER NOT NULL DEFAULT 0 CHECK (balance_milli >= 0),
  created_at    INTEGER NOT NULL
);

-- Immutable ledger. amount_milli is signed (+ credit, - debit).
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id           TEXT NOT NULL REFERENCES wallets(id),
  type                TEXT NOT NULL CHECK (type IN ('topup','usage','refund','adjustment')),
  amount_milli        INTEGER NOT NULL,
  balance_after_milli INTEGER NOT NULL CHECK (balance_after_milli >= 0),
  eur_cents           INTEGER,            -- only for top-ups (accounting)
  ref_type            TEXT NOT NULL,      -- payment | job | merge | ...
  ref_id              TEXT NOT NULL,
  label               TEXT,               -- e.g. output name; never a URL
  created_at          INTEGER NOT NULL,
  UNIQUE (type, ref_type, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_tx_wallet ON wallet_transactions(wallet_id, id);

CREATE TRIGGER IF NOT EXISTS wallet_tx_no_update BEFORE UPDATE ON wallet_transactions
BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS wallet_tx_no_delete BEFORE DELETE ON wallet_transactions
BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;

-- Domain shown in the usage history; purged separately after 30 days.
CREATE TABLE IF NOT EXISTS usage_domains (
  tx_id      INTEGER PRIMARY KEY,
  domain     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  wallet_id     TEXT NOT NULL REFERENCES wallets(id),
  charge_id     TEXT UNIQUE,
  eur_cents     INTEGER NOT NULL,
  credit_milli  INTEGER NOT NULL,        -- base + bonus
  bonus_milli   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,           -- pending | paid | expired | failed
  bolt11        TEXT,
  sats          INTEGER,
  checkout_url  TEXT,
  expires_at    INTEGER,
  last_check_at INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  paid_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payments_wallet ON payments(wallet_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,           -- sha256 of the cookie token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY, v TEXT, updated_at INTEGER
);
`;

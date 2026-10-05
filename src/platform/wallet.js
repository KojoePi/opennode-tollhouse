// -----------------------------------------------------------------------------
// platform/wallet.js - WalletService: the only code allowed to change balances.
//
// Every change is ONE transaction that (1) inserts an immutable ledger row and
// (2) updates the cached balance. Ledger rows are unique per
// (type, ref_type, ref_id), so replaying the same event is a harmless no-op.
// -----------------------------------------------------------------------------

import { tx } from './db.js';

export class InsufficientFunds extends Error {
  constructor(needed, available) {
    super('insufficient_funds');
    this.code = 'insufficient_funds';
    this.status = 402;
    this.needed = needed;
    this.available = available;
  }
}

export class WalletService {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
  }

  getWallet(walletId) {
    return this.db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId) || null;
  }

  getWalletByUser(userId) {
    return this.db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId) || null;
  }

  balance(walletId) {
    return this.getWallet(walletId)?.balance_milli ?? 0;
  }

  /** Internal: book one ledger row. Returns { tx, duplicate }. Must run inside tx(). */
  #book(walletId, type, amountMilli, { refType, refId, eurCents = null, label = null, domain = null }) {
    if (!Number.isInteger(amountMilli) || amountMilli === 0) throw new Error('invalid_amount');
    if (!refType || !refId) throw new Error('missing_reference');
    const db = this.db;

    const existing = db
      .prepare('SELECT * FROM wallet_transactions WHERE type = ? AND ref_type = ? AND ref_id = ?')
      .get(type, refType, String(refId));
    if (existing) return { tx: existing, duplicate: true };

    const w = this.getWallet(walletId);
    if (!w) throw new Error('wallet_not_found');
    const after = w.balance_milli + amountMilli;
    if (after < 0) throw new InsufficientFunds(-amountMilli, w.balance_milli);

    const now = this.now();
    const info = db
      .prepare(
        `INSERT INTO wallet_transactions
           (wallet_id, type, amount_milli, balance_after_milli, eur_cents, ref_type, ref_id, label, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(walletId, type, amountMilli, after, eurCents, refType, String(refId), label, now);
    db.prepare('UPDATE wallets SET balance_milli = ? WHERE id = ?').run(after, walletId);
    const id = Number(info.lastInsertRowid);
    if (domain) db.prepare('INSERT INTO usage_domains (tx_id, domain, created_at) VALUES (?,?,?)').run(id, domain, now);
    return {
      tx: { id, wallet_id: walletId, type, amount_milli: amountMilli, balance_after_milli: after, eur_cents: eurCents, ref_type: refType, ref_id: String(refId), label, created_at: now },
      duplicate: false,
    };
  }

  /** Top-up credit (from a paid payment). Idempotent per payment id. */
  credit(walletId, amountMilli, opts) {
    return tx(this.db, () => this.#book(walletId, 'topup', amountMilli, opts));
  }

  /** Charge for one output. Throws InsufficientFunds. Idempotent per job-output. */
  debit(walletId, amountMilli, opts) {
    return tx(this.db, () => this.#book(walletId, 'usage', -Math.abs(amountMilli), opts));
  }

  /** Refund of a previous usage booking (never more than once per reference). */
  refund(walletId, amountMilli, opts) {
    return tx(this.db, () => this.#book(walletId, 'refund', Math.abs(amountMilli), opts));
  }

  /**
   * Charge several outputs at once, all-or-nothing (used when a job is created).
   * items: [{ amountMilli, refId, label }]
   */
  debitMany(walletId, items, { refType = 'job-output', domain = null } = {}) {
    return tx(this.db, () => {
      const total = items.reduce((s, i) => s + i.amountMilli, 0);
      const w = this.getWallet(walletId);
      if (!w) throw new Error('wallet_not_found');
      if (w.balance_milli < total) throw new InsufficientFunds(total, w.balance_milli);
      return items.map((i, n) =>
        this.#book(walletId, 'usage', -i.amountMilli, { refType, refId: i.refId, label: i.label, domain: n === 0 ? domain : null })
      );
    });
  }

  /**
   * Move the whole balance of `fromWalletId` into `toWalletId` via two
   * adjustment bookings (used when a recovery-key login meets a guest wallet).
   */
  merge(fromWalletId, toWalletId) {
    return tx(this.db, () => {
      const from = this.getWallet(fromWalletId);
      if (!from || fromWalletId === toWalletId || from.balance_milli <= 0) return 0;
      const amount = from.balance_milli;
      this.#book(fromWalletId, 'adjustment', -amount, { refType: 'merge-out', refId: `${fromWalletId}>${toWalletId}`, label: 'merge' });
      this.#book(toWalletId, 'adjustment', amount, { refType: 'merge-in', refId: `${fromWalletId}>${toWalletId}`, label: 'merge' });
      return amount;
    });
  }

  /** Newest first, with the optional domain (kept only ~30 days). */
  listTransactions(walletId, { limit = 50, before = null } = {}) {
    return this.db
      .prepare(
        `SELECT t.id, t.type, t.amount_milli, t.balance_after_milli, t.eur_cents, t.label, t.created_at, d.domain
           FROM wallet_transactions t LEFT JOIN usage_domains d ON d.tx_id = t.id
          WHERE t.wallet_id = ? AND (? IS NULL OR t.id < ?)
          ORDER BY t.id DESC LIMIT ?`
      )
      .all(walletId, before, before, Math.min(limit, 200));
  }

  /** Euro bookings for accounting (top-ups only), oldest first. */
  listTopups(walletId = null) {
    return this.db
      .prepare(
        `SELECT t.id, t.wallet_id, t.created_at, t.eur_cents, t.amount_milli, t.ref_id AS payment_id
           FROM wallet_transactions t
          WHERE t.type = 'topup' AND (? IS NULL OR t.wallet_id = ?)
          ORDER BY t.id ASC`
      )
      .all(walletId, walletId);
  }

  /** Housekeeping: forget domains older than `days`. The ledger itself stays. */
  purgeDomains(days = 30) {
    return this.db.prepare('DELETE FROM usage_domains WHERE created_at < ?').run(this.now() - days * 86_400_000).changes;
  }

  /** Consistency check: cached balance must equal the ledger sum. */
  verifyLedger(walletId) {
    const sum = this.db.prepare('SELECT COALESCE(SUM(amount_milli),0) AS s FROM wallet_transactions WHERE wallet_id = ?').get(walletId).s;
    return sum === this.balance(walletId);
  }
}

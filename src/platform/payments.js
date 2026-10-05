// -----------------------------------------------------------------------------
// platform/payments.js - PaymentService: wallet top-ups via a payment provider.
//
// Flow: createTopup -> provider charge (Lightning invoice) -> customer pays ->
// webhook (signature verified, then status re-checked at the provider) or the
// status poll -> settle(): marks the payment paid and credits the wallet in one
// transaction. settle() is idempotent: webhook replays never double-credit.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import { tx } from './db.js';
import { WalletService } from './wallet.js';
import { creditForTopup } from './units.js';

export class PaymentError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export class PaymentService {
  constructor(db, provider, { minCents = 25, maxCents = 25_00, bonusThresholdCents = 1000, bonusPercent = 10, maxPendingPerWallet = 5, now = () => Date.now() } = {}) {
    this.db = db;
    this.provider = provider;
    this.opts = { minCents, maxCents, bonusThresholdCents, bonusPercent, maxPendingPerWallet };
    this.now = now;
    this.wallets = new WalletService(db, { now });
  }

  /** Preview of what an amount buys (no side effects). */
  quote(eurCents) {
    const c = Number(eurCents);
    if (!Number.isInteger(c) || c < this.opts.minCents) throw new PaymentError('amount_too_low');
    if (c > this.opts.maxCents) throw new PaymentError('amount_too_high');
    return { eurCents: c, ...creditForTopup(c, this.opts) };
  }

  async createTopup(walletId, eurCents) {
    const q = this.quote(eurCents);
    const now = this.now();
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE wallet_id = ? AND status = 'pending' AND expires_at > ?").get(walletId, now).n;
    if (pending >= this.opts.maxPendingPerWallet) throw new PaymentError('too_many_pending', 429);

    const id = crypto.randomUUID();
    let charge;
    try {
      charge = await this.provider.createCharge({ paymentId: id, amountCents: q.eurCents, description: 'Wallet top-up' });
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'charge_create_failed', err: e.message }));
      throw new PaymentError('payment_unavailable', 502);
    }
    this.db
      .prepare(
        `INSERT INTO payments (id, wallet_id, charge_id, eur_cents, credit_milli, bonus_milli, status, bolt11, sats, checkout_url, expires_at, created_at)
         VALUES (?,?,?,?,?,?, 'pending', ?,?,?,?,?)`
      )
      .run(id, walletId, charge.id, q.eurCents, q.totalMilli, q.bonusMilli, charge.bolt11, charge.sats, charge.checkoutUrl, charge.expiresAt, now);
    return this.view(id);
  }

  get(id) {
    return this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) || null;
  }

  /** Public shape (no charge id). */
  view(id) {
    const p = this.get(id);
    if (!p) return null;
    return {
      id: p.id, status: p.status, eurCents: p.eur_cents, creditMilli: p.credit_milli, bonusMilli: p.bonus_milli,
      bolt11: p.status === 'pending' ? p.bolt11 : null, sats: p.sats, expiresAt: p.expires_at,
    };
  }

  /** Idempotently mark paid + credit the wallet. */
  settle(paymentId) {
    return tx(this.db, () => {
      const p = this.get(paymentId);
      if (!p) throw new PaymentError('not_found', 404);
      if (p.status === 'paid') return { credited: false, payment: p };
      // A late payment for an expired invoice is still money received: credit it.
      const now = this.now();
      this.db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ?").run(now, p.id);
      this.wallets.credit(p.wallet_id, p.credit_milli, { refType: 'payment', refId: p.id, eurCents: p.eur_cents, label: 'topup' });
      return { credited: true, payment: { ...p, status: 'paid' } };
    });
  }

  /** Webhook entry: verify signature, then confirm with the provider (never trust the body alone). */
  async handleWebhook({ id: chargeId, hashed_order: hashed }) {
    if (!this.provider.verifyWebhook(chargeId, hashed)) throw new PaymentError('bad_signature', 401);
    const p = this.db.prepare('SELECT * FROM payments WHERE charge_id = ?').get(String(chargeId));
    if (!p) return { ignored: true };
    return this.#refresh(p);
  }

  /** Poll safety net (also called by the UI). Rate limited per payment to ~8s. */
  async poll(paymentId, walletId) {
    const p = this.get(paymentId);
    if (!p || p.wallet_id !== walletId) throw new PaymentError('not_found', 404);
    if (p.status === 'pending' && this.now() - p.last_check_at > 8000) await this.#refresh(p);
    return this.view(paymentId);
  }

  async #refresh(p) {
    if (p.status === 'paid') return { status: 'paid' };
    this.db.prepare('UPDATE payments SET last_check_at = ? WHERE id = ?').run(this.now(), p.id);
    const status = await this.provider.getChargeStatus(p.charge_id);
    if (status === 'paid') {
      this.settle(p.id);
      return { status: 'paid' };
    }
    if (status === 'expired' && p.status === 'pending') {
      this.db.prepare("UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'").run(p.id);
    }
    return { status: status || 'unknown' };
  }

  /** Mark stale pending invoices expired (housekeeping). */
  expireStale() {
    return this.db.prepare("UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at < ? - 600000").run(this.now()).changes;
  }
}

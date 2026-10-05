// -----------------------------------------------------------------------------
// platform/opennode.js - OpenNode Lightning provider.
//
// Credit: the charge/webhook handling was originally adapted from
// KojoePi/aegis-opennode (charges via POST /v1/charges, webhook authenticated
// with HMAC-SHA256(API key, charge id) == `hashed_order`).
//
// A provider is a plain object { createCharge, getChargeStatus, verifyWebhook }
// so tests (and other payment methods) can swap it out.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';

export function createOpenNode({ apiKey, apiBase = 'https://api.opennode.com', baseUrl, ttlMinutes = 60, mock = false, fetchImpl = fetch }) {
  const mockCharges = new Map();

  return {
    mock,

    /** @returns {{id, bolt11, sats, checkoutUrl, expiresAt}} */
    async createCharge({ paymentId, amountCents, description }) {
      if (mock) {
        const id = 'mock_' + crypto.randomBytes(8).toString('hex');
        mockCharges.set(id, { status: 'unpaid', paymentId });
        const sats = Math.round((amountCents / 100) * 1500);
        return {
          id,
          bolt11: 'lnbc' + sats + 'n1mock' + crypto.randomBytes(60).toString('hex'),
          sats,
          checkoutUrl: `${baseUrl}/dev/pay/${paymentId}`,
          expiresAt: Date.now() + ttlMinutes * 60_000,
        };
      }
      const res = await fetchImpl(`${apiBase}/v1/charges`, {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          amount: amountCents / 100,
          currency: 'EUR',
          description,
          order_id: paymentId,
          callback_url: `${baseUrl}/opennode_webhook`,
          ttl: ttlMinutes,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if (!res.ok) {
        console.error(JSON.stringify({ level: 'error', msg: 'opennode_charge_failed', status: res.status }));
        throw new Error('opennode_charge_failed');
      }
      let data;
      try {
        data = JSON.parse(text).data;
      } catch {
        throw new Error('opennode_bad_response');
      }
      const payreq = data?.lightning_invoice?.payreq;
      if (!data?.id || !payreq) throw new Error('opennode_no_invoice');
      const exp = Number(data.lightning_invoice.expires_at);
      return {
        id: data.id,
        bolt11: payreq,
        sats: Number.isFinite(Number(data.amount)) ? Math.round(Number(data.amount)) : null,
        checkoutUrl: data.hosted_checkout_url || null,
        expiresAt: Number.isFinite(exp) && exp > 0 ? (exp < 1e12 ? exp * 1000 : exp) : Date.now() + ttlMinutes * 60_000,
      };
    },

    /** "unpaid" | "processing" | "paid" | "expired" | ... or null when unknown. */
    async getChargeStatus(chargeId) {
      if (mock) return mockCharges.get(chargeId)?.status ?? null;
      for (const v of ['v2', 'v1']) {
        try {
          const res = await fetchImpl(`${apiBase}/${v}/charge/${encodeURIComponent(chargeId)}`, {
            headers: { Authorization: apiKey, Accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.status === 404 && v === 'v2') continue;
          if (!res.ok) return null;
          return (await res.json())?.data?.status ?? null;
        } catch {
          /* try next */
        }
      }
      return null;
    },

    verifyWebhook(chargeId, hashedOrder) {
      if (mock) return true;
      if (!apiKey || !chargeId || !hashedOrder) return false;
      const expected = crypto.createHmac('sha256', apiKey).update(chargeId).digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(String(hashedOrder));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    /** Mock only. */
    mockMarkPaid(chargeId) {
      const c = mockCharges.get(chargeId);
      if (c) c.status = 'paid';
    },
  };
}

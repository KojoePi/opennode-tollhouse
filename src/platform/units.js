// -----------------------------------------------------------------------------
// units.js - money arithmetic for the wallet.
//
// Internal unit: milli-Aktion (integer). Never floats in the ledger.
//   1 Aktion      = 1000 milli
//   1 EUR         = 100 Aktionen = 100 000 milli
//   1 euro cent   = 1 Aktion / ... = 1000 milli
// Hence 0.5 Aktion (Metadata) = 500 milli = half a cent.
// -----------------------------------------------------------------------------

export const MILLI_PER_ACTION = 1000;
export const MILLI_PER_CENT = 1000;

/** Euro cents (may be fractional, e.g. 0.5) -> integer milli-Aktionen. */
export function centsToMilli(cents) {
  return Math.round(Number(cents) * MILLI_PER_CENT);
}

/** Milli-Aktionen -> Aktionen as a plain number (for display only). */
export function milliToActions(milli) {
  return milli / MILLI_PER_ACTION;
}

/**
 * Bonus rule for top-ups: from `thresholdCents` upward the customer gets
 * `bonusPercent` % more Aktionen. Returns { baseMilli, bonusMilli, totalMilli }.
 */
export function creditForTopup(eurCents, { bonusThresholdCents = 1000, bonusPercent = 10 } = {}) {
  const baseMilli = eurCents * MILLI_PER_CENT;
  const bonusMilli = eurCents >= bonusThresholdCents ? Math.floor((baseMilli * bonusPercent) / 100) : 0;
  return { baseMilli, bonusMilli, totalMilli: baseMilli + bonusMilli };
}

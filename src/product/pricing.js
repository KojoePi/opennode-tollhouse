// -----------------------------------------------------------------------------
// product/pricing.js - the output catalogue and its prices (single source of truth).
//
// YOUR PRODUCT: list the things a customer can order per job. Each output is
// priced, delivered and refunded individually. Keep this list, FILE_INFO,
// config.pricing, the i18n keys `out.<name>` / `out.<name>.d` and the worker
// pipeline (worker/pipeline.js) in sync.
//
// The two demo outputs below only exist to show the mechanics:
//   stats - tiny JSON report about the input   (cheap)
//   text  - the input, normalised              (standard)
// -----------------------------------------------------------------------------

import { centsToMilli } from '../platform/units.js';

export const OUTPUTS = ['stats', 'text'];

export const FILE_INFO = {
  stats: { ext: 'json', mime: 'application/json; charset=utf-8' },
  text: { ext: 'txt', mime: 'text/plain; charset=utf-8' },
};

export function priceTable(pricingCents) {
  return Object.fromEntries(OUTPUTS.map((o) => [o, centsToMilli(pricingCents[o])]));
}

/** Validate a user selection -> unique, ordered list of known outputs. */
export function normalizeOutputs(list) {
  if (!Array.isArray(list)) return [];
  const set = new Set(list.map(String));
  return OUTPUTS.filter((o) => set.has(o));
}

export function totalMilli(table, outputs) {
  return outputs.reduce((s, o) => s + table[o], 0);
}

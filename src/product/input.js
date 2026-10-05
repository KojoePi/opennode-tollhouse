// -----------------------------------------------------------------------------
// product/input.js - validation of the customer's job input.
//
// YOUR PRODUCT: this runs BEFORE the wallet is charged. Reject anything you
// cannot process by throwing UserError(code); the code is shown to the user via
// the i18n key `err.<code>` (add the texts in public/i18n.js).
//
// Returns { input, label }
//   input - what the worker receives (stored until the result expires)
//   label - short, NON-SENSITIVE description shown in the job list and kept in
//           the ledger for DOMAIN_HISTORY_DAYS. Never put user content or URLs
//           with query strings in it.
//
// Demo: free text up to MAX_INPUT_CHARS. For a product that fetches URLs use
// parseTargetUrl() + assertPublicHost() from ../security.js (SSRF protection)
// and return { input: target.href, label: target.host }.
// -----------------------------------------------------------------------------

import { UserError } from '../security.js';

export const MAX_INPUT_CHARS = 2000;

export function validateInput(raw) {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) throw new UserError('bad_input');
  if (input.length > MAX_INPUT_CHARS) throw new UserError('input_too_long');
  return { input, label: `text-${input.length}` };
}

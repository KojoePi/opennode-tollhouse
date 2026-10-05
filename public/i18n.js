// -----------------------------------------------------------------------------
// i18n.js - German / English texts and a tiny translation helper.
//
// Static HTML uses  data-i18n="key"  (text),  data-i18n-ph="key" (placeholder),
// data-i18n-title="key" (title/aria-label), data-i18n-html="key" (trusted markup
// from this file only). Dynamic text uses t('key', {vars}).
// Language: /de and /en pages force theirs, otherwise localStorage, otherwise the
// browser language. (Only the language choice is stored locally - never money.)
// -----------------------------------------------------------------------------

export const TEXTS = {
  de: {
    'hero.title': 'Dein Produkt in einem Satz.',
    'hero.sub': 'Hier steht der Nutzen für deine Kunden. Eingabe machen, Ergebnis wählen, fertig. Ohne Konto, ohne Abo: bezahlt wird nur, was genutzt wird.',
    'hero.badge1': 'ab 0,5 Aktion',
    'hero.badge2': 'kein Abo, keine Registrierung',
    'hero.badge3': 'Ergebnisse nach 24 h gelöscht',
    'offline': 'Der Verarbeitungsdienst startet gerade oder ist vorübergehend offline. Aufträge werden angenommen und abgearbeitet, sobald er wieder läuft.',

    'form.url': 'Eingabe',
    'form.urlPh': 'Text eingeben …',
    'form.outputs': 'Was soll herauskommen?',
    'form.submit': 'Verarbeiten',
    'form.submitCost': 'Verarbeiten · {n}',
    'form.total': 'Gesamt',
    'form.hint': 'Die Eingabe wird vor der Abbuchung geprüft. Was nicht geliefert werden kann, wird automatisch zurückgebucht.',
    'form.pickOne': 'Bitte mindestens ein Format wählen.',

    'out.stats': 'Statistik',
    'out.stats.d': 'Zeichen, Wörter und Zeilen (JSON)',
    'out.text': 'Text',
    'out.text.d': 'Die Eingabe, bereinigt',

    'unit.action': 'Aktion',
    'unit.actions': 'Aktionen',

    'jobs.title': 'Deine Aufträge',
    'jobs.none': 'Noch keine Aufträge in dieser Sitzung.',
    'jobs.expires': 'Ergebnisse verfügbar bis {time}',
    'jobs.queued': 'In der Warteschlange …',
    'jobs.processing': 'Wird verarbeitet …',
    'jobs.completed': 'Fertig',
    'jobs.failed': 'Fehlgeschlagen',
    'jobs.refunded': 'Nicht möglich, alles zurückgebucht',
    'res.pending': 'wartet',
    'res.done': 'bereit',
    'res.failed': 'nicht geliefert, {n} zurückgebucht',
    'res.view': 'Ansehen',
    'res.download': 'Herunterladen',
    'res.copy': 'Kopieren',
    'res.copied': 'Kopiert',
    'res.preview': 'Vorschau',

    'err.rate_limited': 'Zu viele Anfragen. Bitte in etwas Zeit erneut versuchen.',
    'err.no_output': 'Bitte mindestens ein Format wählen.',
    'err.bad_input': 'Bitte eine Eingabe machen.',
    'err.input_too_long': 'Die Eingabe ist zu lang.',
    'err.busy': 'Gerade sind sehr viele Aufträge in der Warteschlange. Bitte gleich nochmal versuchen. Es wurde nichts abgebucht.',
    'err.csrf': 'Die Sitzung ist abgelaufen. Bitte Seite neu laden.',
    'err.forbidden': 'Anfrage abgelehnt.',
    'err.bad_key': 'Dieser Schlüssel ist ungültig.',
    'err.key_exists': 'Es gibt schon einen Schlüssel.',
    'err.no_topup_yet': 'Einen Schlüssel gibt es erst nach der ersten Aufladung.',
    'err.amount': 'Der Betrag muss zwischen {min} und {max} liegen.',
    'err.too_many_pending': 'Es gibt schon mehrere offene Zahlungen. Bitte erst eine bezahlen oder kurz warten.',
    'err.provider': 'Der Zahlungsdienst ist gerade nicht erreichbar. Bitte später erneut versuchen.',
    'err.internal': 'Da ist etwas schiefgelaufen. Bitte erneut versuchen.',
    'err.network': 'Keine Verbindung zum Server.',
    'fail.timeout': 'Zeitüberschreitung',
    'fail.unsupported': 'Dieses Ergebnis wird nicht unterstützt',
    'fail.empty': 'Leere Antwort',
    'fail.too_large': 'Zu groß',
    'fail.worker_lost': 'Verarbeitung unterbrochen',
    'fail.internal': 'Interner Fehler',

    'wallet.btn': 'Guthaben',
    'wallet.title': 'Dein Guthaben',
    'wallet.balance': 'Verfügbar',
    'wallet.close': 'Schließen',
    'wallet.topup': 'Aufladen',
    'wallet.eurNote': '1 € = 100 Aktionen. Kein Abo: Du zahlst nur, was du nutzt.',
    'wallet.custom': 'Eigener Betrag in €',
    'wallet.customGo': 'Betrag übernehmen',
    'wallet.bonus': 'Ab {from} € gibt es {pct} % Bonus-Aktionen dazu.',
    'wallet.quote': 'Du erhältst {actions} Aktionen{bonus}.',
    'wallet.quoteBonus': ' (inkl. {bonus} Bonus)',
    'wallet.pay': 'Mit Lightning bezahlen',
    'wallet.limits': 'Mindestens {min} €, höchstens {max} € pro Aufladung.',
    'wallet.lowHint': 'Guthaben reicht nicht. Dir fehlen {n}.',

    'pay.title': 'Jetzt bezahlen',
    'pay.amount': '{eur} in Bitcoin (Lightning)',
    'pay.sats': '≈ {sats} sats',
    'pay.open': 'In Wallet öffnen',
    'pay.copy': 'Rechnung kopieren',
    'pay.copied': 'Kopiert',
    'pay.waiting': 'Warte auf Zahlung …',
    'pay.paid': 'Bezahlt. {actions} Aktionen wurden gutgeschrieben.',
    'pay.expired': 'Die Rechnung ist abgelaufen. Bitte neu aufladen.',
    'pay.cancel': 'Zurück',
    'pay.mock': 'Testzahlung auslösen (nur lokal)',

    'key.title': 'Dein Wiederherstellungsschlüssel',
    'key.lead': 'Es gibt keine E-Mail und kein Passwort. Mit diesem Schlüssel kommst du auf anderen Geräten oder nach dem Löschen von Cookies wieder an dein Guthaben.',
    'key.warn': 'Wichtig: Das Speichern des Schlüssels ist allein deine Verantwortung. Wir speichern nur einen Hash und können ihn nicht wiederherstellen. Geht der Schlüssel verloren, ist das Guthaben unwiederbringlich weg.',
    'key.create': 'Schlüssel erzeugen',
    'key.createHint': 'Empfohlen, sobald du Guthaben hast.',
    'key.have': 'Für dieses Guthaben existiert ein Schlüssel. Er wird nicht mehr angezeigt.',
    'key.replace': 'Neuen Schlüssel erzeugen (der alte wird ungültig)',
    'key.copy': 'Kopieren',
    'key.save': 'Als Datei speichern',
    'key.saved': 'Ich habe den Schlüssel sicher gespeichert und weiß, dass ohne ihn das Guthaben verloren ist.',
    'key.done': 'Fertig',
    'key.loginTitle': 'Mit Schlüssel anmelden',
    'key.loginPh': 'RLY-XXXX-XXXX-XXXX-XXXX-XXXX',
    'key.login': 'Anmelden',
    'key.merged': 'Angemeldet. {n} Aktionen aus diesem Browser wurden übernommen.',
    'key.loggedIn': 'Angemeldet.',
    'key.logout': 'Abmelden',
    'key.logoutConfirm': 'Abmelden? Ohne deinen Schlüssel kommst du danach nicht mehr an dieses Guthaben.',

    'hist.title': 'Buchungen',
    'hist.none': 'Noch keine Buchungen.',
    'hist.more': 'Mehr laden',
    'hist.csv': 'Aufladungen als CSV (Buchhaltung)',
    'hist.topup': 'Aufladung',
    'hist.usage': 'Nutzung',
    'hist.refund': 'Rückbuchung',
    'hist.adjustment': 'Übertrag',
    'hist.note': 'Die Bezeichnung der Nutzung wird 30 Tage angezeigt, danach gelöscht.',

    'foot.imprint': 'Impressum',
    'foot.privacy': 'Datenschutz',
    'foot.terms': 'AGB',
    'foot.made': 'Gemacht mit',
    'foot.by': 'von',
    'foot.and': 'und',
    'cookie.note': 'Wir setzen ein einziges, technisch notwendiges Sitzungs-Cookie, damit dein Guthaben dir zugeordnet bleibt. Kein Tracking.',
    'cookie.ok': 'Verstanden',
  },
  en: {
    'hero.title': 'Your product in one sentence.',
    'hero.sub': 'This is where the benefit for your customers goes. Enter something, pick a result, done. No account, no subscription: you only pay for what you use.',
    'hero.badge1': 'from 0.5 Action',
    'hero.badge2': 'no subscription, no sign-up',
    'hero.badge3': 'results deleted after 24 h',
    'offline': 'The processing service is starting or temporarily offline. Jobs are accepted and processed as soon as it is back.',

    'form.url': 'Input',
    'form.urlPh': 'Enter some text …',
    'form.outputs': 'What should come out?',
    'form.submit': 'Process',
    'form.submitCost': 'Process · {n}',
    'form.total': 'Total',
    'form.hint': 'The input is checked before anything is charged. Whatever cannot be delivered is refunded automatically.',
    'form.pickOne': 'Please choose at least one format.',

    'out.stats': 'Statistics',
    'out.stats.d': 'Characters, words and lines (JSON)',
    'out.text': 'Text',
    'out.text.d': 'The input, cleaned up',

    'unit.action': 'Action',
    'unit.actions': 'Actions',

    'jobs.title': 'Your jobs',
    'jobs.none': 'No jobs in this session yet.',
    'jobs.expires': 'Results available until {time}',
    'jobs.queued': 'Waiting in queue …',
    'jobs.processing': 'Processing …',
    'jobs.completed': 'Done',
    'jobs.failed': 'Failed',
    'jobs.refunded': 'Not possible, everything refunded',
    'res.pending': 'pending',
    'res.done': 'ready',
    'res.failed': 'not delivered, {n} refunded',
    'res.view': 'View',
    'res.download': 'Download',
    'res.copy': 'Copy',
    'res.copied': 'Copied',
    'res.preview': 'Preview',

    'err.rate_limited': 'Too many requests. Please try again in a while.',
    'err.no_output': 'Please choose at least one format.',
    'err.bad_input': 'Please enter something.',
    'err.input_too_long': 'The input is too long.',
    'err.busy': 'The queue is very full right now. Please try again shortly. Nothing was charged.',
    'err.csrf': 'Your session expired. Please reload the page.',
    'err.forbidden': 'Request rejected.',
    'err.bad_key': 'This key is not valid.',
    'err.key_exists': 'A key already exists.',
    'err.no_topup_yet': 'A key is available after your first top-up.',
    'err.amount': 'The amount must be between {min} and {max}.',
    'err.too_many_pending': 'You already have several open payments. Please pay one or wait a moment.',
    'err.provider': 'The payment service is unavailable right now. Please try again later.',
    'err.internal': 'Something went wrong. Please try again.',
    'err.network': 'No connection to the server.',
    'fail.timeout': 'timed out',
    'fail.unsupported': 'This result is not supported',
    'fail.empty': 'empty response',
    'fail.too_large': 'too large',
    'fail.worker_lost': 'processing interrupted',
    'fail.internal': 'internal error',

    'wallet.btn': 'Balance',
    'wallet.title': 'Your balance',
    'wallet.balance': 'Available',
    'wallet.close': 'Close',
    'wallet.topup': 'Top up',
    'wallet.eurNote': '€1 = 100 Actions. No subscription: you only pay for what you use.',
    'wallet.custom': 'Custom amount in €',
    'wallet.customGo': 'Use amount',
    'wallet.bonus': 'From €{from} you get {pct}% bonus Actions.',
    'wallet.quote': 'You receive {actions} Actions{bonus}.',
    'wallet.quoteBonus': ' (incl. {bonus} bonus)',
    'wallet.pay': 'Pay with Lightning',
    'wallet.limits': 'Minimum €{min}, maximum €{max} per top-up.',
    'wallet.lowHint': 'Not enough balance. You are missing {n}.',

    'pay.title': 'Pay now',
    'pay.amount': '{eur} in Bitcoin (Lightning)',
    'pay.sats': '≈ {sats} sats',
    'pay.open': 'Open in wallet',
    'pay.copy': 'Copy invoice',
    'pay.copied': 'Copied',
    'pay.waiting': 'Waiting for payment …',
    'pay.paid': 'Paid. {actions} Actions were credited.',
    'pay.expired': 'The invoice expired. Please top up again.',
    'pay.cancel': 'Back',
    'pay.mock': 'Trigger test payment (local only)',

    'key.title': 'Your recovery key',
    'key.lead': 'There is no e-mail and no password. With this key you get back to your balance on other devices or after clearing cookies.',
    'key.warn': 'Important: keeping the key safe is entirely your own responsibility. We only store a hash and cannot recover it. If the key is lost, the balance is gone for good.',
    'key.create': 'Create key',
    'key.createHint': 'Recommended as soon as you have a balance.',
    'key.have': 'A key exists for this balance. It is not shown again.',
    'key.replace': 'Create a new key (the old one becomes invalid)',
    'key.copy': 'Copy',
    'key.save': 'Save as file',
    'key.saved': 'I have stored the key safely and understand that without it the balance is lost.',
    'key.done': 'Done',
    'key.loginTitle': 'Sign in with key',
    'key.loginPh': 'RLY-XXXX-XXXX-XXXX-XXXX-XXXX',
    'key.login': 'Sign in',
    'key.merged': 'Signed in. {n} Actions from this browser were added.',
    'key.loggedIn': 'Signed in.',
    'key.logout': 'Sign out',
    'key.logoutConfirm': 'Sign out? Without your key you cannot get back to this balance.',

    'hist.title': 'Transactions',
    'hist.none': 'No transactions yet.',
    'hist.more': 'Load more',
    'hist.csv': 'Top-ups as CSV (bookkeeping)',
    'hist.topup': 'Top-up',
    'hist.usage': 'Usage',
    'hist.refund': 'Refund',
    'hist.adjustment': 'Transfer',
    'hist.note': 'The usage label is shown for 30 days, then deleted.',

    'foot.imprint': 'Imprint',
    'foot.privacy': 'Privacy',
    'foot.terms': 'Terms',
    'foot.made': 'Made with',
    'foot.by': 'by',
    'foot.and': 'and',
    'cookie.note': 'We set a single, technically necessary session cookie so your balance stays yours. No tracking.',
    'cookie.ok': 'Got it',
  },
};

const pathLang = /^\/(de|en)(\/|$)/.exec(location.pathname)?.[1];
const stored = (() => { try { return localStorage.getItem('lang'); } catch { return null; } })();
let lang = pathLang || (stored === 'de' || stored === 'en' ? stored : (navigator.language || 'de').toLowerCase().startsWith('de') ? 'de' : 'en');

export const getLang = () => lang;

export function t(key, vars = {}) {
  const s = TEXTS[lang][key] ?? TEXTS.de[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', t(el.dataset.i18nTitle)); });
  document.querySelectorAll('.langs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
}

export function setLang(next, onChange) {
  if (next !== 'de' && next !== 'en') return;
  if (pathLang && next !== pathLang) {
    // Static SEO pages exist per language: hop to the sibling page.
    const alt = document.querySelector(`link[rel="alternate"][hreflang="${next}"]`);
    try { localStorage.setItem('lang', next); } catch { /* private mode */ }
    if (alt) { location.href = new URL(alt.href).pathname; return; }
  }
  lang = next;
  try { localStorage.setItem('lang', next); } catch { /* private mode */ }
  applyI18n();
  onChange?.(next);
}

export function initLangSwitch(onChange) {
  document.querySelectorAll('.langs button').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang, onChange)));
  applyI18n();
}

// --- number formats -----------------------------------------------------------
const loc = () => (lang === 'de' ? 'de-DE' : 'en-IE');
export const formatEur = (cents) => (cents / 100).toLocaleString(loc(), { style: 'currency', currency: 'EUR' });

/** milli-Aktionen -> "12,5" (no trailing zeros, max 3 decimals). */
export const formatActions = (milli) => (milli / 1000).toLocaleString(loc(), { maximumFractionDigits: 3 });
/** "12,5 Aktionen" */
export const formatActionsUnit = (milli) => `${formatActions(milli)} ${t(milli === 1000 ? 'unit.action' : 'unit.actions')}`;

export const formatDateTime = (ms) => new Date(ms).toLocaleString(loc(), { dateStyle: 'short', timeStyle: 'short' });

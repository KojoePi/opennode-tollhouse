// -----------------------------------------------------------------------------
// app.js - the whole UI. The balance shown here always comes from the server
// (/api/me); nothing about money is ever read from or written to localStorage.
// -----------------------------------------------------------------------------

import { t, getLang, applyI18n, initLangSwitch, formatEur, formatActions, formatActionsUnit, formatDateTime } from './i18n.js';
import { qrSvg } from './qr.js';

const $ = (id) => document.getElementById(id);
let OUTPUTS = []; // filled from /api/config (single source of truth: src/product/pricing.js)
// Outputs that are binary (no text preview / copy button), e.g. new Set(['pdf']).
const BINARY = new Set();

const state = {
  cfg: null,
  me: { balanceMilli: 0, hasKey: false, hasTopup: false, csrf: '' },
  selected: new Set(),
  jobs: new Map(), // id -> job view
  topupCents: null,
  payment: null,
  payTimer: null,
  histBefore: null,
};

// --- API ------------------------------------------------------------------------
class ApiError extends Error {
  constructor(code, status, data) { super(code); this.code = code; this.status = status; this.data = data; }
}

async function api(method, path, body, retried = false) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(state.me.csrf ? { 'X-CSRF-Token': state.me.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network', 0, {});
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  if (data.code === 'csrf' && !retried) {
    await loadMe(); // session (re)created: pick up the new token and retry once
    return api(method, path, body, true);
  }
  throw new ApiError(data.code || 'internal', res.status, data);
}

const errText = (code, extra = {}) => {
  const alias = { amount_too_low: 'amount', amount_too_high: 'amount', payment_unavailable: 'provider' }[code] || code;
  const k = `err.${alias}`;
  const s = t(k, extra);
  return s === k ? t('err.internal') : s;
};
const showError = (el, e) => {
  const cfg = state.cfg?.topup;
  el.textContent = errText(e.code, cfg ? { min: formatEur(cfg.minCents), max: formatEur(cfg.maxCents) } : {});
  el.hidden = false;
};

// --- wallet / me -----------------------------------------------------------------
function renderBalance() {
  $('wallet-balance').textContent = formatActions(state.me.balanceMilli);
  $('wallet-unit').textContent = t(state.me.balanceMilli === 1000 ? 'unit.action' : 'unit.actions');
  $('drawer-balance').textContent = formatActionsUnit(state.me.balanceMilli);
  $('key-have').hidden = !state.me.hasKey;
  $('key-hint').hidden = state.me.hasKey || !state.me.hasTopup;
  $('key-create').textContent = t(state.me.hasKey ? 'key.replace' : 'key.create');
  $('key-create').hidden = !state.me.hasTopup;
  $('logout').hidden = !state.me.hasKey;
  renderTotal();
}

async function loadMe() {
  const me = await api('GET', '/api/me');
  Object.assign(state.me, me);
  renderBalance();
}

function setBalance(milli) {
  if (typeof milli === 'number') { state.me.balanceMilli = milli; renderBalance(); }
}

// --- job form ------------------------------------------------------------------------
const price = (o) => state.cfg.prices[o];
const totalMilli = () => [...state.selected].reduce((s, o) => s + price(o), 0);

function renderOutputs() {
  const box = $('outputs');
  box.textContent = '';
  for (const o of OUTPUTS) {
    const label = document.createElement('label');
    label.className = 'output';
    label.innerHTML = '<input type="checkbox"><span class="box"><b><span class="n"></span><span class="price"></span></b><small class="d"></small></span>';
    const input = label.querySelector('input');
    input.value = o;
    input.checked = state.selected.has(o);
    input.addEventListener('change', () => {
      input.checked ? state.selected.add(o) : state.selected.delete(o);
      renderTotal();
    });
    label.querySelector('.n').textContent = t(`out.${o}`);
    label.querySelector('.price').textContent = formatActionsUnit(price(o));
    label.querySelector('.d').textContent = t(`out.${o}.d`);
    box.append(label);
  }
  renderTotal();
}

function renderTotal() {
  if (!state.cfg) return;
  const total = totalMilli();
  $('total').textContent = formatActionsUnit(total);
  $('submit').textContent = state.selected.size ? t('form.submitCost', { n: formatActionsUnit(total) }) : t('form.submit');
  $('submit').disabled = !state.selected.size;
  const missing = total - state.me.balanceMilli;
  $('low-hint').hidden = !(missing > 0 && state.selected.size && !$('drawer').hidden);
  $('low-hint').textContent = t('wallet.lowHint', { n: formatActionsUnit(Math.max(missing, 0)) });
}

$('job-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('form-error');
  err.hidden = true;
  if (!state.selected.size) { err.textContent = t('form.pickOne'); err.hidden = false; return; }
  $('submit').disabled = true;
  try {
    const r = await api('POST', '/api/jobs', { input: $('input').value, outputs: [...state.selected] });
    setBalance(r.balanceMilli);
    trackJob(r.job);
  } catch (e) {
    if (e.code === 'insufficient_funds') {
      setBalance(e.data.balanceMilli);
      err.textContent = t('wallet.lowHint', { n: formatActionsUnit(e.data.neededMilli - e.data.balanceMilli) });
      err.hidden = false;
      openDrawer(true);
    } else showError(err, e);
  } finally {
    $('submit').disabled = !state.selected.size;
  }
});

// --- jobs ---------------------------------------------------------------------------------
const pollers = new Map();

function trackJob(job) {
  state.jobs.set(job.id, job);
  renderJobs();
  if (job.status === 'queued' || job.status === 'processing') {
    if (pollers.has(job.id)) return;
    let delay = 800;
    const tick = async () => {
      try {
        const r = await api('GET', `/api/jobs/${job.id}`);
        setBalance(r.balanceMilli);
        state.jobs.set(job.id, r.job);
        renderJobs();
        if (r.job.status === 'queued' || r.job.status === 'processing') {
          delay = Math.min(delay * 1.25, 4000);
          pollers.set(job.id, setTimeout(tick, delay));
          return;
        }
      } catch (e) {
        if (e.code === 'not_found') state.jobs.delete(job.id);
        else { pollers.set(job.id, setTimeout(tick, 5000)); return; }
        renderJobs();
      }
      pollers.delete(job.id);
    };
    pollers.set(job.id, setTimeout(tick, delay));
  }
}

const failText = (code) => { const k = `fail.${code}`; const s = t(k); return s === k ? t('fail.internal') : s; };

function renderJobs() {
  const box = $('jobs');
  const list = [...state.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  $('jobs-section').hidden = !list.length;
  box.textContent = '';
  for (const job of list) {
    const card = document.createElement('article');
    card.className = 'card job';
    const head = document.createElement('div');
    head.className = 'job-head';
    const host = document.createElement('span');
    host.className = 'job-host';
    host.textContent = job.label;
    const st = document.createElement('span');
    st.className = `job-state ${job.status}`;
    if (job.status === 'queued' || job.status === 'processing') {
      const p = document.createElement('span');
      p.className = 'pulse';
      st.append(p);
    }
    st.append(t(`jobs.${job.status}`));
    head.append(host, st);
    card.append(head);

    const results = document.createElement('div');
    results.className = 'results';
    for (const r of job.results) {
      const row = document.createElement('div');
      row.className = 'result';
      const name = document.createElement('span');
      const n = document.createElement('span');
      n.className = 'name';
      n.textContent = t(`out.${r.output}`);
      const s = document.createElement('span');
      s.className = `state ${r.status}`;
      s.textContent = r.status === 'failed'
        ? `${failText(r.error)} (${t('res.failed', { n: formatActionsUnit(r.priceMilli) })})`
        : t(`res.${r.status}`);
      name.append(n, s);
      row.append(name);
      if (r.status === 'done') row.append(resultActions(job, r));
      results.append(row);
    }
    card.append(results);
    const pv = document.createElement('div');
    pv.id = `pv-${job.id}`;
    card.append(pv);
    if (job.status === 'completed') {
      const h = document.createElement('p');
      h.className = 'hint';
      h.textContent = t('jobs.expires', { time: formatDateTime(job.expiresAt) });
      card.append(h);
    }
    box.append(card);
    if (previews.has(job.id)) showPreview(job, previews.get(job.id));
  }
}

const previews = new Map(); // job id -> result currently previewed

function resultActions(job, r) {
  const wrap = document.createElement('span');
  wrap.className = 'result-actions';
  if (!BINARY.has(r.output)) {
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'btn small';
    view.textContent = t('res.preview');
    view.addEventListener('click', () => {
      if (previews.get(job.id)?.id === r.id) previews.delete(job.id); else previews.set(job.id, r);
      renderJobs();
    });
    wrap.append(view);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn small';
    copy.textContent = t('res.copy');
    copy.addEventListener('click', async () => {
      const txt = await (await fetch(`/api/results/${r.id}`, { credentials: 'same-origin' })).text();
      try { await navigator.clipboard.writeText(txt); copy.textContent = t('res.copied'); setTimeout(() => { copy.textContent = t('res.copy'); }, 1500); } catch { /* clipboard blocked */ }
    });
    wrap.append(copy);
  } else {
    const view = document.createElement('a');
    view.className = 'btn small';
    view.href = `/api/results/${r.id}`;
    view.target = '_blank';
    view.rel = 'noopener';
    view.textContent = t('res.view');
    wrap.append(view);
  }
  const dl = document.createElement('a');
  dl.className = 'btn small primary';
  dl.href = `/api/results/${r.id}?dl=1`;
  dl.download = r.filename || '';
  dl.textContent = t('res.download');
  wrap.append(dl);
  return wrap;
}

async function showPreview(job, r) {
  const holder = $(`pv-${job.id}`);
  if (!holder) return;
  const pre = document.createElement('pre');
  pre.className = 'preview';
  pre.textContent = '…';
  holder.append(pre);
  try {
    const res = await fetch(`/api/results/${r.id}`, { credentials: 'same-origin' });
    const txt = await res.text();
    pre.textContent = txt.length > 60000 ? `${txt.slice(0, 60000)}\n…` : txt;
  } catch { pre.textContent = t('err.network'); }
}

// --- drawer ---------------------------------------------------------------------------------
let lastFocus = null;
function openDrawer(focusTopup = false) {
  lastFocus = document.activeElement;
  $('drawer').hidden = false;
  $('scrim').hidden = false;
  loadMe().then(() => { renderTotal(); loadHistory(true); });
  renderTotal();
  (focusTopup ? $('presets').querySelector('input') : $('drawer-close'))?.focus();
}
function closeDrawer() {
  $('drawer').hidden = true;
  $('scrim').hidden = true;
  stopPayPoll();
  showPane('topup');
  lastFocus?.focus?.();
}
$('wallet-btn').addEventListener('click', () => openDrawer());
$('drawer-close').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('drawer').hidden && $('key-modal').hidden) closeDrawer();
});

// --- top-up -------------------------------------------------------------------------------------
function showPane(name) {
  $('pane-topup').hidden = name !== 'topup';
  $('pane-pay').hidden = name !== 'pay';
}

function renderPresets() {
  const box = $('presets');
  box.textContent = '';
  for (const cents of state.cfg.topup.presets) {
    const l = document.createElement('label');
    l.className = 'chip';
    l.innerHTML = '<input type="radio" name="preset"><span></span>';
    l.querySelector('input').value = cents;
    const bonus = cents >= state.cfg.topup.bonusThresholdCents ? ` <small>+${state.cfg.topup.bonusPercent}%</small>` : '';
    l.querySelector('span').innerHTML = '';
    l.querySelector('span').append(formatEur(cents).replace(/,00|\.00/, ''));
    if (bonus) { const s = document.createElement('small'); s.textContent = `+${state.cfg.topup.bonusPercent}%`; l.querySelector('span').append(s); }
    l.querySelector('input').addEventListener('change', () => selectAmount(cents));
    box.append(l);
  }
  const tp = state.cfg.topup;
  $('bonus-hint').textContent = t('wallet.bonus', { from: tp.bonusThresholdCents / 100, pct: tp.bonusPercent });
  $('limits-hint').textContent = t('wallet.limits', { min: (tp.minCents / 100).toLocaleString(getLang() === 'de' ? 'de-DE' : 'en-IE', { minimumFractionDigits: 2 }), max: tp.maxCents / 100 });
}

async function selectAmount(cents) {
  state.topupCents = cents;
  $('topup-error').hidden = true;
  $('quote').hidden = true;
  $('topup-go').disabled = true;
  try {
    const q = await api('POST', '/api/topups/quote', { eurCents: cents });
    if (state.topupCents !== cents) return;
    const bonus = q.bonusMilli ? t('wallet.quoteBonus', { bonus: formatActions(q.bonusMilli) }) : '';
    $('quote').textContent = t('wallet.quote', { actions: formatActions(q.totalMilli), bonus });
    $('quote').hidden = false;
    $('topup-go').disabled = false;
  } catch (e) { showError($('topup-error'), e); }
}

$('custom-go').addEventListener('click', () => {
  const raw = $('custom-eur').value.trim().replace(',', '.');
  const n = Number(raw);
  document.querySelectorAll('#presets input').forEach((i) => { i.checked = false; });
  if (!raw || !Number.isFinite(n)) { $('topup-error').textContent = errText('amount_too_low', { min: formatEur(state.cfg.topup.minCents), max: formatEur(state.cfg.topup.maxCents) }); $('topup-error').hidden = false; return; }
  selectAmount(Math.round(n * 100));
});
$('custom-eur').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('custom-go').click(); } });

$('topup-go').addEventListener('click', async () => {
  $('topup-error').hidden = true;
  $('pay-done').hidden = true;
  $('topup-go').disabled = true;
  try {
    const r = await api('POST', '/api/topups', { eurCents: state.topupCents });
    startPayment(r.payment);
  } catch (e) { showError($('topup-error'), e); }
  finally { $('topup-go').disabled = !state.topupCents; }
});

function startPayment(p) {
  state.payment = p;
  showPane('pay');
  $('qr').innerHTML = qrSvg(`LIGHTNING:${p.bolt11.toUpperCase()}`);
  $('pay-eur').textContent = t('pay.amount', { eur: formatEur(p.eurCents) });
  $('pay-sats').textContent = p.sats ? t('pay.sats', { sats: p.sats.toLocaleString(getLang() === 'de' ? 'de-DE' : 'en-IE') }) : '';
  $('pay-open').href = `lightning:${p.bolt11}`;
  $('pay-mock').hidden = !(state.cfg.mock && location.hostname === 'localhost');
  stopPayPoll();
  const tick = async () => {
    try {
      const r = await api('GET', `/api/topups/${p.id}`);
      Object.assign(state.me, { balanceMilli: r.balanceMilli, hasKey: r.hasKey, hasTopup: r.hasTopup });
      renderBalance();
      if (r.payment.status === 'paid') {
        stopPayPoll();
        showPane('topup');
        $('pay-done').textContent = t('pay.paid', { actions: formatActions(r.payment.creditMilli) });
        $('pay-done').hidden = false;
        $('topup-go').disabled = true;
        $('quote').hidden = true;
        document.querySelectorAll('#presets input').forEach((i) => { i.checked = false; });
        state.topupCents = null;
        loadHistory(true);
        return;
      }
      if (r.payment.status === 'expired') {
        stopPayPoll();
        showPane('topup');
        $('topup-error').textContent = t('pay.expired');
        $('topup-error').hidden = false;
        return;
      }
    } catch { /* keep polling */ }
    state.payTimer = setTimeout(tick, 2500);
  };
  state.payTimer = setTimeout(tick, 2000);
}
function stopPayPoll() { clearTimeout(state.payTimer); state.payTimer = null; }

$('pay-back').addEventListener('click', () => { stopPayPoll(); showPane('topup'); });
$('pay-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.payment.bolt11); $('pay-copy').textContent = t('pay.copied'); setTimeout(() => { $('pay-copy').textContent = t('pay.copy'); }, 1500); } catch { /* clipboard blocked */ }
});
$('pay-mock').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch(`/dev/pay/${state.payment.id}`);
});

// --- key ------------------------------------------------------------------------------------------
let keyUnlockFocus = null;
$('key-create').addEventListener('click', async () => {
  $('key-error').hidden = true;
  try {
    const r = await api('POST', '/api/key', { replace: state.me.hasKey });
    state.me.hasKey = true;
    $('key-value').textContent = r.key;
    $('key-ack').checked = false;
    $('key-done').disabled = true;
    keyUnlockFocus = document.activeElement;
    $('key-modal').hidden = false;
    $('key-copy').focus();
    renderBalance();
  } catch (e) { showError($('key-error'), e); }
});
$('key-ack').addEventListener('change', () => { $('key-done').disabled = !$('key-ack').checked; });
$('key-done').addEventListener('click', () => { $('key-value').textContent = ''; $('key-modal').hidden = true; keyUnlockFocus?.focus?.(); });
$('key-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('key-value').textContent); $('key-copy').textContent = t('res.copied'); setTimeout(() => { $('key-copy').textContent = t('key.copy'); }, 1500); } catch { /* clipboard blocked */ }
});
$('key-file').addEventListener('click', () => {
  const blob = new Blob([`Relayted Tollhouse recovery key\n\n${$('key-value').textContent}\n\nKeep this file safe. Without the key the balance cannot be recovered.\n`], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'newproject-key.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('login-go').addEventListener('click', async () => {
  $('login-error').hidden = true;
  $('login-msg').hidden = true;
  try {
    const r = await api('POST', '/api/login', { key: $('login-key').value });
    state.me.csrf = r.csrf;
    $('login-key').value = '';
    await loadMe();
    $('login-msg').textContent = r.mergedMilli ? t('key.merged', { n: formatActions(r.mergedMilli) }) : t('key.loggedIn');
    $('login-msg').hidden = false;
    state.jobs.clear();
    await loadJobs();
    loadHistory(true);
  } catch (e) { showError($('login-error'), e); }
});
$('login-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('login-go').click(); } });

$('logout').addEventListener('click', async () => {
  if (!confirm(t('key.logoutConfirm'))) return;
  try { await api('POST', '/api/logout', {}); } catch { /* ignore */ }
  state.jobs.clear();
  renderJobs();
  closeDrawer();
  await loadMe();
});

// --- history ------------------------------------------------------------------------------------------
async function loadHistory(reset = false) {
  if (reset) { state.histBefore = null; $('hist').textContent = ''; }
  try {
    const q = state.histBefore ? `?before=${state.histBefore}` : '';
    const { transactions } = await api('GET', `/api/transactions${q}`);
    if (reset && !transactions.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = t('hist.none'); $('hist').append(p); }
    for (const x of transactions) $('hist').append(txRow(x));
    state.histBefore = transactions.length ? transactions[transactions.length - 1].id : state.histBefore;
    $('hist-more').hidden = transactions.length < 50;
    $('csv-link').hidden = !state.me.hasTopup;
  } catch { /* drawer shows what it has */ }
}
function txRow(x) {
  const row = document.createElement('div');
  row.className = 'tx';
  const left = document.createElement('span');
  const what = document.createElement('span');
  const out = x.label && OUTPUTS.includes(x.label) ? ` · ${t(`out.${x.label}`)}` : '';
  what.textContent = `${t(`hist.${x.type}`)}${out}`;
  const small = document.createElement('small');
  const dom = x.domain ? `${x.domain} · ` : '';
  const eur = x.type === 'topup' && x.eur_cents ? `${formatEur(x.eur_cents)} · ` : '';
  small.textContent = `${eur}${dom}${formatDateTime(x.created_at)}`;
  left.append(what, small);
  const amt = document.createElement('span');
  amt.className = `amt ${x.amount_milli > 0 ? 'pos' : ''}`;
  amt.textContent = `${x.amount_milli > 0 ? '+' : ''}${formatActions(x.amount_milli)}`;
  row.append(left, amt);
  return row;
}
$('hist-more').addEventListener('click', () => loadHistory(false));

async function loadJobs() {
  try {
    const { jobs } = await api('GET', '/api/jobs');
    for (const j of jobs) trackJob(j);
  } catch { /* offline */ }
}

// --- cookie note + boot --------------------------------------------------------------------------------
function initCookieNote() {
  let seen = false;
  try { seen = localStorage.getItem('cookie-note') === '1'; } catch { /* ignore */ }
  $('cookie-note').hidden = seen;
  $('cookie-ok').addEventListener('click', () => { $('cookie-note').hidden = true; try { localStorage.setItem('cookie-note', '1'); } catch { /* ignore */ } });
}

function rerender() {
  if (!state.cfg) return;
  renderOutputs();
  renderPresets();
  renderBalance();
  renderJobs();
  if (!$('drawer').hidden) loadHistory(true);
}

async function boot() {
  initLangSwitch(rerender);
  initCookieNote();
  const pre = document.documentElement.dataset.output;
  const fromQuery = new URLSearchParams(location.search).get('o');
  const want = pre || fromQuery;
  try {
    state.cfg = await api('GET', '/api/config');
    OUTPUTS = state.cfg.outputs;
    if (!state.selected.size) state.selected = new Set([want && OUTPUTS.includes(want) ? want : OUTPUTS[0]]);
    await loadMe();
    rerender();
    await loadJobs();
  } catch {
    $('offline').hidden = false;
  }
}
boot();

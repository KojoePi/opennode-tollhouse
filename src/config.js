// -----------------------------------------------------------------------------
// config.js - all runtime configuration, read once from environment variables
// (a .env file is loaded by docker compose). Safe defaults everywhere except
// secrets; validateConfig() refuses to boot in production without them.
// -----------------------------------------------------------------------------

const env = process.env;

const int = (name, fallback) => {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const num = (name, fallback) => {
  const n = Number.parseFloat(env[name] ?? '');
  return Number.isFinite(n) ? n : fallback;
};
const bool = (name, fallback) => (env[name] === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(env[name].toLowerCase()));

const domain = (env.DOMAIN || 'localhost').trim();
const isLocal = domain === 'localhost';

export const config = {
  // --- HTTP -----------------------------------------------------------------
  port: int('PORT', 3000),
  domain,
  baseUrl: (env.BASE_URL || (isLocal ? 'http://localhost:3000' : `https://${domain}`)).replace(/\/+$/, ''),
  trustProxy: bool('TRUST_PROXY', false),
  secureCookies: bool('COOKIE_SECURE', !isLocal),
  dataDir: env.DATA_DIR || './data',
  projectName: (env.PROJECT_NAME || 'newproject').trim(), // used for file names (CSV export etc.)
  cookieName: (env.COOKIE_NAME || 'rly_session').trim(),
  keyPrefix: (env.KEY_PREFIX || 'RLY').trim().toUpperCase(), // recovery keys look like PREFIX-XXXX-XXXX-XXXX-XXXX-XXXX

  // --- Secrets ----------------------------------------------------------------
  keyPepper: (env.KEY_PEPPER || '').trim(), // HMAC secret for recovery-key hashes
  workerToken: (env.WORKER_TOKEN || '').trim(),

  // --- OpenNode ---------------------------------------------------------------
  opennodeApiKey: (env.OPENNODE_API_KEY || '').trim(),
  opennodeApiBase: (env.OPENNODE_API_BASE || 'https://api.opennode.com').replace(/\/+$/, ''),
  opennodeMock: bool('OPENNODE_MOCK', false),
  invoiceTtlMinutes: int('INVOICE_TTL_MINUTES', 60),

  // --- Wallet / top-ups -----------------------------------------------------------
  topupMinCents: int('TOPUP_MIN_CENTS', 25),
  topupMaxCents: int('TOPUP_MAX_CENTS', 2500),
  bonusThresholdCents: int('BONUS_THRESHOLD_CENTS', 1000),
  bonusPercent: int('BONUS_PERCENT', 10),
  sessionDays: int('SESSION_DAYS', 90),

  // --- Pricing in EUR cents per output (fractions allowed: 0.5 = half a cent) ----
  // YOUR PRODUCT: one entry per output in src/product/pricing.js (+ PRICING_<NAME>_CENTS in .env.example).
  pricing: {
    stats: num('PRICING_STATS_CENTS', 0.5),
    text: num('PRICING_TEXT_CENTS', 1),
  },

  // --- Processing limits ------------------------------------------------------------
  maxResultBytes: int('MAX_RESULT_BYTES', 20 * 1024 * 1024),
  jobTimeoutSeconds: int('JOB_TIMEOUT_SECONDS', 90),
  jobLeaseSeconds: int('JOB_LEASE_SECONDS', 180),
  maxJobAttempts: int('MAX_JOB_ATTEMPTS', 3),
  workerConcurrency: int('WORKER_CONCURRENCY', 2),
  maxQueuedJobs: int('MAX_QUEUED_JOBS', 200),

  // --- Retention ------------------------------------------------------------------------
  resultRetentionHours: int('RESULT_RETENTION_HOURS', 24),
  domainHistoryDays: int('DOMAIN_HISTORY_DAYS', 30),

  // --- Rate limits (per hour) ---------------------------------------------------------
  rateAnonJobsPerHour: int('RATE_ANON_JOBS_PER_HOUR', 20),
  rateUserJobsPerHour: int('RATE_USER_JOBS_PER_HOUR', 120),
  rateSessionsPerHourPerIp: int('RATE_SESSIONS_PER_HOUR_PER_IP', 30),
  rateKeyAttemptsPerHourPerIp: int('RATE_KEY_ATTEMPTS_PER_HOUR_PER_IP', 10),
  rateTopupsPerHour: int('RATE_TOPUPS_PER_HOUR', 15),

  // --- Legal pages ---------------------------------------------------------------------
  legal: {
    name: env.LEGAL_NAME || '[Name / Company]',
    address: env.LEGAL_ADDRESS || '[Street, ZIP City]',
    email: env.LEGAL_EMAIL || '[E-mail]',
    vatId: env.LEGAL_VAT_ID || '',
  },
};

export function validateConfig(c = config) {
  const problems = [];
  if (!c.workerToken || c.workerToken.length < 24) problems.push('WORKER_TOKEN must be a random string of at least 24 characters.');
  if (!c.keyPepper || c.keyPepper.length < 24) problems.push('KEY_PEPPER must be a random string of at least 24 characters.');
  if (!c.opennodeMock && !c.opennodeApiKey) problems.push('OPENNODE_API_KEY is not set (or use OPENNODE_MOCK=1 locally).');
  if (c.opennodeMock && c.domain !== 'localhost') problems.push('OPENNODE_MOCK=1 is only allowed with DOMAIN=localhost.');
  if (c.topupMinCents < 1 || c.topupMaxCents < c.topupMinCents) problems.push('Top-up limits are invalid.');
  for (const [k, v] of Object.entries(c.pricing)) if (!(v > 0)) problems.push(`PRICING_${k.toUpperCase()}_CENTS must be > 0.`);
  if (problems.length) throw new Error('Invalid configuration:\n - ' + problems.join('\n - '));
}

// In-memory sliding-window rate limiter. Good enough for one web process.
const buckets = new Map();

/** Returns true when the call is allowed, false when `limit` per `windowMs` is exceeded. */
export function hit(key, limit, windowMs, now = Date.now()) {
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

/** Drop idle buckets (called from housekeeping). */
export function sweep(windowMs = 3_600_000, now = Date.now()) {
  for (const [k, arr] of buckets) if (!arr.some((t) => now - t < windowMs)) buckets.delete(k);
}

export function reset() {
  buckets.clear();
}

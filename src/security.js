// -----------------------------------------------------------------------------
// security.js - SSRF protection shared by the web server AND the worker.
//
// This service opens URLs chosen by strangers, so nobody may point it at our own
// infrastructure (localhost, Docker network, cloud metadata, ...). Layers:
//   1. parseTargetUrl()  - syntax checks (scheme, credentials, literal IPs)
//   2. safeLookup()      - DNS answers are checked at connect time (no rebinding window)
//   3. every redirect hop is validated again (see worker/fetcher.js)
//   4. worker container: iptables rules drop traffic to private ranges, which
//      also covers the real browser (Chromium).
//
// No dependencies, so the file can be copied into the worker image.
// -----------------------------------------------------------------------------

import net from 'node:net';
import dns from 'node:dns';

/** Error with a machine-readable `code` the frontend translates. */
export class UserError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

const blocked = new net.BlockList();
const V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6 = [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['100::', 64], ['2001::', 32],
];
for (const [a, p] of V4) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of V6) blocked.addSubnet(a, p, 'ipv6');

function expandIPv6(ip) {
  let addr = ip.split('%')[0];
  const tail = addr.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    addr = addr.replace(tail[0], ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16));
  }
  const parts = addr.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if ((parts.length === 1 && fill !== 0) || fill < 0) return null;
  const groups = [...head, ...Array(parts.length === 2 ? fill : 0).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => Number.parseInt(g, 16));
  return nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? null : nums;
}

/** True when `ip` is loopback/private/link-local/reserved (or unparsable). */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  if (net.isIPv6(ip)) {
    const g = expandIPv6(ip);
    if (!g) return true;
    const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) {
      return blocked.check(v4(g[6], g[7]), 'ipv4') || (g[5] === 0 && g[6] === 0 && g[7] <= 1);
    }
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return blocked.check(v4(g[6], g[7]), 'ipv4');
    if (g[0] === 0x2002) return blocked.check(v4(g[1], g[2]), 'ipv4');
    return blocked.check(ip.split('%')[0], 'ipv6');
  }
  return true;
}

const BAD_SUFFIXES = ['.local', '.localhost', '.internal', '.localdomain', '.lan', '.home', '.corp', '.intranet'];

/** Validate + normalise a user supplied URL -> { href, host }; throws UserError('bad_url'|'blocked_address'). */
export function parseTargetUrl(input) {
  let raw = String(input ?? '').trim();
  if (!raw || raw.length > 2048) throw new UserError('bad_url');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UserError('bad_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UserError('bad_url');
  if (u.username || u.password) throw new UserError('bad_url');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new UserError('bad_url');
  if (host === 'localhost' || BAD_SUFFIXES.some((s) => host.endsWith(s))) throw new UserError('blocked_address');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new UserError('blocked_address');
  } else if (!host.includes('.')) {
    throw new UserError('blocked_address');
  }
  return { href: u.href, host };
}

/** dns.lookup replacement that refuses private answers (pass as `lookup` to http(s).request). */
export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses.filter((a) => !isPrivateIp(a.address));
    if (list.length === 0 || list.length !== addresses.length) return callback(new UserError('blocked_address'));
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/** Resolve a hostname and throw when any answer is private. */
export async function assertPublicHost(host) {
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new UserError('blocked_address');
    return;
  }
  const answers = await dns.promises.lookup(host, { all: true }).catch(() => {
    throw new UserError('unreachable');
  });
  if (!answers.length || answers.some((a) => isPrivateIp(a.address))) throw new UserError('blocked_address');
}

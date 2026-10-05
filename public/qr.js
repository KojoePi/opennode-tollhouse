// -----------------------------------------------------------------------------
// qr.js - small dependency-free QR code encoder (ISO 18004 model 2).
//
// Supports alphanumeric mode (perfect for upper-cased Lightning invoices) and
// byte mode (UTF-8), versions 1-40, error correction L and M.
//
// Usage:  import { qrSvg } from './qr.js';   qrSvg('LIGHTNING:LNBC...')  -> "<svg>...</svg>"
// -----------------------------------------------------------------------------

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// Index = version (1..40). Values from the QR specification.
const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const NUM_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};
const FORMAT_BITS = { L: 1, M: 0 };

/** Number of data modules (bits) available in a symbol of the given version. */
function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(ver, ecl) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
}

// --- Reed-Solomon over GF(256), polynomial 0x11D -----------------------------------
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((c, i) => { result[i] ^= gfMul(c, factor); });
  }
  return result;
}

// --- Bit stream ---------------------------------------------------------------------
function pushBits(bits, value, len) {
  for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function makeSegment(text) {
  if (/^[0-9A-Z $%*+\-./:]*$/.test(text)) {
    return { mode: 2, count: text.length, write(bits) {
      let i = 0;
      for (; i + 1 < text.length; i += 2) pushBits(bits, ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
      if (i < text.length) pushBits(bits, ALNUM.indexOf(text[i]), 6);
    } };
  }
  const bytes = new TextEncoder().encode(text);
  return { mode: 4, count: bytes.length, write(bits) { for (const b of bytes) pushBits(bits, b, 8); } };
}

const countBits = (mode, ver) => (mode === 4 ? (ver <= 9 ? 8 : 16) : (ver <= 9 ? 9 : ver <= 26 ? 11 : 13));

function buildData(seg, ver, ecl) {
  const bits = [];
  pushBits(bits, seg.mode, 4);
  pushBits(bits, seg.count, countBits(seg.mode, ver));
  seg.write(bits);
  const capacityBits = dataCodewords(ver, ecl) * 8;
  if (bits.length > capacityBits) return null;
  pushBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    bytes.push(b);
  }
  for (let pad = 0xec; bytes.length < capacityBits / 8; pad ^= 0xec ^ 0x11) bytes.push(pad);
  return bytes;
}

/** Split into blocks, add error correction and interleave (spec section 7.6). */
function addEccAndInterleave(data, ver, ecl) {
  const numBlocks = NUM_BLOCKS[ecl][ver];
  const eccLen = ECC_PER_BLOCK[ecl][ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
    });
  }
  return result;
}

// --- Symbol drawing ---------------------------------------------------------------
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const res = [6];
  for (let pos = ver * 4 + 10; res.length < n; pos -= step) res.splice(1, 0, pos);
  return res;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0,
  (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
];

function penalty(m, size) {
  let score = 0;
  const finderLike = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const reversed = [...finderLike].reverse();
  const scanLine = (get) => {
    // rule 1: runs of 5+ same-colour modules, rule 3: finder-like pattern
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; } else run = 1;
    }
    for (let i = 0; i + 11 <= size; i++) {
      let a = true, b = true;
      for (let k = 0; k < 11; k++) {
        const v = get(i + k) ? 1 : 0;
        if (v !== finderLike[k]) a = false;
        if (v !== reversed[k]) b = false;
      }
      if (a) score += 40;
      if (b) score += 40;
    }
  };
  for (let y = 0; y < size; y++) scanLine((x) => m[y][x]);
  for (let x = 0; x < size; x++) scanLine((y) => m[y][x]);
  // rule 2: 2x2 blocks
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }
  // rule 4: balance of dark and light modules
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

function buildSymbol(codewords, ver, ecl) {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { modules[y][x] = dark; isFunc[y][x] = true; };

  // Timing patterns
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  // Finder patterns with separators
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  // Alignment patterns
  const pos = alignmentPositions(ver);
  pos.forEach((py, i) => pos.forEach((px, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));

  const drawFormat = (mask) => {
    const data = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true); // always-dark module
  };
  drawFormat(0); // reserve the area; rewritten with the real mask below

  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      setFn(a, b, dark); setFn(b, a, dark);
    }
  }

  // Place data bits in the zig-zag order
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunc[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }

  // Choose the best mask
  const apply = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunc[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
  };
  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    apply(mask); drawFormat(mask);
    const score = penalty(modules, size);
    if (score < bestScore) { best = mask; bestScore = score; }
    apply(mask); // undo (XOR)
  }
  apply(best); drawFormat(best);
  return { size, modules };
}

/**
 * Encode text as a QR code.
 * @param {string} text
 * @param {'L'|'M'|'auto'} ecl  'auto' = M while the symbol stays small, else L
 * @returns {{size:number, version:number, modules:boolean[][]}}
 */
export function encodeQr(text, ecl = 'auto') {
  const seg = makeSegment(text);
  const levels = ecl === 'auto' ? ['M', 'L'] : [ecl];
  for (const level of levels) {
    const maxVer = ecl === 'auto' && level === 'M' ? 16 : 40;
    for (let ver = 1; ver <= maxVer; ver++) {
      const data = buildData(seg, ver, level);
      if (!data) continue;
      const symbol = buildSymbol(addEccAndInterleave(data, ver, level), ver, level);
      return { ...symbol, version: ver };
    }
  }
  throw new Error('qr: text too long');
}

/** SVG string with a 4-module quiet zone, one <path> for all dark modules. */
export function qrSvg(text, ecl = 'auto') {
  const { size, modules } = encodeQr(text, ecl);
  const border = 4;
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (modules[y][x]) d += `M${x + border},${y + border}h1v1h-1z`;
  }
  const dim = size + border * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

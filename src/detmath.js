// Platform-deterministic elementary functions.
//
// Why: Math.exp / Math.log / Math.cos / Math.sin / Math.pow are "implementation-approximated" in
// ECMAScript. V8 ships its own fdlibm port, but the C++ is compiled per platform and on arm64
// (Apple Silicon) the compiler may fuse multiply-adds, so results can differ from x86-64 Linux in
// the last bit. That was enough to make data/prior.json (generated on macOS arm64) differ from
// what CI regenerated on ubuntu-latest. These versions use only +, -, *, / and Math.sqrt, which
// IEEE 754 requires to be correctly rounded on every platform, plus exact bit manipulation, so
// they return bit-identical results everywhere. Accuracy is within ~2 ulp of the true value.

const LN2_HI = 6.93147180369123816490e-01; // high bits of ln 2 (trailing zeros, so k * LN2_HI is exact)
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e+00;
const PIO2_HI = 1.57079632673412561417e+00; // pi/2 split for Cody-Waite reduction
const PIO2_LO = 6.07710050650619224932e-11;
const INV_PIO2 = 6.36619772367581382433e-01;

const buf = new DataView(new ArrayBuffer(8));

/** Exact 2^k for integer k (handles the subnormal range by splitting the scale). */
function pow2(k) {
  if (k > 1023) return Infinity;
  if (k < -1074) return 0;
  if (k < -1022) return pow2(k + 54) * 5.551115123125783e-17; // 2^-54, exact
  buf.setUint32(0, (k + 1023) << 20); buf.setUint32(4, 0);
  return buf.getFloat64(0);
}

export function dexp(x) {
  if (x !== x) return NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019412) return 0;
  const k = Math.round(x * INV_LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO; // |r| <= 0.347
  // Taylor series to r^17/17! (< 1e-19 relative for |r| <= 0.347), Horner form
  let p = 1;
  for (let n = 17; n >= 1; n--) p = 1 + (r * p) / n;
  if (k < -1021) return (p * pow2(k + 60)) * pow2(-60);
  if (k > 1022) return (p * pow2(k - 1)) * 2;
  return p * pow2(k);
}

export function dlog(x) {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let e = 0;
  if (x < 2.2250738585072014e-308) { x *= 18014398509481984; e = -54; } // subnormal: scale by 2^54
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  e += ((hi >>> 20) & 0x7ff) - 1023;
  buf.setUint32(0, (hi & 0x000fffff) | 0x3ff00000);
  let m = buf.getFloat64(0); // m in [1, 2)
  if (m > Math.SQRT2) { m /= 2; e += 1; } // exact; m in (0.707, 1.414]
  const f = (m - 1) / (m + 1), f2 = f * f; // |f| <= 0.1716
  // log(m) = 2 atanh(f) = 2 (f + f^3/3 + f^5/5 + ...), terms to f^29
  let s = 0;
  for (let n = 29; n >= 3; n -= 2) s = (s + 1 / n) * f2;
  const lm = 2 * f + 2 * f * s;
  return e * LN2_HI + (e * LN2_LO + lm);
}

// sin/cos on |r| <= pi/4 by Taylor series (error < 1e-18)
function sinK(r) { const r2 = r * r; let p = 0; for (let n = 21; n >= 3; n -= 2) p = (1 - p) * r2 / (n * (n - 1)); return r - r * p; }
function cosK(r) { const r2 = r * r; let p = 0; for (let n = 22; n >= 2; n -= 2) p = (1 - p) * r2 / (n * (n - 1)); return 1 - p; }

function reduce(x) {
  // Cody-Waite reduction; accurate for |x| < ~1e5, far beyond what this module uses
  const n = Math.round(x * INV_PIO2);
  return [(x - n * PIO2_HI) - n * PIO2_LO, ((n % 4) + 4) % 4];
}
export function dsin(x) {
  if (!Number.isFinite(x)) return NaN;
  const [r, q] = reduce(x);
  return q === 0 ? sinK(r) : q === 1 ? cosK(r) : q === 2 ? -sinK(r) : -cosK(r);
}
export function dcos(x) {
  if (!Number.isFinite(x)) return NaN;
  const [r, q] = reduce(x);
  return q === 0 ? cosK(r) : q === 1 ? -sinK(r) : q === 2 ? -cosK(r) : sinK(r);
}
/** a^b for a > 0 (the only case this module needs). */
export function dpow(a, b) {
  if (a === 0) return b > 0 ? 0 : Infinity;
  return dexp(b * dlog(a));
}

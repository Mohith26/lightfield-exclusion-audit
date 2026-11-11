// Exclusion audit: core statistics (no DOM). Runs in the browser and in Node.
//
// Problem: exclusion categories hide mail and meetings that Jev scores as
// matching a category. Some hidden items are real customer conversations.
// We want an honest estimate, with a confidence interval, of how many real
// conversations are hidden, using as few user spot-checks as possible, and a
// a fix: a CRM guard that syncs back excluded activity whenever a participant
// is on an open CRM record (exclusion categories never look at the CRM).
//
// Method: prediction-powered inference (Angelopoulos et al., Science 2023)
// with an active sampling design (Zrnic & Candes, "Active Statistical
// Inference", ICML 2024). Jev's probability gives a prediction f_i for every
// excluded item; spot-checks are drawn with replacement from a design pi
// that favours uncertain items and items touching an open CRM record, mixed
// with a uniform floor so every item can be drawn. The Hansen-Hurwitz
// rectified estimator
//     M_hat = sum_i f_i + (1/n) sum_j (y_j - f_j) / pi_j
// is unbiased for the true hidden count M whatever f is, so a miscalibrated
// Jev only costs width, never bias.

import { dexp, dlog, dsin, dcos, dpow } from './detmath.js';

export const Z95_TWO = 1.959963984540054;

/** Seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inverse standard normal CDF (Acklam's algorithm, |err| < 1.2e-9). */
export function normInv(p) {
  if (!(p > 0 && p < 1)) throw new RangeError('p must be in (0,1)');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  let q, r;
  if (p < lo) {
    q = Math.sqrt(-2 * dlog(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > hi) {
    q = Math.sqrt(-2 * dlog(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Prediction for "this hidden item is a real conversation": 1 - Jev's match probability. */
export function predictions(items) {
  return items.map((it) => Math.min(1, Math.max(0, 1 - it.p)));
}

/**
 * Sampling design. u_i = sqrt(f_i (1 - f_i)) * (1 + kappa * crm_i), which is
 * the Zrnic-Candes variance-optimal shape sqrt(E[(y-f)^2]) under calibration,
 * boosted for items touching an open CRM record (Jev never sees the CRM).
 * A uniform floor gamma/N keeps every pi_i > 0, which unbiasedness needs.
 */
export function samplingDesign(items, f, { gamma = 0.25, kappa = 3 } = {}) {
  const N = items.length;
  if (N === 0) return new Float64Array(0);
  const u = new Float64Array(N);
  let su = 0;
  for (let i = 0; i < N; i++) {
    const v = Math.sqrt(Math.max(f[i] * (1 - f[i]), 1e-6)) * (1 + kappa * (items[i].crm ? 1 : 0));
    u[i] = v; su += v;
  }
  const pi = new Float64Array(N);
  for (let i = 0; i < N; i++) pi[i] = (1 - gamma) * (u[i] / su) + gamma / N;
  return pi;
}

/** Walker alias table for O(1) draws from a discrete distribution. */
export function aliasTable(pi) {
  const n = pi.length;
  const prob = new Float64Array(n), alias = new Int32Array(n);
  const scaled = Array.from(pi, (x) => x * n);
  const small = [], large = [];
  scaled.forEach((x, i) => (x < 1 ? small : large).push(i));
  while (small.length && large.length) {
    const s = small.pop(), l = large.pop();
    prob[s] = scaled[s]; alias[s] = l;
    scaled[l] = scaled[l] + scaled[s] - 1;
    (scaled[l] < 1 ? small : large).push(l);
  }
  for (const i of large) prob[i] = 1;
  for (const i of small) prob[i] = 1;
  return { prob, alias };
}

/** n i.i.d. draws (with replacement) from pi, seeded. */
export function drawSequence(pi, n, seed) {
  const rng = mulberry32(seed);
  const { prob, alias } = aliasTable(pi);
  const out = new Int32Array(n);
  for (let t = 0; t < n; t++) {
    const k = Math.floor(rng() * pi.length);
    out[t] = rng() < prob[k] ? k : alias[k];
  }
  return out;
}

/**
 * Prediction-powered estimate of the hidden real-conversation count within a
 * subset S (mask, or all items when mask is null) from the first n labelled
 * draws. labels[t] is 1 (belongs in CRM) or 0 (correctly excluded).
 * Returns the point estimate, standard error and a two-sided interval, clipped
 * to [real conversations already found in S, |S|].
 */
export function ppiEstimate(f, pi, draws, labels, { n = labels.length, mask = null, z = Z95_TWO } = {}) {
  let base = 0, size = 0;
  for (let i = 0; i < f.length; i++) if (!mask || mask[i]) { base += f[i]; size++; }
  const found = new Set();
  let s1 = 0, s2 = 0;
  for (let t = 0; t < n; t++) {
    const i = draws[t];
    const inS = !mask || mask[i];
    const dterm = inS ? (labels[t] - f[i]) / pi[i] : 0;
    s1 += dterm; s2 += dterm * dterm;
    if (inS && labels[t] === 1) found.add(i);
  }
  if (n === 0) return { est: base, se: NaN, lo: 0, hi: size, found: 0, size, n };
  const mean = s1 / n;
  const varD = n > 1 ? Math.max(0, (s2 - n * mean * mean) / (n - 1)) : NaN;
  const se = n > 1 ? Math.sqrt(varD / n) : NaN;
  const est = base + mean;
  // Interval on the log scale (delta method) when the estimate is clearly
  // positive: the rectified mean is right-skewed (a rare real conversation in a
  // low-prior region carries a large weight), so a symmetric interval misses
  // high more often than low. Linear interval near zero.
  let lo = found.size, hi = size;
  if (Number.isFinite(se)) {
    if (est > 1) { const r = dexp(z * se / est); lo = est / r; hi = est * r; }
    else { lo = est - z * se; hi = est + z * se; }
    lo = Math.max(found.size, lo); hi = Math.min(size, hi);
  }
  return { est: Math.min(size, Math.max(found.size, est)), rawEst: est, se, lo, hi, found: found.size, size, n };
}

/** Wilson score interval for a binomial proportion, scaled to a population of N. */
export function wilsonCount(N, n, k, z = Z95_TWO) {
  if (n === 0) return { est: NaN, lo: 0, hi: N };
  const ph = k / n, z2 = z * z;
  const den = 1 + z2 / n;
  const mid = (ph + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt(ph * (1 - ph) / n + z2 / (4 * n * n))) / den;
  return { est: N * ph, lo: N * Math.max(0, mid - half), hi: N * Math.min(1, mid + half) };
}

/** Baseline: n uniform spot-checks (with replacement), Wilson interval. */
export function uniformEstimate(N, drawsU, truth, n = drawsU.length) {
  let k = 0;
  for (let t = 0; t < n; t++) k += truth[drawsU[t]];
  return { k, ...wilsonCount(N, n, k) };
}

/** What Jev's probabilities alone imply: sum of f (no labels, no interval). */
export function jevOnly(f, mask = null) {
  let s = 0;
  for (let i = 0; i < f.length; i++) if (!mask || mask[i]) s += f[i];
  return s;
}

/** Exact (all-information) hidden count, for evaluation only. */
export function trueHidden(items, mask = null) {
  let s = 0;
  for (let i = 0; i < items.length; i++) if (!mask || mask[i]) s += items[i].y;
  return s;
}

/** CSV export of per-category audit rows. */
export function toCSV(rows) {
  const cols = Object.keys(rows[0] || {});
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Audit prior: a small logistic calibrator on top of Jev, trained on a
// separate history of "Sync anyway" decisions (never on this audit's labels,
// which PPI requires). Features: logit of Jev's non-match probability, whether
// any participant is on an open CRM record (Jev never sees the CRM), and the
// category. PPI stays unbiased even if this prior is wrong.

const logit = (q) => { const c = Math.min(1 - 1e-4, Math.max(1e-4, q)); return dlog(c / (1 - c)); };

export function features(it, nCat) {
  const x = new Float64Array(3 + nCat);
  x[0] = 1; x[1] = logit(1 - it.p); x[2] = it.crm ? 1 : 0;
  x[3 + it.c] = 1;
  return x;
}

/** Ridge-penalised logistic regression by Newton's method. */
export function fitCalibrator(items, ys, nCat, { l2 = 1, iters = 30 } = {}) {
  const d = 3 + nCat;
  const w = new Float64Array(d);
  const X = items.map((it) => features(it, nCat));
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(d);
    const H = Array.from({ length: d }, () => new Float64Array(d));
    for (let j = 0; j < d; j++) { if (j > 0) { g[j] += l2 * w[j]; H[j][j] += l2; } else H[0][0] += 1e-8; }
    for (let i = 0; i < X.length; i++) {
      const x = X[i];
      let s = 0; for (let j = 0; j < d; j++) s += w[j] * x[j];
      const p = 1 / (1 + dexp(-s));
      const r = p - ys[i], v = p * (1 - p);
      for (let j = 0; j < d; j++) {
        if (!x[j]) continue;
        g[j] += r * x[j];
        for (let k = 0; k < d; k++) if (x[k]) H[j][k] += v * x[j] * x[k];
      }
    }
    const step = solve(H, g);
    let mx = 0;
    for (let j = 0; j < d; j++) { w[j] -= step[j]; mx = Math.max(mx, Math.abs(step[j])); }
    if (mx < 1e-9) break;
  }
  return Array.from(w);
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export function calibratedPredictions(items, coef, nCat) {
  return items.map((it) => {
    const x = features(it, nCat);
    let s = 0; for (let j = 0; j < x.length; j++) s += coef[j] * x[j];
    return 1 / (1 + dexp(-s));
  });
}

// ---------------------------------------------------------------------------
// Shared pipeline used by the app, the evaluation script and the tests, so
// every number on the page comes from the same code.

export const DESIGN = { gamma: 0.2, kappa: 0 };
export const QUEUE_SEED = 4242;
export const QUEUE_LEN = 400;
export const UNIFORM_SEED = 9090; // random spot-check baseline (simulation only)

/** Unpack the string-tabled mailbox written by scripts/generate.mjs. */
export function unpack(mb) {
  if (!mb.strings) return mb;
  const S = mb.strings;
  const items = mb.items.map((r) => ({
    id: r[0], k: r[1], c: r[2], p: r[3], y: r[4], crm: r[5], d: r[6],
    from: S[r[7]], email: S[r[8]], subj: S[r[9]], snip: S[r[10]], acct: r[11] < 0 ? null : S[r[11]], sub: S[r[12]],
  }));
  return { ...mb, items };
}

export function prepare(mailbox, coef) {
  const items = mailbox.items;
  const nCat = mailbox.categories.length;
  const f = calibratedPredictions(items, coef, nCat);
  const jevF = predictions(items);
  const pi = samplingDesign(items, f, DESIGN);
  const queue = drawSequence(pi, QUEUE_LEN, QUEUE_SEED);
  return { items, nCat, f, jevF, pi, queue, categories: mailbox.categories };
}

/** Items the CRM guard would sync back: excluded, a participant on an open CRM record, category guarded. */
export function guardMask(items, guarded) {
  return items.map((it) => !!it.crm && !!guarded[it.c]);
}

/**
 * Everything the Audit page shows, from the first n labels of the queue.
 * labels: array of 0/1 for queue positions 0..n-1.
 * guarded: per-category booleans for the CRM guard (applied state).
 */
export function summarize(prep, labels, { guarded = {}, n = labels.length, manual = [] } = {}) {
  const { items, f, jevF, pi, queue, nCat } = prep;
  const lab = labels.slice(0, n);
  const synced = new Set();
  for (let t = 0; t < n; t++) if (lab[t] === 1) synced.add(queue[t]);
  // Items synced by hand from the lists leave the hidden set. They are not
  // audit labels (they were not drawn by the design), so they only shrink the mask.
  for (const i of manual) synced.add(i);
  const unique = new Set(Array.from(queue.slice(0, n)));
  const total = ppiEstimate(f, pi, queue, lab, { n });
  const g = guardMask(items, guarded);
  const back = g.reduce((a, b) => a + (b ? 1 : 0), 0);
  const recovered = back ? ppiEstimate(f, pi, queue, lab, { n, mask: g }) : null;
  const remainMask = items.map((it, i) => !g[i] && !synced.has(i));
  const remaining = ppiEstimate(f, pi, queue, lab, { n, mask: remainMask });
  // The point estimate for what stays hidden rests on a low-prior pool that few
  // draws reach, so report a conservative upper bound instead: hidden(R) =
  // total - hidden(guarded) - hidden(synced outside the guard), hence
  // hidden(R) <= total.hi - guarded.lo - known positives outside the guard
  // (union bound over the two intervals).
  const knownOutside = new Set(Array.from(queue.slice(0, n)).filter((i, t) => lab[t] === 1 && !g[i])).size;
  const remainingUpper = Math.min(remaining.size, Math.max(0, total.hi - (recovered ? recovered.lo : 0) - knownOutside));
  const byCategory = [];
  for (let c = 0; c < nCat; c++) {
    const mask = items.map((it) => it.c === c);
    const r = ppiEstimate(f, pi, queue, lab, { n, mask });
    let inCat = 0;
    for (const i of unique) if (items[i].c === c) inCat++;
    const crmCount = items.reduce((a, it) => a + (it.c === c && it.crm ? 1 : 0), 0);
    const gm = items.map((it) => it.c === c && !!it.crm);
    const rec = crmCount ? ppiEstimate(f, pi, queue, lab, { n, mask: gm }) : null;
    byCategory.push({ c, excluded: r.size, checked: inCat, found: r.found, est: r.est, lo: r.lo, hi: r.hi, jev: jevOnly(jevF, mask), crmCount, guardEst: rec ? rec.est : 0 });
  }
  return { n, unique: unique.size, total, jev: jevOnly(jevF), prior: jevOnly(f), back, recovered, remaining, remainingUpper, byCategory, synced: synced.size };
}

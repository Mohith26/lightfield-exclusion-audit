// Computes data/results.json: the headline audit on the shipped mailbox and a
// coverage study. Every number in the README and the email comes from here.
// Usage: node scripts/evaluate.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import * as A from '../src/audit.js';
import { generate, trainPrior } from './generate.mjs';

export const HEADLINE_N = 60;

export function headline(mailbox, prior, n = HEADLINE_N) {
  const prep = A.prepare(mailbox, prior.coef);
  const { items, queue } = prep;
  const labels = Array.from(queue.slice(0, n), (i) => items[i].y);
  const allGuard = Object.fromEntries(mailbox.categories.map((_, c) => [c, true]));
  const s = A.summarize(prep, labels, { guarded: allGuard });
  const N = items.length;
  const truth = A.trueHidden(items);
  const gmask = A.guardMask(items, allGuard);
  const uni = A.uniformEstimate(N, A.drawSequence(new Float64Array(N).fill(1 / N), n, A.UNIFORM_SEED), items.map((i) => i.y));
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    n, uniqueChecks: s.unique, excluded: N, truth,
    ppi: { est: r1(s.total.est), lo: r1(s.total.lo), hi: r1(s.total.hi), width: r1(s.total.hi - s.total.lo) },
    uniform: { found: uni.k, est: r1(uni.est), lo: r1(uni.lo), hi: r1(uni.hi), width: r1(uni.hi - uni.lo) },
    jevOnly: r1(s.jev), priorOnly: r1(s.prior),
    crmGuard: { syncedBack: s.back, realAmongThem: A.trueHidden(items, gmask), est: r1(s.recovered.est), remainingTruth: truth - A.trueHidden(items, gmask), remainingUpper: r1(s.remainingUpper) },
  };
}

function coverage(mailbox, prior, ns, R) {
  const prep = A.prepare(mailbox, prior.coef);
  const { items, f, pi } = prep, y = items.map((i) => i.y), N = items.length, M = A.trueHidden(items);
  const piU = new Float64Array(N).fill(1 / N);
  const out = {};
  for (const n of ns) {
    let c = 0, w = 0, cu = 0, wu = 0;
    for (let s = 0; s < R; s++) {
      const d = A.drawSequence(pi, n, 100000 + s);
      const r = A.ppiEstimate(f, pi, d, Array.from(d, (i) => y[i]));
      c += r.lo <= M && M <= r.hi; w += r.hi - r.lo;
      const u = A.uniformEstimate(N, A.drawSequence(piU, n, 200000 + s), y);
      cu += u.lo <= M && M <= u.hi; wu += u.hi - u.lo;
    }
    out[n] = { ppiCoverage: c / R, ppiMeanWidth: Math.round(w / R), uniformCoverage: cu / R, uniformMeanWidth: Math.round(wu / R) };
  }
  return out;
}

function perCategoryCoverage(mailbox, prior, n, R) {
  const prep = A.prepare(mailbox, prior.coef);
  const { items, f, pi } = prep, y = items.map((i) => i.y);
  return mailbox.categories.map((cat, c) => {
    const mask = items.map((it) => it.c === c), M = A.trueHidden(items, mask);
    let cov = 0;
    for (let s = 0; s < R; s++) {
      const d = A.drawSequence(pi, n, 300000 + s);
      const r = A.ppiEstimate(f, pi, d, Array.from(d, (i) => y[i]), { mask });
      cov += r.lo <= M && M <= r.hi;
    }
    return { category: cat.name, truth: M, coverage: cov / R };
  });
}

function otherMailboxes(prior, n, K) {
  let cov = 0, w = 0;
  const per = [];
  for (let k = 1; k <= K; k++) {
    const mb = generate(5000 + k, { drift: 0.3 });
    const prep = A.prepare(mb, prior.coef);
    const { items, f, pi } = prep, M = A.trueHidden(items);
    let ck = 0;
    for (let s = 0; s < 50; s++) {
      const d = A.drawSequence(pi, n, 400000 + 97 * k + s);
      const r = A.ppiEstimate(f, pi, d, Array.from(d, (i) => items[i].y));
      ck += r.lo <= M && M <= r.hi; w += r.hi - r.lo;
    }
    cov += ck; per.push(ck / 50);
  }
  return { mailboxes: K, auditsPerMailbox: 50, coverage: cov / (K * 50), meanWidth: Math.round(w / (K * 50)), worstMailboxCoverage: Math.min(...per) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mailbox = A.unpack(JSON.parse(readFileSync(new URL('../data/mailbox.json', import.meta.url))));
  const prior = JSON.parse(readFileSync(new URL('../data/prior.json', import.meta.url)));
  const fresh = trainPrior();
  if (JSON.stringify(fresh.coef) !== JSON.stringify(prior.coef)) throw new Error('prior.json is stale; rerun generate.mjs');
  const res = {
    generated: 'node scripts/evaluate.mjs',
    headline: headline(mailbox, prior),
    coverage: coverage(mailbox, prior, [30, 60, 100], 1000),
    perCategoryCoverageAt60: perCategoryCoverage(mailbox, prior, 60, 1000),
    otherMailboxesAt60: otherMailboxes(prior, 60, 40),
    otherMailboxesAt120: otherMailboxes(prior, 120, 40),
  };
  writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
}

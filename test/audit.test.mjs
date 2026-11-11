import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as A from '../src/audit.js';
import { generate, pack, trainPrior } from '../scripts/generate.mjs';
import { headline } from '../scripts/evaluate.mjs';

const mailbox = A.unpack(JSON.parse(readFileSync(new URL('../data/mailbox.json', import.meta.url))));
const prior = JSON.parse(readFileSync(new URL('../data/prior.json', import.meta.url)));
const results = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));

test('mulberry32 is deterministic and in [0,1)', () => {
  const a = A.mulberry32(7), b = A.mulberry32(7);
  for (let i = 0; i < 1000; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
});

test('normInv matches standard normal quantiles', () => {
  assert.ok(Math.abs(A.normInv(0.975) - 1.959964) < 1e-6);
  assert.ok(Math.abs(A.normInv(0.5)) < 1e-12);
  assert.ok(Math.abs(A.normInv(0.001) + 3.090232) < 1e-5);
});

test('sampling design is a distribution with a uniform floor', () => {
  const f = A.calibratedPredictions(mailbox.items, prior.coef, 8);
  const pi = A.samplingDesign(mailbox.items, f, A.DESIGN);
  const s = pi.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(s - 1) < 1e-9);
  const floor = A.DESIGN.gamma / pi.length;
  for (const p of pi) assert.ok(p >= floor - 1e-15);
});

test('alias sampler draws with the right frequencies', () => {
  const pi = Float64Array.from([0.5, 0.3, 0.15, 0.05]);
  const d = A.drawSequence(pi, 200000, 3);
  const cnt = [0, 0, 0, 0];
  for (const i of d) cnt[i]++;
  cnt.forEach((c, i) => assert.ok(Math.abs(c / 200000 - pi[i]) < 0.005, `bin ${i}`));
});

test('property: rectified estimator is unbiased for random populations and a deliberately wrong prior', () => {
  const rng = A.mulberry32(11);
  for (let trial = 0; trial < 6; trial++) {
    const N = 200 + Math.floor(rng() * 300);
    const items = Array.from({ length: N }, () => ({ p: 0.5 + 0.5 * rng(), crm: rng() < 0.1 ? 1 : 0 }));
    const y = items.map(() => (rng() < 0.08 ? 1 : 0));
    const f = items.map(() => rng() * 0.3); // unrelated to y on purpose
    const pi = A.samplingDesign(items, f, { gamma: 0.3, kappa: 2 });
    const M = y.reduce((a, b) => a + b, 0);
    let sum = 0;
    const R = 3000;
    for (let s = 0; s < R; s++) {
      const d = A.drawSequence(pi, 20, 1000 * trial + s);
      sum += A.ppiEstimate(f, pi, d, Array.from(d, (i) => y[i])).rawEst;
    }
    const mean = sum / R;
    assert.ok(Math.abs(mean - M) < 0.06 * M + 1.5, `trial ${trial}: mean ${mean.toFixed(2)} vs M ${M}`);
  }
});

test('perfect prior gives the exact count with zero width', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ p: 0.9, crm: 0, y: i % 7 === 0 ? 1 : 0 }));
  const f = items.map((it) => it.y);
  const pi = A.samplingDesign(items, f, { gamma: 1 });
  const d = A.drawSequence(pi, 15, 5);
  const r = A.ppiEstimate(f, pi, d, Array.from(d, (i) => items[i].y));
  assert.equal(r.rawEst, A.trueHidden(items));
  assert.equal(r.se, 0);
});

test('interval is clipped to [found, subset size]', () => {
  const f = [0.9, 0.9, 0.9];
  const pi = Float64Array.from([1 / 3, 1 / 3, 1 / 3]);
  const r = A.ppiEstimate(f, pi, Int32Array.from([0, 1, 2, 0]), [1, 1, 1, 1]);
  assert.equal(r.found, 3);
  assert.ok(r.lo >= 3 && r.hi <= 3);
});

test('Wilson interval matches a known value (0 of 60)', () => {
  const w = A.wilsonCount(1, 60, 0);
  assert.equal(w.lo, 0);
  assert.ok(Math.abs(w.hi - 0.0602) < 0.0005);
});

test('calibrator recovers known logistic coefficients', () => {
  const rng = A.mulberry32(99);
  const items = [], ys = [];
  for (let i = 0; i < 6000; i++) {
    const it = { p: 0.5 + 0.49 * rng(), crm: rng() < 0.3 ? 1 : 0, c: Math.floor(rng() * 2) };
    const x = A.features(it, 2);
    const s = -1 + 0.8 * x[1] + 2 * x[2];
    ys.push(rng() < 1 / (1 + Math.exp(-s)) ? 1 : 0);
    items.push(it);
  }
  const w = A.fitCalibrator(items, ys, 2, { l2: 0.01 });
  assert.ok(Math.abs(w[1] - 0.8) < 0.15, `slope ${w[1]}`);
  assert.ok(Math.abs(w[2] - 2) < 0.25, `crm ${w[2]}`);
});

test('generator is deterministic; pack/unpack round-trips; prior.json is current', () => {
  const a = generate(), b = generate();
  assert.deepEqual(a.items.slice(0, 50), b.items.slice(0, 50));
  const rt = A.unpack(JSON.parse(JSON.stringify(pack(a))));
  assert.deepEqual(rt.items[123], a.items[123]);
  assert.deepEqual(rt.items.map((i) => i.y), mailbox.items.map((i) => i.y));
  assert.deepEqual(trainPrior().coef, prior.coef);
  assert.notEqual(generate(1, { drift: 0.5 }).items.length, generate(1).items.length);
});

test('headline numbers in data/results.json are reproduced by the shared pipeline', () => {
  const h = headline(mailbox, prior);
  assert.deepEqual(h, results.headline);
  assert.ok(h.ppi.lo <= h.truth && h.truth <= h.ppi.hi, 'shipped audit covers the truth');
  assert.ok(h.uniform.width > 4 * h.ppi.width, 'active audit is much tighter than random spot-checks');
  assert.ok(h.jevOnly < h.ppi.lo, "Jev's probabilities alone undercount");
});

test('coverage: 95% intervals cover the true count on the shipped mailbox', () => {
  const prep = A.prepare(mailbox, prior.coef);
  const { items, f, pi } = prep, M = A.trueHidden(items);
  let cov = 0;
  const R = 400;
  for (let s = 0; s < R; s++) {
    const d = A.drawSequence(pi, 60, 700000 + s);
    const r = A.ppiEstimate(f, pi, d, Array.from(d, (i) => items[i].y));
    cov += r.lo <= M && M <= r.hi;
  }
  assert.ok(cov / R >= 0.93, `coverage ${cov / R}`);
  assert.ok(results.coverage['60'].ppiCoverage >= 0.93);
});

test('summarize: CRM guard and synced spot-checks reduce what stays hidden', () => {
  const prep = A.prepare(mailbox, prior.coef);
  const labels = Array.from(prep.queue.slice(0, 60), (i) => prep.items[i].y);
  const none = A.summarize(prep, labels, {});
  const all = A.summarize(prep, labels, { guarded: Object.fromEntries([...Array(8).keys()].map((c) => [c, true])) });
  assert.equal(none.back, 0);
  assert.equal(all.back, prep.items.filter((i) => i.crm).length);
  assert.ok(all.remaining.est < none.remaining.est / 3);
  assert.ok(none.remaining.est <= none.total.est);
  const catSum = none.byCategory.reduce((a, r) => a + r.excluded, 0);
  assert.equal(catSum, prep.items.length);
});

test('CSV export escapes commas and quotes', () => {
  const csv = A.toCSV([{ a: 'x,y', b: 'say "hi"', c: 3 }]);
  assert.equal(csv, 'a,b,c\n"x,y","say ""hi""",3\n');
});

test('README quotes the computed headline', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const h = results.headline;
  for (const v of [h.ppi.lo, h.ppi.hi, h.truth, h.uniform.lo, h.uniform.hi]) assert.ok(readme.includes(String(Math.round(v))), `README missing ${Math.round(v)}`);
});

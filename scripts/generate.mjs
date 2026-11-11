// Seeded synthetic mailbox for the Exclusion audit demo.
// One connected account (jesse@acme.com), 90-day backsync, the five default
// exclusion categories plus three custom ones (Investor conversations, Hiring,
// Legal; the same three Lightfield's own Oct 23 changelog image shows).
// Only activity that Jev excluded (match probability >= 0.5) is generated;
// that is the population the audit is about.
//
// Each item has a subtype. Most subtypes are clear noise (y = 0). A few are
// realistic ways a real customer conversation lands in an exclusion
// category: an investor intro to a buyer, a signed order form from DocuSign,
// a customer's counsel redlining the MSA, a champion writing from Gmail,
// a customer-hosted advisory dinner, a partner pitch, a trial signup from a
// target account. On some of those Jev is confidently wrong (p ~ 0.9), the
// failure Ves Stoyanov's Oct 7 post describes for routing ("a counter-intuitive
// assignment ... never look[s] uncertain"); on others it is unsure.
//
// Usage: node scripts/generate.mjs   (writes data/mailbox.json)

import { writeFileSync } from 'node:fs';
import { mulberry32, fitCalibrator } from '../src/audit.js';

export const SEED = 20261110;
export const CATEGORIES = [
  { id: 'cold-sales-pitches', name: 'Cold sales pitches', applies: 'Mail, Meetings', desc: 'Unsolicited pitches from vendors, agencies and SDRs.' },
  { id: 'mass-advertising', name: 'Mass advertising', applies: 'Mail', desc: 'Newsletters, product announcements and bulk marketing email.' },
  { id: 'promotional-events', name: 'Promotional events', applies: 'Mail, Meetings', desc: 'Webinars, conferences and event invitations sent to many people.' },
  { id: 'personal', name: 'Personal', applies: 'Mail, Meetings', desc: 'Family, friends, personal purchases and appointments.' },
  { id: 'automated-noise', name: 'Automated noise', applies: 'Mail', desc: 'Notifications, receipts, alerts and other machine-sent email.' },
  { id: 'investor-conversations', name: 'Investor conversations', applies: 'Mail, Meetings', desc: "Updates, board prep, and fundraising with Acme's investors." },
  { id: 'hiring', name: 'Hiring', applies: 'Mail, Meetings', desc: "Recruiters, candidates, and interviews for Acme's open roles." },
  { id: 'legal', name: 'Legal', applies: 'Mail, Meetings', desc: 'Corporate matters with outside counsel, not customer contracts.' },
];

// Fictional customer/prospect accounts in Acme's CRM.
const ACCOUNTS = [
  ['Northwind Freight', 'northwindfreight.com'], ['Halcyon Health', 'halcyonhealth.io'], ['Brightline Logistics', 'brightline.co'],
  ['Kestrel Bank', 'kestrelbank.com'], ['Meridian Flow', 'meridianflow.com'], ['Nimbus Labs', 'nimbuslabs.ai'],
  ['Cadence AI', 'cadence-ai.com'], ['Orchard Retail', 'orchardretail.com'], ['Pinecrest Insurance', 'pinecrest.com'],
  ['Tidewater Energy', 'tidewater.energy'], ['Lumen Grocers', 'lumengrocers.com'], ['Fairway Payroll', 'fairwaypay.com'],
  ['Quarry Analytics', 'quarry.dev'], ['Sable Mobility', 'sablemobility.com'], ['Vireo Clinics', 'vireoclinics.com'],
  ['Atlas Ledger', 'atlasledger.com'], ['Juniper Robotics', 'juniperrobotics.com'], ['Copperline Telecom', 'copperline.net'],
  ['Redwood Schools', 'redwoodschools.org'], ['Harbor & Main', 'harborandmain.com'],
];
const FIRST = ['Priya', 'Marcus', 'Dana', 'Elena', 'Tomas', 'Aisha', 'Kenji', 'Sofia', 'Ravi', 'Grace', 'Owen', 'Lena', 'Mateo', 'Chloe', 'Daniel', 'Hana', 'Felix', 'Maya', 'Noah', 'Iris', 'Arjun', 'Zoe', 'Leo', 'Nora'];
const LAST = ['Raghavan', 'Thompson', 'Okafor', 'Petrova', 'Weiss', 'Nwosu', 'Tanaka', 'Moreno', 'Chen', 'Park', 'Hughes', 'Fischer', 'Silva', 'Laurent', 'Kim', 'Sato', 'Brandt', 'Iyer', 'Cohen', 'Novak'];
const VENDORS = ['Outreachly', 'Growthbase', 'LeadForge', 'Pipewise', 'Scalecraft', 'Datapulse', 'Brandwell', 'Clearbound', 'Rocketlist', 'Signalhire'];
const NEWS = ['The Pragmatic Founder', 'SaaS Weekly', 'Figma', 'Notion', 'Linear', 'Vercel', 'Ramp', 'Stripe', 'Retool', 'a16z'];
const FUNDS = [['Max Feld', 'a16z.com', 'a16z'], ['Rachel Ito', 'sequoiacap.com', 'Sequoia'], ['Ben Adler', 'firstround.com', 'First Round'], ['Clara Voss', 'conviction.com', 'Conviction']];

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function beta(rng, a, b) {
  // Johnk-free: sum of exponentials via gamma for integer-ish shapes (Marsaglia-Tsang)
  const g = (k) => {
    if (k < 1) return g(k + 1) * Math.pow(rng(), 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { const u1 = rng(), u2 = rng(); x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
      v = v * v * v; const u = rng();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const x = g(a), y = g(b);
  return x / (x + y);
}
const clampP = (p) => Math.min(0.9995, Math.max(0.5, Math.round(p * 1000) / 1000));

// Subtype table: [category index, kind m=mail|e=meeting, count, p-shape [a,b] mapped to [0.5,1],
//                 P(real conversation), P(touches open CRM record | real), P(crm | noise), template fn]
function person(rng) { return `${pick(rng, FIRST)} ${pick(rng, LAST)}`; }
function addr(name, domain) { return `${name.split(' ')[0].toLowerCase()}.${name.split(' ')[1].toLowerCase()}@${domain}`; }

const SUBTYPES = [
  // Cold sales pitches
  ['sdr-pitch', 0, 'm', 1180, [40, 1.2], 0, 0, 0.01, (r) => { const v = pick(r, VENDORS), n = person(r); return { from: n, email: addr(n, v.toLowerCase() + '.io'), subj: pick(r, [`Quick question about Acme's pipeline`, `15 min next week, Jesse?`, `${v} x Acme`, `Re: following up`, `Helping Acme hit Q4 targets`, `Idea for Acme's outbound`]), snip: `Hi Jesse, I noticed Acme is hiring AEs. ${v} helps teams like yours book 3x more meetings...` }; }],
  ['partner-pitch', 0, 'm', 70, [6, 2.2], 0.42, 0.8, 0.1, (r) => { const [a, d] = pick(r, ACCOUNTS), n = person(r); return { from: n, email: addr(n, d), subj: `Partnership idea: ${a} x Acme`, snip: `Hi Jesse, our customers keep asking for an Acme integration. Could we explore a joint offering before our Q1 planning?`, acct: a }; }],
  ['procurement', 0, 'm', 34, [4, 2.6], 0.85, 0.95, 0, (r) => { const [a, d] = pick(r, ACCOUNTS); return { from: `${a} Procurement`, email: `procurement@${d}`, subj: `Supplier registration: Acme Inc. (action required)`, snip: `To complete onboarding as a ${a} vendor, please submit your W-9 and security questionnaire in the supplier portal.`, acct: a }; }],
  ['vendor-meeting', 0, 'e', 60, [30, 1.5], 0, 0, 0.02, (r) => { const v = pick(r, VENDORS), n = person(r); return { from: n, email: addr(n, v.toLowerCase() + '.io'), subj: `${v} <> Acme: intro`, snip: `Calendar invite · 30 min · Google Meet` }; }],
  // Mass advertising
  ['newsletter', 1, 'm', 1460, [60, 0.8], 0, 0, 0.005, (r) => { const s = pick(r, NEWS); return { from: s, email: `hello@${s.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`, subj: pick(r, [`What's new in ${s}: November`, `${s} Weekly: 7 ideas for your GTM`, `Introducing ${s} AI`, `Your ${s} digest`]), snip: `Read in browser. This week: pricing pages that convert, plus three new features...` }; }],
  // Promotional events
  ['webinar', 2, 'm', 520, [35, 1.3], 0, 0, 0.01, (r) => { const s = pick(r, NEWS); return { from: `${s} Events`, email: `events@${s.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`, subj: pick(r, [`You're invited: ${s} Summit 2027`, `Webinar: scaling outbound with AI`, `Last chance to register`, `Join us in SF on Dec 4`]), snip: `Save your seat. Speakers from top SaaS companies share their playbooks...` }; }],
  ['customer-cab', 2, 'm', 42, [5, 2.4], 0.55, 0.9, 0.2, (r) => { const [a, d] = pick(r, ACCOUNTS), n = person(r); return { from: n, email: addr(n, d), subj: `${a} customer advisory dinner, Dec 9`, snip: `Jesse, we're hosting a small dinner for our key vendors and would love Acme there. Our VP Ops will join to talk about next year's rollout.`, acct: a }; }],
  ['event-meeting', 2, 'e', 46, [10, 1.6], 0.08, 0.7, 0.05, (r) => { const s = pick(r, NEWS); return { from: `${s} Events`, email: `events@${s.toLowerCase()}.com`, subj: `${s} Founder Breakfast`, snip: `Calendar invite · 1 hr · 500 Howard St` }; }],
  // Personal
  ['personal', 3, 'm', 610, [22, 1.4], 0, 0, 0.01, (r) => { const n = person(r); return { from: n, email: `${n.split(' ')[0].toLowerCase()}${Math.floor(r() * 90 + 10)}@gmail.com`, subj: pick(r, [`Thanksgiving plans?`, `Photos from Saturday`, `Your order has shipped`, `Re: dentist appointment`, `Fantasy league draft`]), snip: `Hey! Let me know if you can make it. Mom says hi.` }; }],
  ['champion-gmail', 3, 'm', 64, [3, 2.0], 0.5, 0.75, 0.05, (r) => { const [a] = pick(r, ACCOUNTS), n = person(r); return { from: n, email: `${n.split(' ')[0].toLowerCase()}.${n.split(' ')[1][0].toLowerCase()}@gmail.com`, subj: pick(r, [`coffee next week?`, `re: catching up`, `quick thing before Monday`]), snip: `Writing from my personal email. Want to talk about expanding Acme to the ${a} support team before budgets lock.`, acct: a }; }],
  ['personal-meeting', 3, 'e', 90, [14, 1.6], 0.02, 0.5, 0.01, (r) => ({ from: person(r), email: 'calendar@gmail.com', subj: pick(r, [`Dinner`, `Gym`, `Dentist`, `Flight to JFK`]), snip: `Calendar event` })],
  // Automated noise
  ['notification', 4, 'm', 1720, [70, 0.7], 0, 0, 0.004, (r) => { const s = pick(r, ['GitHub', 'Stripe', 'Calendly', 'Google Workspace', 'Slack', 'Vercel', 'Linear', 'Gusto']); return { from: s, email: `noreply@${s.toLowerCase().replace(/ /g, '')}.com`, subj: pick(r, [`[${s}] New sign-in to your account`, `Your receipt from ${s}`, `${s}: weekly summary`, `Action required: verify your email`, `Payment received`]), snip: `This is an automated message. Please do not reply.` }; }],
  ['docusign-completed', 4, 'm', 26, [9, 1.2], 0.9, 0.95, 0, (r) => { const [a] = pick(r, ACCOUNTS); return { from: 'DocuSign', email: 'dse@docusign.net', subj: `Completed: Acme Order Form - ${a}`, snip: `All parties have completed Acme Order Form - ${a}. View the completed document.`, acct: a }; }],
  ['trial-signup', 4, 'm', 58, [8, 1.4], 0.62, 0.7, 0.1, (r) => { const [a, d] = pick(r, ACCOUNTS), n = person(r); return { from: 'Acme App', email: 'alerts@acme.com', subj: `New trial signup: ${addr(n, d)}`, snip: `${n} (${a}) started a 14-day trial and invited 3 teammates.`, acct: a }; }],
  // Investor conversations
  ['investor-update', 5, 'm', 210, [28, 1.0], 0, 0, 0.02, (r) => { const [n, d] = pick(r, FUNDS); return { from: n, email: `${n.split(' ')[0].toLowerCase()}@${d}`, subj: pick(r, [`Re: October investor update`, `Board deck draft`, `Re: Series B timing`, `Portfolio CEO dinner`]), snip: `Great month. A few thoughts on the board deck before Thursday...` }; }],
  ['investor-intro', 5, 'm', 48, [9, 1.3], 0.88, 0.9, 0, (r) => { const [n, d] = pick(r, FUNDS), [a] = pick(r, ACCOUNTS), b = person(r); return { from: n, email: `${n.split(' ')[0].toLowerCase()}@${d}`, subj: `Intro: Jesse <> ${b} (${a})`, snip: `${b} runs support ops at ${a} and is evaluating vendors this quarter. Jesse, over to you. (Moving myself to bcc.)`, acct: a }; }],
  ['board-meeting', 5, 'e', 30, [20, 1.0], 0, 0, 0, (r) => ({ from: 'Max Feld', email: 'max@a16z.com', subj: `Acme Q4 board meeting`, snip: `Calendar invite · 2 hr` })],
  // Hiring
  ['recruiting', 6, 'm', 460, [26, 1.3], 0, 0, 0.01, (r) => { const n = person(r); return { from: n, email: addr(n, pick(r, ['gmail.com', 'talentbridge.com', 'hirepath.io'])), subj: pick(r, [`Application: Founding AE`, `Re: interview availability`, `Candidates for your Staff Engineer role`, `Offer letter questions`]), snip: `Thanks for the conversation yesterday. Attaching my resume and references.` }; }],
  ['candidate-customer', 6, 'm', 14, [4, 2.2], 0.45, 0.85, 0, (r) => { const [a, d] = pick(r, ACCOUNTS), n = person(r); return { from: n, email: addr(n, d), subj: `Re: your Solutions Engineer post`, snip: `Not applying myself, but our team at ${a} uses Acme heavily and I'd love to talk about adding the analytics tier.`, acct: a }; }],
  ['interview', 6, 'e', 120, [24, 1.2], 0, 0, 0, (r) => ({ from: person(r), email: 'candidate@gmail.com', subj: `Interview: Founding AE (round 2)`, snip: `Calendar invite · 45 min` })],
  // Legal
  ['outside-counsel', 7, 'm', 150, [16, 1.4], 0, 0, 0.01, (r) => ({ from: 'Wilson & Hart LLP', email: 'mlee@wilsonhart.com', subj: pick(r, [`Re: option pool refresh`, `Delaware annual franchise tax`, `Board consent for signature`, `Trademark filing update`]), snip: `Jesse, attached is the consent for your review. Please sign by Friday.` })],
  ['customer-msa', 7, 'm', 40, [5, 2.2], 0.8, 0.95, 0, (r) => { const [a, d] = pick(r, ACCOUNTS), n = person(r); return { from: `${n} (Legal, ${a})`, email: addr(n, d), subj: `Acme MSA redlines - ${a}`, snip: `Attached are our redlines to the MSA and DPA. Main open item is the liability cap; can we get on a call this week?`, acct: a }; }],
];

// drift > 0 perturbs each subtype's volume and real-conversation rate, used to
// simulate a different workspace's "Sync anyway" history for training the prior.
export function generate(seed = SEED, { drift = 0 } = {}) {
  const rng = mulberry32(seed);
  const drng = mulberry32(seed ^ 0x9e3779b9);
  const start = Date.UTC(2026, 7, 12), end = Date.UTC(2026, 10, 10);
  const items = [];
  for (const [sub, c, k, count0, [a, b], pReal0, pCrmReal, pCrmNoise, tpl] of SUBTYPES) {
    const count = drift ? Math.round(count0 * (1 + drift * (2 * drng() - 1))) : count0;
    const pReal = drift && pReal0 > 0 ? Math.min(0.97, pReal0 * Math.exp(drift * (2 * drng() - 1))) : pReal0;
    for (let j = 0; j < count; j++) {
      const t = tpl(rng);
      const p = clampP(0.5 + 0.5 * beta(rng, a, b));
      const y = rng() < pReal ? 1 : 0;
      const crm = rng() < (y ? pCrmReal : pCrmNoise) ? 1 : 0;
      const d = new Date(start + Math.floor(rng() * (end - start)));
      items.push({ k, c, p, y, crm, sub, d: d.toISOString().slice(0, 10), from: t.from, email: t.email, subj: t.subj, snip: t.snip, acct: t.acct || null });
    }
  }
  // Deterministic shuffle so ids are not grouped by subtype.
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  items.forEach((it, i) => { it.id = 'act_' + (100000 + i).toString(36); });
  return { seed, account: 'jesse@acme.com', workspace: 'Acme', backsync: '3 months', asOf: '2026-11-10', categories: CATEGORIES, items };
}

export const HISTORY_SEED = 777;
export const HISTORY_DRIFT = 0.5;

/** String-table packing keeps the shipped JSON small. */
export function pack(mb) {
  const strings = [], idx = new Map();
  const S = (v) => { if (v === null || v === undefined) return -1; if (!idx.has(v)) { idx.set(v, strings.length); strings.push(v); } return idx.get(v); };
  const items = mb.items.map((it) => [it.id, it.k, it.c, it.p, it.y, it.crm, it.d, S(it.from), S(it.email), S(it.subj), S(it.snip), S(it.acct), S(it.sub)]);
  return { ...mb, items, strings, fields: 'id,k,c,p,y,crm,d,from,email,subj,snip,acct,sub' };
}

/** Audit prior, trained on a drifted "Sync anyway" history from another workspace. */
export function trainPrior() {
  const hist = generate(HISTORY_SEED, { drift: HISTORY_DRIFT }).items;
  return { historySeed: HISTORY_SEED, drift: HISTORY_DRIFT, historySize: hist.length, coef: fitCalibrator(hist, hist.map((i) => i.y), CATEGORIES.length) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mb = generate();
  writeFileSync(new URL('../data/mailbox.json', import.meta.url), JSON.stringify(pack(mb)));
  const prior = trainPrior();
  writeFileSync(new URL('../data/prior.json', import.meta.url), JSON.stringify(prior, null, 1));
  const y = mb.items.reduce((s, it) => s + it.y, 0);
  console.log(`items=${mb.items.length} hidden real=${y} bytes=${JSON.stringify(pack(mb)).length} coef=${prior.coef.map((c) => c.toFixed(2)).join(' ')}`);
}

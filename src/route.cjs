#!/usr/bin/env node
'use strict';
/**
 * route.cjs — decide which pipeline a request gets. FOUR THRESHOLDS, NO INFERENCE.
 *
 * WHY THIS EXISTS
 *
 * A seven-stage pipeline run on a typo gets abandoned in a week. The route
 * selector is not an optimisation — it is the thing that decides whether the
 * pipeline survives a Tuesday.
 *
 * 🔴 NOTHING HERE READS THE PROSE OF THE REQUEST, AND THAT IS THE DESIGN.
 * The obvious version — a classifier looking for "looks off", "spacing",
 * "quick fix" — forces every visual question down the most expensive path, and
 * on this project most questions are visual. Worse, the same session writes
 * both the request and the classification of it. So every input below is a
 * COUNT, from git or from claim.cjs:
 *
 *     git diff --name-only   → how many files change
 *     claim.cjs liveClaims   → how many windows, and whose claim they fall under
 *     fs.existsSync(bar)     → is there a reference on disk
 *
 * THE FOUR ROUTES
 *   ANSWER    no files change            → no pipeline at all; just reply
 *   EXPRESS   1 window · ≤3 files, all inside your own claim   → Q · E · WB
 *   STANDARD  1 window · >3 files, OR any file under another window's claim
 *                                        → Q · BD · P · RP · E · M · WB
 *   FULL      ≥2 windows, crosses a gate boundary, or a visual bar whose
 *             reference does not exist on disk                 → the same seven
 *
 * ⚠️ THE OVERRIDE COUNTER — WITHOUT IT, EVERYTHING IS EXPRESS IN TWO WEEKS.
 * A downgrade costs one unverified sentence, and the same session writes both
 * the request and the override. So every override is recorded, and three in a
 * rolling week prints the tally. **It is not a block. It is a number, in front
 * of you.** A gate that blocks gets an escape hatch and the escape hatch
 * becomes the path; a gate that counts cannot be escaped, only read.
 *
 * Usage:
 *   route.cjs [--window W1] [--bar <reference-path>] [--repo <dir>]
 *   route.cjs --override EXPRESS --why "one-line typo, no gate touched"
 *   route.cjs --tally           what has been overridden lately
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ORCH = __dirname;
const claimLib = require(path.join(ORCH, 'claim.cjs'));

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = argv.includes('--json');
const TALLY = argv.includes('--tally');
const OVERRIDE = arg('--override', null);
const WHY = arg('--why', null);

const PROJECT = arg('--project', process.env.ORCH_PROJECT || 'cleaning');
const cfg = claimLib.loadConfig(PROJECT);
const REPO = arg('--repo', cfg.repo || process.env.ORCH_REPO || '/path/to/repo');
const SELF = arg('--window', process.env.ORCH_WINDOW || null);
const BAR = arg('--bar', null);
const LOG = path.join(ORCH, 'state', 'route-overrides.log');

const ROUTES = {
  ANSWER: [],
  EXPRESS: ['Q', 'E', 'WB'],
  STANDARD: ['Q', 'BD', 'P', 'RP', 'E', 'M', 'WB'],
  FULL: ['Q', 'BD', 'P', 'RP', 'E', 'M', 'WB'],
};

// ── the override ledger ──────────────────────────────────────────────────────
function readTally() {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function printTally(entries) {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = entries.filter(e => Date.parse(e.at) >= weekAgo);
  if (!recent.length) { console.log('  override ledger: nothing in the last 7 days'); return; }
  console.log(`\n  ⚠️ OVERRIDE TALLY — ${recent.length} in the last 7 days`);
  for (const e of recent.slice(-8)) {
    console.log(`     ${e.at.slice(0, 16).replace('T', ' ')}  ${e.from} → ${e.to}   ${e.why || '(no reason given)'}`);
  }
  if (recent.length >= 3) {
    console.log(`\n  🔴 ${recent.length} overrides in a week. This is not a block — it is the number.`);
    console.log('     A route that is always overridden is a threshold that is wrong. Fix the');
    console.log('     threshold, or stop overriding it; leaving both is how everything becomes');
    console.log('     EXPRESS in two weeks.');
  }
}

if (TALLY) { printTally(readTally()); process.exit(0); }

// ── measure ──────────────────────────────────────────────────────────────────
const git = (args) => {
  try { return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return ''; }
};
const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean);

const changed = [...new Set([
  ...lines(git(['diff', '--name-only'])),
  ...lines(git(['diff', '--cached', '--name-only'])),
  ...lines(git(['ls-files', '--others', '--exclude-standard'])),
])].sort();

// which windows' live claims cover these files
const live = (claimLib.liveClaims ? claimLib.liveClaims(cfg) : []).filter(c => !c.expired);
const owners = new Map();          // window -> [files]
const foreign = [];                // files under a claim that is not SELF
for (const f of changed) {
  for (const c of live) {
    for (const p of (c.paths || [])) {
      if (claimLib.matches(f, p)) {
        (owners.get(c.window) || owners.set(c.window, []).get(c.window)).push(f);
        if (SELF && c.window !== SELF) foreign.push({ file: f, window: c.window, pattern: p });
        break;
      }
    }
  }
}
const windowCount = owners.size;
const barMissing = BAR ? !fs.existsSync(BAR) && !fs.existsSync(path.join(REPO, BAR)) : false;

// ── decide ───────────────────────────────────────────────────────────────────
const reasons = [];
let route;
if (changed.length === 0) {
  route = 'ANSWER'; reasons.push('no files change — nothing to gate');
} else if (windowCount >= 2) {
  route = 'FULL'; reasons.push(`${windowCount} windows' claims cover these files: ${[...owners.keys()].join(', ')}`);
} else if (barMissing) {
  route = 'FULL'; reasons.push(`a visual bar was named (${BAR}) and it does not exist on disk — /critic cannot open it, so the loop cannot terminate`);
} else if (foreign.length) {
  route = 'STANDARD'; reasons.push(`${foreign.length} file(s) fall under ${[...new Set(foreign.map(f => f.window))].join(', ')}'s claim, not ${SELF}'s`);
} else if (changed.length > 3) {
  route = 'STANDARD'; reasons.push(`${changed.length} files change (>3)`);
} else {
  route = 'EXPRESS'; reasons.push(`${changed.length} file(s), one window, all inside your own claim`);
}

// ── override ─────────────────────────────────────────────────────────────────
let final = route;
if (OVERRIDE) {
  const want = OVERRIDE.toUpperCase();
  if (!ROUTES[want]) { console.error(`route: unknown route '${OVERRIDE}' — use ANSWER|EXPRESS|STANDARD|FULL`); process.exit(2); }
  if (!WHY) { console.error('route: --override requires --why "<one line>". An override with no reason is the thing being counted.'); process.exit(2); }
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), from: route, to: want, why: WHY, files: changed.length, window: SELF }) + '\n');
  } catch { /* the ledger must never block the work it measures */ }
  final = want;
}

// ── report ───────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ route: final, measured: route, overridden: !!OVERRIDE, why: WHY,
    files: changed, windows: [...owners.keys()], foreign, barMissing, stages: ROUTES[final], reasons }, null, 2));
  process.exit(0);
}

console.log(`ROUTE: ${final}${OVERRIDE ? `   (measured ${route}, OVERRIDDEN)` : ''}`);
console.log(`  stages    ${ROUTES[final].length ? ROUTES[final].join(' · ') : 'none — just reply'}`);
console.log(`  measured  ${changed.length} changed file(s) · ${windowCount} window claim(s)${BAR ? ` · bar ${barMissing ? 'MISSING' : 'present'}` : ''}`);
for (const r of reasons) console.log(`  because   ${r}`);
if (changed.length && changed.length <= 12) for (const f of changed) console.log(`     ${f}`);
else if (changed.length) console.log(`     (${changed.length} files — too many to list)`);
for (const f of foreign) console.log(`  🔴 ${f.file}  is under ${f.window}'s claim (${f.pattern})`);

if (OVERRIDE) {
  console.log(`\n  recorded: ${route} → ${final} — "${WHY}"`);
  printTally(readTally());
} else {
  const recent = readTally().filter(e => Date.parse(e.at) >= Date.now() - 7 * 24 * 3600 * 1000);
  if (recent.length >= 3) printTally(readTally());
}

#!/usr/bin/env node
'use strict';
/**
 * rp.cjs — REVIEW THE PLAN. Three mechanical checks over a brief's PACKET.
 *
 * WHY THIS EXISTS
 *
 * `lint-brief.cjs` enforces six headings. It checks the FORM of a brief and
 * never the plan. A brief whose hypothesis reads *"I have no idea what causes
 * this. Probably vibes."*, scope *"whatever you feel like"* and done-when *"it
 * feels done"* passes it with exit 0 — reproduced twice, the second time
 * deliberately. This is the first gate that reads what the brief actually
 * COMMITS TO rather than whether it has the right headings.
 *
 * 🔑 EVERY CHECK READS GENERATED DATA, NEVER PROSE. That constraint is the
 * whole design, and it came from measurement: the obvious prose check — "every
 * backticked path is inside the claim globs" — fails **362 of 461 briefs
 * (79%)**, and five increasingly lenient parsers only reach 79 → 66 → 50 → 40 →
 * 29%. The 29% residual is *legitimate* prose: read-only context globs,
 * `file:line` citations, evidence paths, bare basenames. A gate that refuses
 * four briefs in five, for being written normally, gets switched off in a week.
 *
 * TWO CHECKS WERE DESIGNED AND DELETED, on purpose, and must not come back:
 *   · "every backticked path is in the claim" — the 79% above. It refuses
 *     briefs for being well written.
 *   · "the first move ran and its output is pasted" — verifies nothing about
 *     where the output came from. It is a DECLARATION gate dressed as a
 *     behaviour gate, which is the defect class this system names most often,
 *     and its behaviour twin already exists and is called `premise.cjs`.
 *
 * THE THREE THAT SURVIVE, each with the mutation that turns ONLY it red:
 *   RP-1 stale claim     — the PACKET's claim disagrees with the live claim's
 *                          brief. Mutation: rotate the claim; nothing else moves.
 *   RP-2 window agreement— the PACKET's `window:` disagrees with the claim
 *                          holder. Mutation: `window: W3` -> `window: W1`.
 *   RP-3 config assertion— the dispatched window has a `floor` (or an explicit
 *                          `null` WITH a `floor_why`) and a known budget class.
 *                          Mutation: delete W5's floor key.
 *
 * ⚠️ RP-3 IS SATISFIABLE BY WRITING A LIE, and this is a known, accepted
 * limit. W5 *does* have a floor (`factory-floor.json`), so `floor: null` would
 * be false and `"test"` would be the wrong floor. A presence assertion cannot
 * tell "this lane has no floor" from "nobody has named it" — it only forces
 * someone to answer. Do not read a green RP-3 as "the floor is correct."
 *
 * Usage:
 *   rp.cjs <brief-path> [--project cleaning] [--json]
 *   exit 0 all pass · 1 a check failed · 2 unusable input
 */

const fs = require('fs');
const path = require('path');

const ORCH = __dirname;
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PROJECT = arg('--project', process.env.ORCH_PROJECT || 'cleaning');
const briefPath = argv.find((a, i) => !a.startsWith('-') && argv[i - 1] !== '--project');

if (!briefPath) { console.error('usage: rp.cjs <brief-path> [--project cleaning] [--json]'); process.exit(2); }
if (!fs.existsSync(briefPath)) { console.error(`rp: no such brief ${briefPath}`); process.exit(2); }

const cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ORCH, 'projects', `${PROJECT}.json`), 'utf8')); }
  catch { console.error(`rp: no usable adapter for '${PROJECT}'`); process.exit(2); }
})();

const text = fs.readFileSync(briefPath, 'utf8');
const pk = /<!--\s*PACKET:BEGIN[\s\S]*?-->([\s\S]*?)<!--\s*PACKET:END\s*-->/.exec(text);
if (!pk) {
  console.error(`rp: ${path.basename(briefPath)} has no PACKET block.`);
  console.error('    RP reads generated data only — generate it first:  packet.cjs <brief>');
  process.exit(2);
}
const packet = pk[1];
const field = (k) => {
  const m = new RegExp(`^\\s*${k}:\\s*(.+)$`, 'im').exec(packet);
  return m ? m[1].trim() : null;
};

const briefId = (path.basename(briefPath).match(/^(W\d-\d+)/) || [])[1] || null;
const pkWindowRaw = field('window');
const pkWindow = pkWindowRaw ? (pkWindowRaw.match(/^(W\d)/) || [])[1] : null;
const pkClaim = field('claim');
const pkClaimWindow = pkClaim ? (pkClaim.match(/^(W\d)/) || [])[1] : null;

/** The live claim registry — the same files claim.cjs and the path lock read. */
function liveClaim(win) {
  if (!win) return null;
  const f = path.join(cfg.vault, (cfg.claim && cfg.claim.dir) || '.claude/claims', `${win}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

const results = [];
const add = (id, name, ok, detail, note) => results.push({ id, name, ok, detail, note });

// ── RP-1 · stale claim ───────────────────────────────────────────────────────
// The packet is measured when the brief is WRITTEN. A brief can sit for hours
// before it is sent, and W0 rotates claims in between. A packet quoting a claim
// the window no longer holds sends the next window into a lane nobody is
// guarding — the same rotation that freed W1-108 in the /land incident.
{
  const held = liveClaim(pkClaimWindow || pkWindow);
  if (!held) {
    add('RP-1', 'stale claim', true, `no live claim for ${pkClaimWindow || pkWindow || '?'} — nothing to disagree with`,
      'a brief prepared before its claim is taken is normal; the claim is taken at dispatch');
  } else if (briefId && held.brief && held.brief !== briefId) {
    add('RP-1', 'stale claim', false,
      `PACKET is for ${briefId}, but ${pkClaimWindow || pkWindow} currently holds '${held.brief}'`,
      'the claim rotated after this packet was measured — regenerate it, or you dispatch against a lane that moved');
  } else {
    add('RP-1', 'stale claim', true, `claim holds '${held.brief || '(none)'}' — agrees with ${briefId}`);
  }
}

// ── RP-2 · window agreement ──────────────────────────────────────────────────
// `window:` is what the receiving window reads to know who it is; `claim:` is
// what the path lock enforces. If they disagree, the brief tells a window to do
// work that is locked to a different lane, and both halves look correct alone.
{
  if (!pkWindow) add('RP-2', 'window agreement', false, 'PACKET has no parseable `window:` line');
  else if (!pkClaimWindow) add('RP-2', 'window agreement', true, `window ${pkWindow}; packet names no claim window`);
  else if (pkWindow !== pkClaimWindow) {
    add('RP-2', 'window agreement', false,
      `PACKET says \`window: ${pkWindow}\` but \`claim: ${pkClaimWindow}\``,
      'the brief addresses one lane and locks another; the path lock will refuse the very edits the brief asks for');
  } else {
    const filenameWin = briefId ? briefId.slice(0, 2) : null;
    if (filenameWin && filenameWin !== pkWindow) {
      add('RP-2', 'window agreement', false,
        `filename says ${filenameWin} but PACKET says \`window: ${pkWindow}\``,
        'the brief id and the packet disagree about who this is for');
    } else add('RP-2', 'window agreement', true, `${pkWindow} agrees across filename, window: and claim:`);
  }
}

// ── RP-3 · config assertion ──────────────────────────────────────────────────
// packet.cjs:185 is `win.floor || 'test'` — a SILENT DEFAULT, which is why
// every W5 packet has been quoting the Flutter floor to a lane that does not
// run the Flutter suite. A missing key must be answered, not defaulted.
{
  const w = cfg.windows && cfg.windows[pkWindow];
  const problems = [];
  if (!w) problems.push(`${PROJECT}.json has no windows.${pkWindow} entry at all`);
  else {
    const hasFloor = Object.prototype.hasOwnProperty.call(w, 'floor');
    if (!hasFloor) problems.push(`windows.${pkWindow} has no \`floor\` key — packet.cjs defaults it to 'test' silently`);
    else if (w.floor === null && !w.floor_why) problems.push(`windows.${pkWindow}.floor is null with no \`floor_why\` saying why`);
    else if (w.floor !== null && !(cfg.floors && cfg.floors[w.floor])) problems.push(`windows.${pkWindow}.floor = '${w.floor}' names no entry in \`floors\``);

    const classes = cfg.budgets || cfg.budgetClasses || {};
    if (!w.budget) problems.push(`windows.${pkWindow} has no \`budget\` class`);
    else if (!classes[w.budget]) problems.push(`windows.${pkWindow}.budget = '${w.budget}' is not a defined class`);
  }
  const pkBudget = field('budget') || '';
  if (/UNKNOWN budget class/.test(pkBudget)) problems.push(`the PACKET itself carries: ${pkBudget.trim()}`);

  if (problems.length) add('RP-3', 'config assertion', false, problems.join('; '),
    'a presence assertion only forces an answer — a green RP-3 does not mean the floor is CORRECT');
  else add('RP-3', 'config assertion', true, `windows.${pkWindow}: floor + budget both named and resolvable`);
}

// ── report ───────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
if (JSON_OUT) {
  console.log(JSON.stringify({ brief: briefPath, briefId, window: pkWindow, results, passed: !failed.length }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

console.log(`RP — ${path.basename(briefPath)}${briefId ? `  (${briefId})` : ''}`);
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '🔴'} ${r.id} ${r.name.padEnd(18)} ${r.detail}`);
  if (r.note) console.log(`       ${r.ok ? '·' : '↳'} ${r.note}`);
}
if (failed.length) {
  console.log(`\n🔴 ${failed.length} of ${results.length} checks failed. This brief reviews its FORM fine —`);
  console.log('   lint-brief.cjs would pass it. What failed is what it commits to.');
}
process.exit(failed.length ? 1 : 0);

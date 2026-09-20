#!/usr/bin/env node
/**
 * return.cjs — check a return block against the §4.8 contract.
 *
 * The last unbuilt component of the buildout plan. Every return this session
 * was verified by hand, and the hand missed things:
 *
 *   D107  "no prop goes below L* 35.7" — written from n=3, then RE-MEASURED by
 *         W0 from the same middle of the distribution and CONFIRMED. Truth:
 *         min 20.4, MEDIAN 35.6. A number quoted away from its population.
 *   D142  Two consecutive returns claimed done with the branch never pushed.
 *   D156  A re-touched old return read as a new one.
 *
 * WHAT THIS CAN AND CANNOT DO
 *
 * KEY: It checks the SHAPE of a return, never the TRUTH of it. It cannot know
 * whether `+3082` was measured or copied — that is why the contract demands
 * literal output rather than a claim, and why W0 still re-runs the numbers it
 * cares about. A tool that implied otherwise would be the fourth instrument
 * this session to report success at a question it was never asked.
 *
 * What it does catch is the mechanical half, which is where the misses were:
 * a missing UNANSWERED field, a floor asserted without literal output, a
 * "landed" claim with no sha, a `-N` failure tail hiding inside a green line.
 *
 * USAGE
 *   return.cjs <outbox-path> [--brief W1-53]
 *   return.cjs --all
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ORCH = __dirname;

function loadConfig(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ORCH, 'projects', `${name}.json`), 'utf8'));
  } catch {
    process.stderr.write('return: no usable adapter\n');
    process.exit(2);
  }
}

/**
 * A `-N` tail means N tests FAILED, and it hides inside an otherwise green line:
 *   01:17 +3075 ~2: All tests passed!      ← clean
 *   00:52 +2718 ~2 -21: Some tests failed  ← 21 failures
 * `origin/main` was red at #135 and nobody noticed, because the rising pass
 * count reads as success. This is the single highest-value check in the file.
 */
/**
 * CRITICAL: EXCEPT WHEN THE RED RUN IS THE FINDING — 2026-08-20, found by W1.
 *
 * The contract demands literal gate output, and a window proving a mutation
 * turns a test red MUST quote a red line to do it. This check flagged that
 * evidence as a failure, so a return whose whole value was a deliberate red
 * could not pass the gate without paraphrasing the literal output the contract
 * requires. Twice in two briefs.
 *
 * WARNING: AND IT IS SELF-AMPLIFYING: quoting the checker's own complaint back into
 * the return re-triggers it on the quote, so the count climbs as the window
 * explains itself.
 *
 * Two exemptions, both requiring the AUTHOR to have signalled intent — the
 * author is the only party that knows which kind of red a line is:
 *   1. an explicit inline marker, `[expected-red]`, anywhere on the line;
 *   2. the nearest preceding non-blank line announces evidence — a mutation,
 *      a control, a before-state, a deliberate red.
 *
 * KEY: The check itself is unchanged for everything else. An UNANNOUNCED `-N` is
 * still the single highest-value signal in this file: `origin/main` was red at
 * #135 and nobody noticed, because the rising pass count reads as success.
 */
// Two cue sets, and the difference is deliberate.
//
// PRECEDING: a line of prose introducing a fenced block can be loose — words
// like "expected" or "before" are safe there because a gate result is not
// preceded by prose announcing evidence.
//
// SELF: the same words on the LINE ITSELF must be stricter, because a genuine
// gate line can innocently contain "expected" ("must not fall below the
// expected floor"). Only words that cannot appear in a real gate result qualify.
// Without a self-check the checker flags a window QUOTING its own complaint —
// the self-amplifying case W1 measured, where explaining the failure creates
// another one.
const EVIDENCE_CUE_PRECEDING =
  /\b(mutation|mutant|control|expected|deliberate|before|proof|evidence|counter-?hypothesis|falsif|turns? (?:it )?red|went red|prior to|baseline)\b/i;
const EVIDENCE_CUE_SELF =
  /\b(mutation|mutant|control output|control run|quoted evidence|deliberate|falsif|turns? (?:it )?red|went red|expected[- ]red)\b/i;

function failureTail(text) {
  const hits = [];
  const lines = text.split('\n');
  let lastMeaningful = '';
  for (const line of lines) {
    const m = line.match(/\+\d+\s+(?:~\d+\s+)?-(\d+)/);
    if (m && Number(m[1]) > 0) {
      const exempt = /\[expected-red\]/i.test(line)
        || EVIDENCE_CUE_SELF.test(line)
        || EVIDENCE_CUE_PRECEDING.test(lastMeaningful);
      if (!exempt) hits.push(line.trim());
    }
    // A fence or a blank line does not reset the context: the cue is usually
    // the prose ABOVE a fenced block, not inside it.
    if (line.trim() && !/^\s*```/.test(line)) lastMeaningful = line;
  }
  return hits;
}

const CHECKS = [
  {
    id: 'unanswered',
    // A REQUIRED field, and a defect log against W0 rather than the window.
    // Absent means the window either had nothing to say or forgot; those are
    // different and only one is acceptable, so `none` must be explicit.
    test: (t) => /UNANSWERED BY THE BRIEF/i.test(t),
    fail: 'no `UNANSWERED BY THE BRIEF` section — required, and `none` must be written out',
  },
  {
    id: 'gates-literal',
    // "Tests pass" is not a result. `+1385 ~2: All tests passed!` is.
    // The optional `-N` must be part of the pattern. Without it, a line that
    // HAS a failure tail — `+3075 ~2 -3: ...` — failed this check too, and the
    // window was told "no literal gate output" about a line that was literal
    // gate output. A wrong diagnosis sends the reader to the wrong file.
    test: (t) => /\+\d+\s*(~\d+\s*)?(-\d+\s*)?:/.test(t) || /No issues found!/.test(t)
      || /Tests:\s+\d+ passed/.test(t) || /0 Dart touched|nothing to record/i.test(t),
    fail: 'no literal gate output — a claim like "tests pass" is not a result',
  },
  {
    id: 'floor-stated',
    // Either a floor number with context, or an explicit statement that nothing
    // was recorded. Silence is the failure mode: it reads identically to a
    // window that measured nothing.
    test: (t) => /floor/i.test(t),
    fail: 'floors not mentioned — say the number, or say explicitly that 0 Dart means nothing recorded',
  },
];

function checkOne(file, opts = {}) {
  if (!fs.existsSync(file)) return { file, ok: false, problems: ['outbox does not exist'] };
  const text = fs.readFileSync(file, 'utf8');
  const problems = [];
  const notes = [];

  const title = text.split('\n').find((l) => l.trim().startsWith('#')) || '';
  const brief = (title.match(/\b(W[0-5]-\d+)\b/) || [])[1] || null;

  // The D156 check: is this return actually for the brief W0 thinks is live?
  if (opts.brief && brief && brief !== opts.brief) {
    problems.push(`return is for ${brief}, but ${opts.brief} is the live brief — a re-touched old return`);
  }
  if (opts.brief && !brief) problems.push(`no brief id in the title; expected ${opts.brief}`);

  for (const c of CHECKS) if (!c.test(text)) problems.push(c.fail);

  // CRITICAL: The one that has actually shipped a red main.
  const tails = failureTail(text);
  for (const l of tails) problems.push(`FAILURE TAIL in a gate line — ${l}`);

  // A "landed" claim with no sha is unverifiable. Not fatal — W0 checks `main`
  // directly — but worth naming, because it is the claim most likely to be
  // taken on trust.
  // 2026-08-12 (W3): this fired on a STOP-AND-REPORT return that shipped nothing
  // and merely mentioned prior work in prose. "landed"/"merged" anywhere in the
  // file was enough. It would fire on every return that references history —
  // which is most of the good ones.
  //
  // A claim about THIS return's outcome puts the verb and the PR on the SAME
  // LINE. A reference to someone else's landed work does not. Scope to that.
  const claimLines = text.split('\n').filter((l) => /\b(landed|merged)\b/i.test(l) && /#\d+/.test(l));
  const anySha = /\b[0-9a-f]{7,40}\b/.test(text);
  if (claimLines.length && !anySha) {
    notes.push('claims a PR landed but names no sha — verify on main');
  }

  return { file, brief, ok: problems.length === 0, problems, notes };
}

function report(r) {
  const name = path.basename(r.file);
  if (r.ok) {
    process.stdout.write(`PASS  ${name}${r.brief ? `  (${r.brief})` : ''}\n`);
  } else {
    process.stdout.write(`FAIL  ${name}${r.brief ? `  (${r.brief})` : ''}  (${r.problems.length})\n`);
    for (const p of r.problems) process.stdout.write(`        ${p}\n`);
  }
  for (const n of r.notes) process.stdout.write(`        NOTE: ${n}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig(process.env.ORCH_PROJECT || 'cleaning');
  const briefIdx = argv.indexOf('--brief');
  const brief = briefIdx >= 0 ? argv[briefIdx + 1] : null;

  let files;
  if (argv.includes('--all')) {
    const dir = path.join(cfg.repo, '.orchestrator', 'outbox');
    files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f))
      : [];
    if (!files.length) { process.stderr.write(`return: no outboxes under ${dir}\n`); process.exit(2); }
  } else {
    const f = argv.find((a) => !a.startsWith('--') && a !== brief);
    if (!f) { process.stderr.write('usage: return.cjs <outbox-path> [--brief W1-53]  |  return.cjs --all\n'); process.exit(2); }
    files = [f];
  }

  const results = files.map((f) => checkOne(f, { brief }));
  results.forEach(report);
  const bad = results.filter((r) => !r.ok).length;
  process.stdout.write(`\n${results.length - bad}/${results.length} return(s) meet the contract.\n`);
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();
module.exports = { checkOne, failureTail };

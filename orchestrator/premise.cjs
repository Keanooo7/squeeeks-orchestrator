#!/usr/bin/env node
/**
 * premise.cjs — execute a brief's declared PREMISE CHECK.
 *
 * WHY THIS EXISTS. On 2026-08-24/25 five W0 briefs were dispatched on premises
 * that were false at dispatch time. Every one was caught by the WINDOW, after
 * it had acked, cut a worktree and started reading — i.e. at the most expensive
 * moment available:
 *
 *   W3-131  "trash_day_takeover.dart renders 'art: stage 5'"   the art had SHIPPED
 *   W3-132  "18 other props carry a finish ladder"             17 do; 23 of 40 do NOT
 *   W1-163  "the seed's `section` field groups the album"      it is a COMMENT BANNER
 *   W3-134  "warm_strength 0.85 is the toilet's outlier"       every appliance ships 0.85
 *   W4-119  "SUBMIT.md must be reconciled"                     the deliverable already existed
 *
 * KEY: EVERY ONE WAS A ONE-COMMAND CHECK. The rule "verify before asserting"
 * already existed and was already written down; what did not exist was anything
 * MECHANICAL behind it. A rule with nothing mechanical behind it is how the
 * paid-task cap sat one edit from silent disagreement for weeks
 * (subscription_tier.dart says so about itself) — the same shape, one layer up.
 *
 * So: a brief DECLARES the observations its premise depends on, and `dispatch.cjs
 * prepare` runs them BEFORE taking the claim. A false premise now costs a
 * refused prepare instead of a window's ack, worktree and reading time.
 *
 * SYNTAX — a fenced ```premise block anywhere in the brief:
 *
 *     ```premise
 *     expect  art: stage 5  ::  git grep -c "art: stage 5" origin/main -- '*.dart'
 *     absent  role_         ::  git ls-tree origin/main assets/images/skins/character/
 *     ```
 *
 *   expect <needle> :: <cmd>   PASS iff cmd's combined output CONTAINS needle
 *   absent <needle> :: <cmd>   PASS iff it does NOT
 *
 * WARNING: The needle is a literal substring, not a regex — a regex here would invite
 * the `a-negative-grep-must-match-the-defect-not-a-token` failure, where the
 * pattern matches something benign and the check passes for the wrong reason.
 *
 * CRITICAL: A NON-ZERO EXIT FROM THE COMMAND IS NOT A FAILURE BY ITSELF. `grep -c`
 * returns 1 on zero matches, and a chain that aborts there silently truncated a
 * real check on 2026-08-24. Only the needle decides. The exit code is REPORTED
 * so a broken command cannot masquerade as a satisfied `absent`.
 *
 * WARNING:  CHECKS RUN IN THE CLEANING REPO, SO THEY CANNOT SEE VAULT PATHS. A check like
 * `git ls-tree origin/main Projects/Cleaning/reviews/` returns EMPTY — not because the
 * file is missing, but because that tree lives in the VAULT, a different repository.
 * The empty result is indistinguishable from a real absence, which is the same shape as
 * every other trap in this file. Write premises against Cleaning-repo paths only; if a
 * brief depends on a vault artefact, say so in prose rather than in a check.
 * (W2-154 tripped exactly this and the gate refused the dispatch, correctly.)
 *
 * CRITICAL: READ THE BRANCH, NOT THE WORKING TREE. Checks run with cwd = the Cleaning
 * ROOT CHECKOUT, which stays on `main` but is NOT pulled — worktrees do the work,
 * so nobody has a reason to update it. On 2026-08-25 it sat TWELVE commits behind
 * `origin/main`, and the same question answered two ways:
 *
 *     git ls-files tool/       | grep -c alpha   -> 0   working tree, STALE
 *     git ls-tree origin/main tool/ | grep -c alpha -> 3   the branch, TRUE
 *
 * A premise built on `git ls-files`, `ls`, `cat` or a bare `grep` therefore
 * describes a tree nobody is working in, and its ABSENCE answer is
 * indistinguishable from a real absence — the same shape as `check-ignore`
 * reporting "not ignored" for a path that merely does not exist yet.
 *
 * ✅ Prefer `git show origin/main:<path>`, `git ls-tree origin/main <dir>` and
 * `git grep <pat> origin/main -- <pathspec>`. Use a working-tree command ONLY
 * when the premise is genuinely about the working tree, and say so in the brief.
 *
 * Usage: premise.cjs <brief-path> [--cwd <dir>]
 * Exit 0 all pass · 1 a check failed · 2 usage · 3 no premise block found.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadConfig() {
  const f = path.join(__dirname, 'projects', 'cleaning.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}

function parseBlock(text) {
  const m = text.match(/```premise\n([\s\S]*?)```/);
  if (!m) return null;
  const rows = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('::');
    if (sep === -1) { rows.push({ bad: line, why: 'no `::` separating needle from command' }); continue; }
    const lhs = line.slice(0, sep).trim();
    const cmd = line.slice(sep + 2).trim();
    const sp = lhs.indexOf(' ');
    if (sp === -1) { rows.push({ bad: line, why: 'no needle after the mode word' }); continue; }
    const mode = lhs.slice(0, sp).trim().toLowerCase();
    const needle = lhs.slice(sp + 1).trim();
    if (mode !== 'expect' && mode !== 'absent') {
      rows.push({ bad: line, why: `unknown mode \`${mode}\` — use \`expect\` or \`absent\`` });
      continue;
    }
    if (!needle) { rows.push({ bad: line, why: 'empty needle' }); continue; }
    if (!cmd) { rows.push({ bad: line, why: 'empty command' }); continue; }

    // ── ANTI-VACUITY 1 · a self-fulfilling check ─────────────────────────────
    // `expect foo :: echo foo` passes for the reason it was written, not for the
    // reason it claims. A needle that appears LITERALLY in its own command is
    // testing the command line, not the repository. Quoting is how it usually
    // arrives, so compare with quotes and separators stripped.
    const bare = s => s.replace(/["'`]/g, '').toLowerCase();
    if (mode === 'expect' && bare(cmd).includes(bare(needle)) && !/^git (grep|log|ls-tree|show|diff)/.test(cmd)) {
      rows.push({
        bad: line,
        why: `the needle "${needle}" appears literally in its own command — it would pass on the command line alone. `
           + 'Search for it, do not echo it.',
      });
      continue;
    }
    rows.push({ mode, needle, cmd });
  }
  return rows;
}

function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    process.stderr.write('usage: premise.cjs <brief-path> [--cwd <dir>]\n');
    process.exit(2);
  }
  const i = process.argv.indexOf('--cwd');
  const cfg = loadConfig();
  const cwd = i !== -1 ? process.argv[i + 1] : (cfg.repo || process.cwd());

  const raw = fs.readFileSync(file, 'utf8');
  const rows = parseBlock(raw);
  if (!rows) process.exit(3);
  if (!rows.length) {
    // A brief that genuinely asserts nothing about the current tree is legitimate
    // — greenfield work is the common case. But it must SAY so, so that "I
    // checked and there was nothing to check" stays distinguishable from "I
    // forgot". `lint-brief.cjs` recommends exactly this form, so accept it here
    // or the two gates contradict each other.
    const block = (/```premise\n([\s\S]*?)```/.exec(raw) || [])[1] || '';
    const declared = /^\s*#\s*none\b\s*[—:-]?\s*\S/im.test(block);
    if (declared) {
      process.stdout.write('✅ premise: explicitly declared `# none` — this brief asserts nothing about the current tree.\n'
        + '   Nothing was checked because nothing was claimed. That is a different statement from silence.\n');
      process.exit(0);
    }
    process.stdout.write('premise: block present but empty — that is not a check.\n'
      + '   Add `expect`/`absent` rows, or declare `# none — <why>` if the brief truly asserts nothing.\n');
    process.exit(1);
  }

  let failed = 0;
  process.stdout.write(`PREMISE CHECK — ${path.basename(file)}  (cwd ${cwd})\n\n`);
  for (const r of rows) {
    if (r.bad) {
      process.stdout.write(`  ❌ MALFORMED  ${r.why}\n     ${r.bad}\n`);
      failed++; continue;
    }
    let out = '', code = 0;
    try {
      out = execSync(r.cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    } catch (e) {
      out = `${e.stdout || ''}${e.stderr || ''}`;
      code = typeof e.status === 'number' ? e.status : -1;
    }
    const hit = out.includes(r.needle);
    let ok = r.mode === 'expect' ? hit : !hit;
    let vacuous = null;

    // ── ANTI-VACUITY 2 · `absent` is FAIL-OPEN on a broken command ───────────
    // CRITICAL: This is the one that matters. On a non-zero exit the catch above puts
    // the ERROR TEXT in `out`; the error text does not contain the needle; so
    // `absent` reports a confident PASS for a command that never ran. A typo'd
    // path, a missing ref, an unfetched `origin/main` — every one of them
    // "proves" the thing is absent. `expect` has no such hole: a broken command
    // fails it, which is correct.
    if (r.mode === 'absent' && code !== 0) {
      ok = false;
      vacuous = `command exited ${code} — an \`absent\` check cannot be satisfied by a command that did not run. `
              + 'The needle is missing from an error message, not from the repository.';
    }

    // ── ANTI-VACUITY 3 · nothing came back at all ───────────────────────────
    // `absent X :: <command producing no output>` is true of every X in the
    // universe. It asserts nothing about this repository.
    if (r.mode === 'absent' && code === 0 && !out.trim()) {
      ok = false;
      vacuous = 'the command produced NO OUTPUT, so `absent` is true of every possible needle. '
              + 'Point it at something that prints, then assert about what it prints.';
    }

    const first = out.split('\n').filter(Boolean)[0] || '(no output)';
    process.stdout.write(
      `  ${ok ? '✅' : '❌'} ${r.mode.padEnd(6)} "${r.needle}"  exit=${code}\n`
      + `     $ ${r.cmd}\n`
      + `     ${first.slice(0, 120)}${out.split('\n').filter(Boolean).length > 1 ? ' …' : ''}\n`
      + (vacuous ? `     CRITICAL: VACUOUS — ${vacuous}\n` : ''));
    if (!ok) failed++;
  }
  if (failed) {
    process.stdout.write(
      `\nCRITICAL: ${failed} PREMISE CHECK(S) FAILED — the brief describes something that is not true.\n`
      + '   Do NOT "fix" the check to match the world. Re-read the premise: the work may be\n'
      + '   done, may never have applied, or may be true of a NEARBY object. Rewrite or retire\n'
      + '   the brief. If the check itself is wrong, say so in the brief and prove it.\n');
    process.exit(1);
  }
  process.stdout.write(`\n✅ ${rows.length} premise check(s) pass — true at ${new Date().toISOString()}.\n`
    + '   WARNING: True NOW. A premise is only true at its timestamp; re-run at land if the brief is long-lived.\n');
}

main();

#!/usr/bin/env node
/**
 * check-merge-diff.cjs — refuse a PR whose MERGE DIFF touches paths the window
 * does not own.
 *
 * WHY THIS EXISTS. On 2026-08-25 W3 was one command from opening a PR that would
 * have DELETED 725 lines of W1's freshly-landed `#608` — the night/dawn lighting
 * work — because its branch predated that merge. Its own commit stat said
 * `218 insertions(+)` and was perfectly true:
 *
 *     git diff --stat <its commit>   ->  1 file changed, 218 insertions(+)
 *     git diff --stat origin/main HEAD
 *          .../day_night_palette.dart          42 ---
 *          .../scene_lighting.dart             46 ---
 *          .../world_light_component.dart     315 ------
 *          .../night_transparency_test.dart   363 ------
 *          7 files changed, 286 insertions(+), 725 deletions(-)
 *
 * KEY: THE COMMIT STAT AND THE MERGE DIFF ARE DIFFERENT QUESTIONS, AND ONLY THE
 * SECOND ONE IS THE PR. The PR body would have advertised the first.
 *
 * The window caught it by diffing against `main` instead of trusting its own
 * stat. Nothing in the tooling required that, so this does.
 *
 * WARNING: Deletions outside the claim are the dangerous half — an addition outside a
 * claim is a scope error the path lock already catches at commit time, but a
 * DELETION arrives from being stale rather than from writing, so no lock sees it.
 *
 * \ud83d\udd34 RUN IT AFTER COMMITTING. It diffs origin/main against HEAD and is blind to
 * uncommitted work \u2014 run early it reports a confident clean pass over an empty diff
 * while your change sits unstaged. A dirty tree is therefore refused, not passed.
 *
 * \u26a0\ufe0f  READ THE EXIT CODE, NOT THE TAIL. The natural way to read long output is to
 * pipe it and the natural way to check a gate is `$?` \u2014 but a piped exit code is the
 * PIPE's. W3 saw the red block and `EXIT=0` in the same breath. Capture first:
 * `OUT=$(check-merge-diff.cjs W3); RC=$?`.
 *
 * Usage: check-merge-diff.cjs <window> [--base origin/main] [--cwd <repo>]
 * Exit 0 clean · 1 out-of-claim paths found · 2 usage.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ORCH = __dirname;

function cfg() {
  try { return JSON.parse(fs.readFileSync(path.join(ORCH, 'projects', 'cleaning.json'), 'utf8')); }
  catch (e) { return {}; }
}

/**
 * Claim matching is DELEGATED to claim.cjs, not reimplemented here.
 *
 * CRITICAL: It used to be reimplemented, and the two drifted while this comment asserted
 * they had not. The old comment said "Same glob semantics as claim.cjs — `**`
 * spans separators, `*` does not", and that was TRUE for wildcards and FALSE for
 * the case a human is most likely to type: a bare directory.
 *
 *   claim.cjs:103   `file === p || file.startsWith(`${p}/`)`  -> a no-wildcard
 *                   pattern matches by DIRECTORY PREFIX, so `docs/ref-check`
 *                   covers `docs/ref-check/bear_front_lineup.png`.
 *   here (old)      built `^...$` from `*`/`**` only, with no prefix rule, so
 *                   `docs/ref-check` matched ONLY the literal string.
 *
 * The result: a directory claim written without `/**` PASSED the pre-commit path
 * lock and FAILED this check at the step immediately before the PR — same claim,
 * same paths, opposite verdicts. Found by W3 on 2026-09-03 against a clean
 * 12-file diff (+144/-4, zero deletions); the alarm was entirely this matcher.
 *
 * That is the gate-that-cries-wolf shape this repo relaxes rather than debugs,
 * and §4b is not a gate anyone should learn to ignore — it exists because W3
 * once nearly deleted 725 lines of W1's work.
 *
 * claim.cjs is the AUTHORITY: it is what the pre-commit lock enforces. Two
 * instruments cannot drift if there is only one.
 * -> [[a-reimplemented-gate-rule-is-a-second-instrument]]
 */
const { matches: claimMatches } = require('./claim.cjs');
function matches(globs, p) {
  return globs.some((g) => claimMatches(p, g));
}

function main() {
  const win = process.argv[2];
  if (!win || !/^W[0-5]$/.test(win)) {
    process.stderr.write('usage: check-merge-diff.cjs <W0-W5> [--base origin/main] [--cwd <repo>]\n');
    process.exit(2);
  }
  const c = cfg();
  const i = process.argv.indexOf('--cwd');
  const j = process.argv.indexOf('--base');
  // CRITICAL: process.cwd() WINS. `c.repo` is the ROOT CHECKOUT, which CLAUDE.md says is
  // the integration tree and never a working tree — so it is ALWAYS behind
  // origin/main. Defaulting to it made this gate diff a 15-commits-stale tree and
  // print a confident "rebase onto origin/main" at windows that had already
  // rebased. A gate that cries wolf on its first real use gets relaxed.
  const cwd = i !== -1 ? process.argv[i + 1] : process.cwd();
  const base = j !== -1 ? process.argv[j + 1] : 'origin/main';

  const claimFile = path.join(c.vault || '.', (c.claim && c.claim.dir) || '.claude/claims', `${win}.json`);
  let globs = [];
  try { globs = JSON.parse(fs.readFileSync(claimFile, 'utf8')).paths || []; } catch (e) { /* none */ }
  if (!globs.length) {
    process.stdout.write(`WARNING:  ${win} holds no live claim — cannot check a merge diff against nothing.\n`
      + '   Take the claim first, or pass the paths this branch is allowed to touch.\n');
    process.exit(2);
  }

  // 🥇 REFUSE WHEN THERE IS NO BRANCH UNDER TEST. Diffing main against origin/main
  // is not a PR check under any circumstances, so it is an ERROR rather than a
  // result. This makes the wrong-tree failure impossible instead of unlikely —
  // W3's suggestion, and better than fixing the default alone.
  let branch = '', head = '', baseSha = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim();
    head = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
    baseSha = execSync(`git rev-parse ${base}`, { cwd, encoding: 'utf8' }).trim();
  } catch (e) {
    process.stdout.write(`\u274c not a git tree, or ${base} is unknown, at ${cwd}\n`);
    process.exit(2);
  }
  if (branch === 'main' || branch === 'master') {
    process.stdout.write(
      `\ud83d\udd34 HEAD is on '${branch}' at ${cwd} \u2014 there is no branch under test.\n\n`
      + '   Diffing main against origin/main is not a PR check. You are almost certainly\n'
      + '   pointed at the ROOT CHECKOUT, which is the integration tree and is always\n'
      + '   behind origin/main by design.\n\n'
      + '   FIX: run this from inside your worktree, or pass --cwd <worktree>.\n');
    process.exit(2);
  }
  // CRITICAL: REFUSE ON A DIRTY TREE. This compares origin/main against HEAD, so it is
  // BLIND to uncommitted work — run before committing it returns a confident
  // "0 file(s) … every changed path is inside the claim" while the actual change
  // sits unstaged. W3 flagged it: "not a bug, but it reads like a pass and it is
  // a no-op." A gate that passes vacuously is worse than no gate, so a dirty tree
  // is now an ERROR naming what is uncommitted rather than a green tick.
  let dirty = '';
  try { dirty = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim(); } catch (e) { /* handled below */ }
  if (dirty) {
    const rows = dirty.split('\n');
    process.stdout.write(
      `\ud83d\udd34 WORKING TREE IS DIRTY \u2014 ${rows.length} uncommitted path(s). This check reads HEAD,\n`
      + '   so it CANNOT see them and a pass here would be vacuous.\n\n'
      + rows.slice(0, 12).map((r) => `     ${r}`).join('\n') + '\n'
      + (rows.length > 12 ? `     … and ${rows.length - 12} more\n` : '')
      + '\n   FIX: commit first, then re-run. Run this AFTER committing, not before.\n');
    process.exit(2);
  }

  if (head === baseSha) {
    process.stdout.write(`\u2705 HEAD is exactly ${base} \u2014 nothing to review.\n`);
    return;
  }

  let raw = '';
  try {
    // CRITICAL: TWO TREES, NOT A MERGE BASE. `base...HEAD` is merge-base-relative and shows
    // only what HEAD ADDED since diverging — so a branch that is merely BEHIND shows
    // ZERO files and the check passes. That is precisely the case this exists to catch.
    // `git diff <base> HEAD` compares the trees directly and surfaces what HEAD is
    // MISSING as deletions. Proven: at b1c2d6f (one commit behind #608) the three-dot
    // form reported 0 files; the two-tree form reports the 725 deleted lines.
    raw = execSync(`git diff --numstat ${base} HEAD`, { cwd, encoding: 'utf8' });
  } catch (e) {
    process.stdout.write(`❌ could not diff against ${base}: ${e.message}\n`);
    process.exit(2);
  }

  const rows = raw.split('\n').filter(Boolean).map((l) => {
    const [add, del, p] = l.split('\t');
    return { add: add === '-' ? 0 : +add, del: del === '-' ? 0 : +del, p };
  });
  const outside = rows.filter((r) => !matches(globs, r.p));

  process.stdout.write(`MERGE DIFF — ${win} vs ${base}  (${rows.length} file(s))\n\n`);
  for (const r of rows) {
    const ok = matches(globs, r.p);
    process.stdout.write(`  ${ok ? '✅' : '❌'} +${String(r.add).padStart(4)} -${String(r.del).padStart(4)}  ${r.p}\n`);
  }

  if (!outside.length) {
    process.stdout.write(`\n✅ every changed path is inside ${win}'s claim.\n`);
    return;
  }
  const deleting = outside.filter((r) => r.del > 0);
  process.stdout.write(`\nCRITICAL: ${outside.length} PATH(S) OUTSIDE ${win}'s CLAIM.\n`);
  if (deleting.length) {
    const lines = deleting.reduce((n, r) => n + r.del, 0);
    process.stdout.write(
      `CRITICAL: ${deleting.length} OF THEM DELETE ${lines} LINE(S) YOU DO NOT OWN.\n\n`
      + '   This is almost always a STALE BRANCH, not a bad edit: something landed on\n'
      + `   ${base} after you branched, and a PR from here proposes reverting it.\n`
      + '   Your own commit stat will NOT show this — it is true of your commit and\n'
      + '   silent about the merge. Only this diff is the PR.\n\n'
      + `   FIX: rebase onto ${base}, then re-run this.\n`
      + '   WARNING: If the rebase conflicts because an earlier PR was SQUASH-merged, verify\n'
      + '   the content is genuinely already present before resetting — a reset --hard\n'
      + '   in a shared worktree is how someone else\'s PR gets reverted.\n');
  }
  process.exit(1);
}

main();

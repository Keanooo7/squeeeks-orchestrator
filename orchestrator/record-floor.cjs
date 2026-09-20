#!/usr/bin/env node
/**
 * record-floor.cjs — write a MEASURED test count to the repo's floor file, then
 * re-read it and print what is actually on disk.
 *
 * WHY THIS EXISTS
 *   `gates.cjs:168` has `testFloor(cwd, { record })`, which writes the floor.
 *   Nothing ever called it with `record: true`. So the capability was correct,
 *   present, and unreachable — F9 exactly, for the third time today: a guard's
 *   behaviour degrades loudly and its reachability degrades silently.
 *
 *   The cost, measured 2026-08-11: `.claude/test-floor.json` on `main` read
 *   **2975** while the suite measured **2990**. Two raises (#157 → 2978,
 *   #159 → 2990) landed and neither was written back. The packet generator was
 *   honest the whole time — it reads the file, so the FILE became the weak link
 *   and every brief after a raise carried a stale floor.
 *
 *   That is F1 resurfacing one level down. Generating the number stopped it
 *   being hand-copied into briefs; it did not stop the source going stale.
 *
 * WHY A SCRIPT AND NOT A LINE IN /land
 *   Because a line in /land is prose, and this session's own D14 says a defect
 *   filed as a lesson recurs while a defect filed as a gate does not. `/land`
 *   already said "raise the floor" and the floor still went stale twice.
 *
 * USAGE
 *   record-floor.cjs --measure                    # RUN the suite and bank what it says
 *   record-floor.cjs 2990 --skipped 2            # current branch, app repo
 *   record-floor.cjs 2990 --branch main --commit 2cff932 --note "…"
 *   record-floor.cjs --show                       # print, write nothing
 *
 * CRITICAL: `--measure` IS THE PATH THAT CLOSES THE TYPED-NUMBER HOLE.
 *   Every other path takes the count as an ARGUMENT — a human reads a terminal
 *   and retypes a number into a command, which is the step where 4180 becomes
 *   4108. `gates.cjs` has had `testFloor(cwd, { record })` since it was written
 *   and NOTHING EVER CALLED IT, so the capability was correct, present and
 *   unreachable while the typing went on beside it.
 *
 *   `--measure` routes at `gates.measureTests()` instead: it runs `make test`,
 *   parses flutter's own summary, refuses a run with a `-N` tail, and refuses a
 *   FILTERED run outright. The number is never spoken aloud, so it cannot be
 *   misheard.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ORCH = __dirname;
const gates = require(path.join(ORCH, '..', 'helpers', 'gates.cjs'));

function loadConfig(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ORCH, 'projects', `${name}.json`), 'utf8'));
  } catch (e) {
    process.stderr.write(`record-floor: no usable adapter '${name}'\n`);
    process.exit(2);
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--show') { out.show = true; continue; }
    // A BOOLEAN FLAG MUST BE DECLARED HERE OR IT EATS THE NEXT ARGUMENT.
    // The generic branch below does `out[key] = argv[++i]`, so an undeclared
    // `--measure` would consume whatever followed it — silently, and with a
    // plausible-looking result.
    if (a === '--measure') { out.measure = true; continue; }
    if (a.startsWith('--')) { out[a.slice(2)] = argv[++i]; continue; }
    out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(process.env.ORCH_PROJECT || 'cleaning');
  // Resolve the repo from the CALLER'S CWD, not from the adapter.
  //
  // W1 found this the hard way (2026-08-11): run from inside a worktree, this
  // defaulted to `cfg.repo` — the ROOT checkout — and wrote the floor into the
  // integration tree instead of the branch under test. It then re-read the file
  // it had just written and reported success, so the verify-by-re-read guard
  // confirmed a write to the WRONG FILE. W1 had to revert the root and write
  // the worktree by hand, twice.
  //
  // A worktree IS the repo for the branch being gated; the adapter's `repo` is
  // only a default for callers with no cwd of their own.
  // Use the cwd's repo ONLY if it is the project repo or one of its worktrees.
  //
  // Third shape of the same bug: the VAULT is also a git repo and also has a
  // `.claude/test-floor.json` (the retired copy), so resolving purely from cwd
  // made W0 target the wrong project's floor file entirely. Worktrees share a
  // git common dir with their repo, which is the check that distinguishes
  // "a worktree of the thing I am gating" from "some other repo I happen to be
  // standing in".
  const sameRepo = (a, b) => {
    const g = (d) => (gates.run('git', ['rev-parse', '--git-common-dir'], d, 15000).out || '').trim();
    const ga = g(a), gb = g(b);
    return ga && gb && path.resolve(a, ga) === path.resolve(b, gb);
  };
  const cwdRoot = gates.repoRootOf(process.cwd());
  const repo = args.repo
    || ((cwdRoot && sameRepo(cwdRoot, cfg.repo)) ? cwdRoot : cfg.repo);
  const file = gates.floorFileFor(repo);
  // Key the floor by the MERGE TARGET, not the working branch.
  //
  // W1, 2026-08-11, the second defect in this tool: it keyed by the current
  // branch, so landing a brief wrote
  //     {"main": {…2994…}, "feature+door-leaf-wiring": 3015}
  // — `main`, the number every packet reads, was left STALE, and the entry it
  // did write was a bare int under a key that dies with the branch, in a
  // different schema from main's object. The tool reported success both times.
  //
  // W1's framing is the fix: a floor measured on a feature branch is a
  // PREDICTION ABOUT MAIN. That is what the `commit` field is for — it records
  // where the measurement was taken, while the key records what it constrains.
  const target = (cfg.baseRef || 'origin/main').replace(/^origin\//, '');
  const branch = args.branch || target;
  const measuredOn = gates.branchOf(repo) || 'unknown';

  const floors = gates.readFloors(repo);

  if (args.show) {
    process.stdout.write(`${file}\n`);
    for (const [k, v] of Object.entries(floors)) {
      if (k.startsWith('_')) continue;
      process.stdout.write(`  ${k.padEnd(38)} ${JSON.stringify(v && typeof v === 'object' ? v.count : v)}\n`);
    }
    return;
  }

  // PROVENANCE. `commit` must name THE TREE THAT PRODUCED THIS COUNT, and the
  // only tree this process can vouch for is the one it is standing in — HEAD,
  // and only if HEAD is clean. On 2026-08-15 (#370) this field carried the BASE
  // sha a branch was cut from while the count described the branch, so
  // `git show <commit>` would have reproduced a different number. A provenance
  // that is wrong is harder to correct than one that is merely old, because it
  // still looks checkable. So: a dirty tree cannot be vouched for, and says so.
  //
  // NOTE: HOISTED ABOVE THE COUNT so `--measure` fails fast. This check used to sit
  // after the count was read, which cost nothing when the count was typed and
  // costs a full ~2-minute suite run when it is measured — a run whose result
  // was going to be refused either way.
  const head = gates.run('git', ['rev-parse', '--short', 'HEAD'], repo, 15000).out.trim() || null;
  const dirty = (gates.run('git', ['status', '--porcelain'], repo, 20000).out || '')
    .split('\n').filter((l) => l.trim() && !l.includes('.orchestrator/')).length > 0;

  if (!args.commit && dirty) {
    process.stderr.write(
      `record-floor: REFUSED — the working tree is DIRTY, so HEAD (${head}) is not the tree\n`
      + '              that produced this count. Commit first, or pass the measured sha\n'
      + '              explicitly with --commit <sha>. A floor whose `commit` does not\n'
      + '              reproduce its number is worse than no floor: it still looks checkable.\n');
    process.exit(1);
  }

  // THE COUNT. Measured here, or typed by the caller — and `--measure` exists so
  // that the second one stops being the only option.
  let count;
  let measuredSkipped = null;
  if (args.measure) {
    if (args._[0] !== undefined) {
      process.stderr.write(
        'record-floor: REFUSED — `--measure` and a positional count are contradictory.\n'
        + '              One of them is about to be wrong and nothing here can tell you which.\n');
      process.exit(2);
    }
    process.stderr.write(`record-floor: measuring — \`make test\` in ${repo}\n`);
    const m = gates.measureTests(repo);
    if (!m.ok) {
      process.stderr.write(`record-floor: REFUSED — ${m.detail}\n`);
      process.exit(1);
    }
    count = m.counts.passed;
    measuredSkipped = m.counts.skipped;
    process.stderr.write(`record-floor: measured ${m.detail}\n`);
    // NAME THE LOG. The parse above is authoritative; this is what makes it
    // checkable by someone other than the tool that produced it.
    if (m.logPath) {
      process.stderr.write(`record-floor: raw suite log -> ${m.logPath}\n`);
      process.stderr.write("              grep it for a failure field — a `-N` tail can hide anywhere\n"
        + "              in a long run, and a rising pass count does not rule one out:\n"
        + `                grep -nE '\\+[0-9]+ *(~[0-9]+ *)?-[1-9]' ${m.logPath}\n`);
    }
  } else {
    count = parseInt(args._[0], 10);
    if (!Number.isFinite(count) || count <= 0) {
      process.stderr.write('record-floor: pass a measured count, e.g. `record-floor.cjs 2990`,\n'
        + '              or `--measure` to run the suite and bank what it says.\n'
        + '              A count of 0 is not a floor — it is an unmeasured one.\n');
      process.exit(2);
    }
  }

  const prev = gates.floorOf(floors, branch);

  // The floor may RISE and may not fall. A drop is a regression to investigate,
  // never a number to edit — so this refuses rather than asking.
  if (prev !== null && count < prev) {
    process.stderr.write(
      `record-floor: REFUSED — ${count} < recorded ${prev} on '${branch}'.\n`
      + '              The live count is the contract and must never fall in a PR.\n'
      + '              A run coming in under is a regression to find, not a number to lower.\n');
    process.exit(1);
  }

  const before = prev === null ? 'UNKNOWN' : String(prev);
  const entry = floors[branch];

  // A NOTE DESCRIBES ONE MEASUREMENT AND EXPIRES WITH IT. Spreading the previous
  // entry used to carry a stale note forward beside a NEW count — #369 shipped
  // `count: 3558` sitting next to a note quoting `+3549` at `63b0810`, which is
  // self-contradicting and still shaped like evidence. This tool will not write
  // a note it did not receive; dropping it is strictly better than inheriting a
  // lie. `test-floor.json`'s own _comment warned about this in PROSE on
  // 2026-08-14 and it recurred on the 15th — a warning is not a guard.
  // A SHA MEASURED ON A FEATURE BRANCH DIES AT SQUASH, AND THE FIELD STILL LOOKS
  // CHECKABLE. `commit` is honest when written — it really is the tree that
  // produced the count — but this repo squash-merges, so the moment the brief
  // lands that sha is unreachable from `main` and `git show <commit>` resolves
  // to nothing. Recorded twice on 2026-08-15: `7daede0` on `feature+the-doors`
  // (#404) and an earlier one W3 hand-corrected. Both were TRUE and both became
  // unverifiable within the hour.
  //
  // The fix is not prose — this file already says "a warning is not a guard" one
  // block up. It is DATA: when the measured branch is not the merge target, say
  // so in a field a reader can test, so a floor whose provenance has expired is
  // distinguishable from one that never had any. The obligation it records is
  // W3's practice, which is the correct one: re-measure on the INTEGRATED TIP
  // after the squash and re-record, so `commit` names a tree that still exists.
  // CRITICAL: THE PREDICATE IS REACHABILITY, NOT THE BRANCH NAME YOU HAPPEN TO STAND ON.
  // Until 2026-08-16 this read `measuredOn !== branch`, which asks "am I on the
  // merge target?" when the question the flag exists to answer is "will this sha
  // survive the squash?" Those come apart in exactly the case the block above
  // PRESCRIBES: W0 cut a throwaway branch AT `origin/main`, ran the post-squash
  // gate there, and recorded `--commit cdeb142` — the integrated tip itself. The
  // sha was permanent and the tool stamped it `commit_is_pre_squash: true`.
  // So the guard fired on the one workflow it was written to encourage, and the
  // flag said "unverifiable" about a sha `git show` resolves forever. A false
  // provenance warning costs more than none: the next reader re-measures a number
  // that was already checkable, and learns to disbelieve the flag.
  // Ask git instead. A commit reachable from the merge target cannot be squashed
  // away — it is already in that history.
  const recordedCommit = args.commit || head;
  // KEY: ONE DEFINITION, TWO CALLERS. This predicate used to be spelled out here
  // and is now `gates.commitReachable` — because return-gate.cjs COLLECTS the
  // debt this line STAMPS, and a second copy of the rule is exactly how the two
  // floor files drifted apart in the first place. The reasoning, including why
  // `.ok` and not `.code`, moved with it.
  const reachable = gates.commitReachable(repo, recordedCommit, `origin/${branch}`);
  const preSquash = !reachable && measuredOn !== branch && measuredOn !== 'unknown';

  const { note: _staleNote, commit_is_pre_squash: _staleFlag, ...carried } =
    (entry && typeof entry === 'object') ? entry : {};
  floors[branch] = (entry && typeof entry === 'object')
    ? { ...carried, count, skipped: measuredSkipped !== null ? measuredSkipped : (parseInt(args.skipped, 10) || 0),
        measured_at: new Date().toISOString().slice(0, 10),
        commit: args.commit || head,
        measured_on: measuredOn,
        ...(preSquash ? { commit_is_pre_squash: true } : {}),
        ...(args.note ? { note: args.note } : {}) }
    : count;

  if (preSquash) {
    process.stderr.write(
      `record-floor: WARNING:  measured on '${measuredOn}', recording against '${branch}'.\n`
      // Name the sha actually WRITTEN, not HEAD. They differ whenever --commit is
      // passed, which is the whole point of that flag, so the old message could
      // warn about a sha the file does not contain.
      + `              ${recordedCommit} is not reachable from origin/${branch}, and this repo\n`
      + `              squash-merges, so it\n`
      + '              becomes unreachable the moment this lands. `commit_is_pre_squash`\n'
      + '              is set. RE-RECORD ON THE INTEGRATED TIP after the squash.\n');
  }

  gates.writeFloors(floors, repo);

  // VERIFY BY RE-READ. Two windows have reported a raised floor without writing
  // the file; a write that is not read back is a claim, not a fact.
  const after = gates.floorOf(gates.readFloors(repo), branch);
  if (after !== count) {
    process.stderr.write(`record-floor: WROTE ${count} BUT RE-READ ${after} from ${file}. Do not trust this land.\n`);
    process.exit(1);
  }

  process.stdout.write(`floor ${before} → ${after} on '${branch}'`
    + (measuredOn !== branch ? `  (measured on '${measuredOn}')` : '')
    + `  (re-read from ${file})\n`);
}

if (require.main === module) main();

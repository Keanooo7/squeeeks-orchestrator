/**
 * gates.cjs — landing gates for the Cleaning App workflow.
 *
 * Enforces the standing rule: nothing is "done" until it is clean and on main.
 * Consumed by hook-handler.cjs ('pre-commit-gate', 'session-end') and by the
 * /land skill.
 *
 * SECURITY: every subprocess here uses execFileSync with an argv array, never
 * execSync(string). The open command-injection finding in github-safe.js is
 * exactly what that avoids — see wiki/security-helpers-remediation.md. Do not
 * "simplify" these into template-literal shell strings.
 *
 * Writes are split by destination, deliberately (2026-08-11). The VAULT floor
 * copy is private state and still goes through secure-fs (0600, atomic
 * temp+rename). A REPO floor file is committed and must stay 0644 — writing
 * 0600 over a tracked file changes its mode and dirties the index on every
 * land. See writeFloors().
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let secureFs = null;
try { secureFs = require('./secure-fs.js'); } catch (e) { /* optional */ }

/**
 * THE FLOOR FILE MOVED — 2026-08-11.
 *
 * This used to be an unconditional pin to the VAULT's copy. `bbc5b29`
 * (2026-08-09) created a second floor file inside the app repo, and the two
 * drifted apart: the vault said 2878 while the app repo said 2846, and a fresh
 * measurement on `main @ fa8ab3d` came in at **2975** (#155).
 *
 * W4 named the consequence exactly: `/land` compares against this file, so a
 * gate reading 2878 against a true floor of 2975 **passes a suite that has
 * silently lost up to 97 tests.** That is a false green on the one gate that
 * exists to catch a dropped count — strictly worse than no gate, because it
 * reports success.
 *
 * So the floor is now read from the repo under test: it is committed, it
 * travels with branches and worktrees, and a window can see it from inside its
 * own checkout. The vault copy is legacy and is used only when a repo has none.
 */
const LEGACY_FLOOR_FILE = path.join(__dirname, '..', 'test-floor.json');

/** Top level of the working tree containing `cwd`, or null. */
function repoRootOf(cwd) {
  if (!cwd) return null;
  const r = run('git', ['rev-parse', '--show-toplevel'], cwd, 15000);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

/**
 * The floor file governing `cwd`. Prefers the repo's own; falls back to the
 * vault copy so this stays working in a checkout that has not adopted one.
 */
function floorFileFor(cwd) {
  const root = repoRootOf(cwd);
  if (root) {
    const f = path.join(root, '.claude', 'test-floor.json');
    if (fs.existsSync(f)) return f;
  }
  return LEGACY_FLOOR_FILE;
}

// Retained for callers that predate the move. Prefer floorFileFor(cwd).
const FLOOR_FILE = LEGACY_FLOOR_FILE;

/** Run argv in cwd. Returns {ok, out}. Never throws. */
function run(cmd, argv, cwd, timeout = 300000, env = null) {
  try {
    const out = execFileSync(cmd, argv, {
      cwd,
      timeout,
      ...(env ? { env } : {}),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, out: out || '' };
  } catch (e) {
    const out = `${(e.stdout || '')}${(e.stderr || '')}` || e.message || '';
    return { ok: false, out };
  }
}

/**
 * Is this directory a Flutter project with our Makefile gates? The gate must
 * stay inert everywhere else — the vault itself has no build system, and
 * blocking commits there would be wrong.
 */
function isGatedRepo(cwd) {
  if (!cwd) return false;
  try {
    if (!fs.existsSync(path.join(cwd, 'pubspec.yaml'))) return false;
    const mk = path.join(cwd, 'Makefile');
    if (!fs.existsSync(mk)) return false;
    return /^analyze:/m.test(fs.readFileSync(mk, 'utf8'));
  } catch (e) { return false; }
}

/** `make analyze` must report "No issues found!". */
function analyzeClean(cwd) {
  const r = run('make', ['analyze'], cwd);
  if (r.ok && /No issues found/i.test(r.out)) {
    return { pass: true, detail: 'analyze: 0 issues' };
  }
  const issues = (r.out.match(/^\s*(error|warning|info)\s+•/gim) || []).length;
  const lines = r.out.split('\n').filter((l) => /•/.test(l)).slice(0, 25);
  return {
    pass: false,
    detail: `analyze: ${issues || 'unknown'} issue(s)\n${lines.join('\n')}`,
  };
}

/** Parse the trailing "All tests passed" / "+N -M" summary from a test run. */
function parseTestCount(out) {
  const m = [...out.matchAll(/\+(\d+)(?:\s*~(\d+))?(?:\s*-(\d+))?/g)].pop();
  if (!m) return null;
  return { passed: +m[1], skipped: +(m[2] || 0), failed: +(m[3] || 0) };
}

function readFloors(cwd) {
  const file = cwd ? floorFileFor(cwd) : FLOOR_FILE;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

/**
 * A repo's floor file is COMMITTED, so it must stay 0644 and readable. The
 * vault copy is private state and keeps its 0600 secure write. Writing 0600
 * over a tracked file would change its mode and dirty the index on every land.
 */
function writeFloors(obj, cwd) {
  const file = cwd ? floorFileFor(cwd) : FLOOR_FILE;
  if (file === LEGACY_FLOOR_FILE && secureFs && secureFs.writeJsonSecure) {
    return secureFs.writeJsonSecure(file, obj);
  }
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o644 });
}

/**
 * Read a branch's floor out of either shape in use: a bare number (the vault
 * copy's older entries) or an object with a `count` field (the app repo's).
 *
 * A resolved 0 — or a `default: 0` entry standing in for a missing branch —
 * returns null, never 0. That silent zero is what made the STATE block report
 * `test floor 0`; the guard was defeated by data rather than by logic.
 */
function floorOf(floors, branch) {
  const e = floors[branch];
  const n = (e && typeof e === 'object') ? e.count : e;
  return (typeof n === 'number' && Number.isFinite(n) && n > 0) ? n : null;
}

/** Current branch name, or null. */
function branchOf(cwd) {
  const r = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 15000);
  return r.ok ? r.out.trim() : null;
}

/**
 * Is `commit` already in `ref`'s history?
 *
 * KEY: THE PREDICATE IS REACHABILITY, NOT THE BRANCH NAME YOU HAPPEN TO STAND ON.
 * This repo squash-merges, so a sha measured on a feature branch stops existing
 * the moment the brief lands — `git show <commit>` resolves to nothing and a
 * provenance field that still LOOKS checkable is worse than one that is merely
 * old. A commit reachable from the merge target cannot be squashed away: it is
 * already in that history.
 *
 * WARNING: `run` returns { ok, out } and NO exit code — `.code` is undefined here, so
 * testing it silently evaluates false and every sha reads as unreachable. `ok`
 * IS the exit-status channel: execFileSync throws on non-zero, and
 * `merge-base --is-ancestor` communicates entirely through its exit status.
 *
 * Extracted here so record-floor.cjs (which STAMPS the debt) and
 * return-gate.cjs (which COLLECTS it) cannot drift apart. Two copies of this
 * rule is how the two floor files drifted apart in the first place.
 */
function commitReachable(repo, commit, ref) {
  if (!commit) return false;
  return run('git', ['merge-base', '--is-ancestor', commit, ref], repo, 15000).ok;
}

/**
 * The floor entry for `branch` and whether its provenance SURVIVES.
 *
 * `from: 'target'` reads the floor out of `origin/<branch>` — the copy that
 * actually landed, freshly fetched. `from: 'tree'` reads the working tree's.
 * The distinction is load-bearing and gates.cjs already learned it once: a
 * branch cut before the last floor land carries a STALE `main` entry committed
 * alongside it, so the working tree is the one artifact where the authoritative
 * number does NOT appear.
 *
 * `banked` is the whole question: does this floor name a tree that still exists?
 * It is false when the entry is stamped `commit_is_pre_squash: true` (the debt
 * record-floor.cjs writes and, until now, nothing collected) AND false when the
 * sha simply is not an ancestor — which catches a hand-edited entry whose flag
 * was never written at all.
 */
function floorAnchor(repo, branch = 'main', { from = 'target' } = {}) {
  let floors;
  if (from === 'target') {
    const r = run('git', ['show', `origin/${branch}:.claude/test-floor.json`], repo, 20000);
    if (!r.ok) return { readable: false, why: `cannot read origin/${branch}:.claude/test-floor.json` };
    try { floors = JSON.parse(r.out); }
    catch (e) { return { readable: false, why: `origin/${branch}'s floor file is not JSON: ${e.message.split('\n')[0]}` }; }
  } else {
    floors = readFloors(repo);
  }
  const entry = floors[branch];
  if (!entry || typeof entry !== 'object') {
    return { readable: true, present: false, why: `no object entry for '${branch}' in the ${from} floor file` };
  }
  const commit = entry.commit ? String(entry.commit).trim() : null;
  const flagged = entry.commit_is_pre_squash === true;
  const reachable = commitReachable(repo, commit, `origin/${branch}`);
  const banked = !!commit && !flagged && reachable;
  const why = !commit
    ? `the '${branch}' entry records no \`commit\`, so its count has no provenance at all`
    : flagged
      ? `the '${branch}' entry is stamped \`commit_is_pre_squash: true\` at ${commit} — the debt record-floor.cjs recorded and nobody collected`
      : !reachable
        ? `${commit} is NOT an ancestor of origin/${branch}, so \`git show ${commit}\` cannot reproduce this count`
        : `${commit} is an ancestor of origin/${branch}`;
  return {
    readable: true, present: true, count: entry.count ?? null,
    commit, flagged, reachable, banked, why, measured_at: entry.measured_at || null,
  };
}

/**
 * Test count must not drop. Floors are per-branch: hot.md already records 1247
 * on the factory branch vs 1254 on core-usability, so a single global number
 * would produce false failures.
 */
/**
 * CRITICAL: A FILTERED RUN MUST NEVER BE RECORDABLE AS A FLOOR.
 *
 * `make test` is literally `flutter test $(ONLY)` (Makefile:327), and make
 * imports the environment as make variables — so an exported `ONLY=` filters
 * the suite with no argument passed and no notice given. The run then exits 0
 * having measured a SUBSET, and a subset recorded as a floor is a floor that
 * every later full run trivially beats. That is the same shape as
 * `gallery-shots ONLY=`, which renders one tile and exits 0 (Makefile:453-470),
 * and as `factory-verify ONLY=`, which skips the floor by design (:694).
 *
 * The drop guard does NOT cover this. Filtering always reduces the count, so a
 * filtered run under an existing floor is refused as a drop — but a branch with
 * no floor of its own inherits from origin/main, and a first record has nothing
 * to be under. The dangerous case is precisely the one the drop guard cannot see.
 *
 * Both halves on purpose: REFUSE when a filter is set, because that is the
 * honest report, and SCRUB it from the child anyway, because that is the
 * guarantee. A detection that leaves the variable in place still runs the
 * filtered suite in every other caller.
 */
const FILTER_VARS = ['ONLY', 'ARGS'];

/** Which suite-filtering variables are set in this process's environment. */
function filterVarsSet(env = process.env) {
  return FILTER_VARS.filter((k) => String(env[k] || '').trim() !== '');
}

/** An environment with every suite-filtering variable removed. */
function unfilteredEnv(env = process.env) {
  const out = { ...env };
  for (const k of FILTER_VARS) delete out[k];
  return out;
}

/**
 * Run the Flutter suite and return a parsed, TRUSTWORTHY count — or the reason
 * it is not one. This is the single place the suite is run and parsed; both
 * testFloor and record-floor.cjs --measure route through it, so there is one
 * definition of "what the suite measured" rather than two that can drift.
 *
 * Returns { ok, counts, detail, out }. `ok:false` means DO NOT RECORD THIS.
 */
/**
 * CRITICAL: A LOG THAT WAS NEVER WRITTEN CANNOT BE GREPPED.
 *
 * W1 found this on W1-241, against this very function: the standing instruction
 * is to grep the WHOLE suite log for a failure field rather than reading the
 * last line alone — because `+3985 ~2 -1` is a FAILURE with a rising pass count,
 * and a `-N` can hide anywhere in a long run. measureTests captured the output
 * in-process and dropped it, so on the `--measure` path that instruction was
 * NOT EXECUTABLE BY THE CALLER AT ALL. The tool vouched for itself and there was
 * no independent read available, which W1 correctly recorded as a limitation
 * rather than papering over with a second suite run.
 *
 * So persist it and name the path. The parse stays authoritative; this makes it
 * CHECKABLE, which is a different property and the one that was missing.
 * Written to the system temp dir on purpose: the repo's floor recorder refuses a
 * dirty tree, so a log written inside the repo would break the very run it
 * documents.
 */
function persistRunLog(out) {
  try {
    const f = path.join(os.tmpdir(), `make-test-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    fs.writeFileSync(f, out, { mode: 0o644 });
    return f;
  } catch (e) { return null; }
}

function measureTests(cwd) {
  const filtered = filterVarsSet();
  if (filtered.length) {
    return {
      ok: false,
      counts: null,
      out: '',
      detail: `test: REFUSED to measure — ${filtered.map((k) => `${k}=${process.env[k]}`).join(', ')} `
            + `is set in the environment.
`
            + `\`make test\` is \`flutter test $(ONLY)\` and make imports the environment, so this run `
            + `would measure a SUBSET of the suite and exit 0.
`
            + `A subset recorded as a floor is a floor every later full run beats. `
            + `Unset it and measure the whole suite.`,
    };
  }
  // Scrubbed even though we just refused on it: the refusal is the report, this
  // is the guarantee. A variable set between the check and the spawn, or one
  // inherited by a nested make, cannot filter this run.
  const r = run('make', ['test'], cwd, 3600000, unfilteredEnv());
  const counts = parseTestCount(r.out);
  if (!counts) {
    return { ok: false, counts: null, out: r.out, detail: 'test: could not parse a count from the run output' };
  }
  // CRITICAL: THE `-N` TAIL IS THE ENTIRE SIGNAL AND IT IS THE LAST FIELD.
  // `+3985 ~2 -1` is a FAILURE with a RISING pass count.
  if (counts.failed > 0) {
    return {
      ok: false,
      counts,
      out: r.out,
      logPath: persistRunLog(r.out),
      detail: `test: ${counts.failed} FAILED (+${counts.passed} ~${counts.skipped} -${counts.failed})`,
    };
  }
  return {
    ok: true,
    counts,
    out: r.out,
    logPath: persistRunLog(r.out),
    detail: `test: +${counts.passed} ~${counts.skipped} -${counts.failed}`,
  };
}

function testFloor(cwd, { record = false } = {}) {
  const branch = branchOf(cwd) || 'unknown';
  const m = measureTests(cwd);
  if (!m.ok) return { pass: false, detail: m.detail, counts: m.counts };
  const counts = m.counts;
  const file = floorFileFor(cwd);
  const floors = readFloors(cwd);
  let floor = floorOf(floors, branch);
  let source = `'${branch}' in ${file}`;

  // A branch legitimately has no floor of its own on its first run. Inherit the
  // baseline from origin/main — and read it OUT OF origin/main, never out of
  // this working tree.
  //
  // W4 found why that distinction matters (2026-08-11). The floor file is
  // committed, so a branch cut before the last floor land carries a STALE
  // `main` entry with it: `.worktrees/door-leaf-wiring` still holds main = 2846
  // while origin/main holds 2975. The old text here told the window to "measure
  // main first", and a window reading main from inside its own tree would find
  // 2846 — 129 low — then record a branch floor benchmarked against it and
  // believe it had gained 129 tests. The gate failed closed correctly; the
  // REMEDY was the misdirection. Resolving the baseline here removes the need
  // for the window to reason about it at all.
  if (floor === null) {
    // Fetch first. `origin/main` is a LOCAL remote-tracking ref that only moves
    // on fetch, so inheriting from it without fetching reads whatever this tree
    // last saw. W4, 2026-08-11: currently honest by coincidence, not by
    // property — if another window lands a floor raise and this tree has not
    // fetched, the baseline comes back low and a dropped suite passes. That is
    // the same species one level up: a gate reading a ref nobody guaranteed is
    // current. Taken deliberately at the cost of a network round trip, because
    // this gate is the last one before something ships.
    const fetched = run('git', ['fetch', '--quiet', 'origin', 'main'], cwd, 60000);
    if (!fetched.ok) {
      return {
        pass: false,
        detail: `test: +${counts.passed} ~${counts.skipped}, but '${branch}' has no measured floor `
              + `and \`git fetch origin main\` FAILED, so origin/main cannot be trusted as a baseline.\n`
              + `Refusing to inherit from a possibly-stale remote-tracking ref. Fix the fetch, or `
              + `record a floor for this branch deliberately.\n${fetched.out.trim().slice(0, 300)}`,
      };
    }
    const r = run('git', ['show', 'origin/main:.claude/test-floor.json'], cwd, 20000);
    if (r.ok) {
      try {
        const inherited = floorOf(JSON.parse(r.out), 'main');
        if (inherited !== null) {
          floor = inherited;
          const at = run('git', ['rev-parse', '--short', 'origin/main'], cwd, 15000);
          source = `inherited from origin/main@${at.ok ? at.out.trim() : '?'}:.claude/test-floor.json (main), `
                 + `freshly fetched — NOT from this working tree`;
        }
      } catch (e) { /* fall through to fail-closed */ }
    }
  }

  // Still nothing measurable. UNKNOWN is not zero, and must not read as a pass.
  // Previously `?? floors.default ?? 0` turned "no entry" into a floor of 0,
  // which every run trivially beats — a green that means nothing.
  if (floor === null) {
    return {
      pass: false,
      detail: `test: +${counts.passed} ~${counts.skipped}, but NO MEASURED FLOOR for '${branch}' `
            + `in ${file}, and none inheritable from origin/main.\n`
            + `A missing floor is UNKNOWN, never 0 — a run cannot "beat" a floor that was never `
            + `measured. Measure on origin/main and record it there.\n`
            + `WARNING: Do NOT read a floor out of this working tree: a branch cut before the last floor `
            + `land carries a stale 'main' entry committed alongside it.`,
      counts,
    };
  }

  if (counts.passed < floor) {
    return {
      pass: false,
      // ${source}, not ${file}. W4, 2026-08-11: the DROPPED path is the one a
      // window reads while blocked, and it was naming the working-tree file —
      // the single artifact where an inherited floor does NOT appear. A window
      // opening it finds a stale `main` and no entry for its own branch, sees a
      // gate quoting a number its named source does not contain, and reasonably
      // concludes the gate is broken or "corrects" the file downward. The green
      // path stated its provenance and the red path did not, which is exactly
      // backwards.
      detail: `test: count DROPPED — ${counts.passed} < floor ${floor} on ${branch} — ${source}. `
            + 'The live count is the contract; it must never fall in a PR.',
      counts,
    };
  }
  if (record && counts.passed > floor) {
    // Preserve the richer entry shape the app repo uses; do not flatten a
    // {count, measured_at, commit, note} object down to a bare number.
    const prev = floors[branch];
    floors[branch] = (prev && typeof prev === 'object')
      ? { ...prev, count: counts.passed, skipped: counts.skipped,
          measured_at: new Date().toISOString().slice(0, 10) }
      : counts.passed;
    writeFloors(floors, cwd);
  }
  return {
    pass: true,
    detail: `test: +${counts.passed} ~${counts.skipped} -${counts.failed} `
          + `(floor ${floor} on ${branch} — ${source})`,
    counts,
  };
}

/** Working tree has no uncommitted changes. */
function treeClean(cwd) {
  const r = run('git', ['status', '--porcelain'], cwd, 30000);
  const dirty = r.out.trim();
  return dirty
    ? { pass: false, detail: `tree: ${dirty.split('\n').length} uncommitted file(s)\n${dirty}` }
    : { pass: true, detail: 'tree: clean' };
}

/** No commits sitting unpushed on the current branch. */
function pushed(cwd) {
  const branch = branchOf(cwd);
  if (!branch || branch === 'HEAD') return { pass: true, detail: 'pushed: detached, skipped' };
  const up = run('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], cwd, 15000);
  if (!up.ok) return { pass: false, detail: `pushed: ${branch} has no upstream — never pushed` };
  const r = run('git', ['rev-list', '--count', `${up.out.trim()}..${branch}`], cwd, 15000);
  const n = parseInt(r.out.trim(), 10) || 0;
  return n === 0
    ? { pass: true, detail: 'pushed: up to date' }
    : { pass: false, detail: `pushed: ${n} unpushed commit(s) on ${branch}` };
}

/** Is there an open PR for this branch? Requires gh; silent if unavailable. */
function openPr(cwd) {
  const branch = branchOf(cwd);
  if (!branch) return { pass: true, detail: 'pr: unknown branch, skipped' };
  const r = run('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'], cwd, 30000);
  if (!r.ok) return { pass: true, detail: 'pr: gh unavailable, skipped' };
  try {
    const prs = JSON.parse(r.out || '[]');
    return prs.length
      ? { pass: true, detail: `pr: #${prs[0].number} open` }
      : { pass: false, detail: `pr: none open for ${branch}` };
  } catch (e) { return { pass: true, detail: 'pr: unparseable, skipped' }; }
}

module.exports = {
  isGatedRepo, analyzeClean, testFloor, treeClean, pushed, openPr,
  branchOf, parseTestCount, readFloors, writeFloors, run, FLOOR_FILE,
  floorFileFor, floorOf, repoRootOf, LEGACY_FLOOR_FILE,
  measureTests, commitReachable, floorAnchor, persistRunLog,
  FILTER_VARS, filterVarsSet, unfilteredEnv,
};

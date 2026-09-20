#!/usr/bin/env node
/**
 * sync-state.cjs — regenerate the STATE block at the top of wiki/hot.md.
 *
 * hot.md drifted badly when it was hand-written prose: on 2026-08-02 it claimed
 * "PR #31 open" while #31 had already merged. Anything a script can measure,
 * a script should measure. Narrative belongs in the handoff docs.
 *
 * Writes vault content (git-tracked, meant to be readable), so this uses a
 * plain write rather than secure-fs — same reasoning as the daily-logs
 * exemption in wiki/security-helpers-remediation.md.
 *
 * Usage:  node sync-state.cjs [--print]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const gates = require('./gates.cjs');
const orchFloors = require('../orchestrator/lib/floors.cjs');

const VAULT_ROOT = path.resolve(__dirname, '../..');
const HOT = path.join(VAULT_ROOT, 'wiki', 'hot.md');
const BEGIN = '<!-- STATE:BEGIN -->';
const END = '<!-- STATE:END -->';

const MAIN = process.env.ORCH_REPO || process.env.CLEANING_REPO || '/path/to/repo';

// The orchestrator adapter is the single description of where this project's
// floors live. Loading it here means /sync-state and the dispatch packet
// resolve every number by the same path — which is the whole point: on
// 2026-08-11 the design floor was live at four different values at once
// (hot.md 669, briefs 666 and 662, measured 653) because each consumer read it
// its own way. Falls back to the vault-only view if the adapter is missing, so
// this script still runs on a machine that has not been set up yet.
const ORCH_CFG = (() => {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'orchestrator', 'projects', 'cleaning.json'), 'utf8'));
  } catch (e) {
    return { vault: VAULT_ROOT, repo: MAIN, floors: {} };
  }
})();

// Windows are discovered from `git worktree list`, not hardcoded. The previous
// version pinned two paths and so could not see W2/W4 at all — it kept
// reporting the retired two-track model after the four-window split. Discovery
// also means this works unchanged on the Mac Studio, where the factory is a
// full clone rather than a worktree.
function discoverWindows() {
  const r = gates.run('git', ['worktree', 'list', '--porcelain'], MAIN, 15000);
  if (!r.ok) return [];
  const out = [];
  const seen = new Set();
  for (const block of r.out.split('\n\n')) {
    const p = (block.match(/^worktree (.+)$/m) || [])[1];
    if (!p) continue;
    const branch = ((block.match(/^branch (.+)$/m) || [])[1] || '').replace('refs/heads/', '');
    if (!branch || branch === 'main') continue;   // main is reported separately
    seen.add(branch);
    out.push({ key: labelFor(branch, p), cwd: p });
  }
  // Branches with no worktree were previously invisible — which hid
  // feature+topbar-fixes while PR #39 was open against it. A branch ahead of
  // origin/main is live work whether or not a worktree happens to point at it.
  const br = gates.run('git', ['branch', '--format=%(refname:short)'], MAIN, 15000);
  if (br.ok) {
    for (const branch of br.out.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (branch === 'main' || seen.has(branch)) continue;
      const ahead = gates.run('git', ['rev-list', '--count', `origin/main..${branch}`], MAIN, 15000);
      if ((parseInt(ahead.out.trim(), 10) || 0) === 0) continue;   // fully landed
      out.push({ key: labelFor(branch, ''), cwd: MAIN, detachedBranch: branch });
    }
  }
  return out;
}

// Open PRs, measured INDEPENDENTLY of any local ref.
//
// Why this exists: discoverWindows() finds branches two ways, and both are
// local-only. `git worktree list` sees worktree-backed branches; `git branch`
// sees local branches. A branch pushed from a window whose worktree was then
// removed has NEITHER — no worktree, no local ref — so it was invisible to
// both. On 2026-08-05 that hid PRs #80 (sofa) and #81 (lamp) simultaneously:
// the block implied zero open PRs while two were in review, and the board's
// Owed line still read "sofa then lamp" as if unstarted. Re-briefing already-
// open work is the exact failure the workflow contract exists to prevent.
//
// Returns null when the query could NOT be made (gh absent, unauthenticated,
// network down) — deliberately distinct from [] meaning "measured, none open".
// Collapsing those two is what makes an unmeasured field read as a green one.
function openPrs() {
  const r = gates.run(
    'gh',
    ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,isDraft'],
    MAIN,
    30000,
  );
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out || '[]');
    return Array.isArray(j) ? j : null;
  } catch (e) {
    return null;
  }
}

// Map a branch to its owning window so the block reads in W-terms.
//
// CRITICAL: THIS GUESSES FROM THE SLUG, AND THE FALLTHROUGH USED TO BE `W1 app`.
// Measured 2026-08-14 (wave 25): fifteen worktrees rendered as "W1 app" in the
// STATE block, among them `feature+cropgate` and `feature+top-three` (W3's),
// `feature+funnel-harness` (W4's) and `feature+w2-pose`. None of their slugs
// contain a keyword, so all of them fell through to the default and hot.md —
// the first thing read at session start — attributed most of the fleet's work
// to one window.
//
// KEY: A DEFAULT IS AN ASSERTION. Returning `W1 app` for "no rule matched" is a
// tool answering a question it cannot answer, which is the same defect as a
// filtered gallery render emitting a blank frame and exit 0. An unlabelled row
// is read as unknown; a mislabelled one is read as fact.
//
// WARNING: The real fix is to derive ownership from the CLAIM — claim.cjs already
// records which window holds which paths, and that is authority rather than
// inference. Until then this reports its own ignorance instead of inventing an
// owner. Naming by display text is what orphans history.
const LANES = {
  W0: 'W0 orchestrator', W1: 'W1 app', W2: 'W2 backend',
  W3: 'W3 factory·characters', W4: 'W4 shipops', W5: 'W5 factory·furniture',
};

/**
 * Dispatch briefs are named `W<n>-<nn>-<slug>.md` and branches are
 * `feature+<slug>` — so W0's own filing names the window for most branches.
 * Built once; 567 briefs on 2026-08-27.
 */
let _briefIndex = null;
function briefIndex() {
  if (_briefIndex) return _briefIndex;
  _briefIndex = new Map();
  try {
    const dir = path.join(VAULT_ROOT, 'Projects', 'Cleaning', 'dispatch');
    for (const f of fs.readdirSync(dir)) {
      const m = /^(W\d)-\d+-(.+)\.md$/.exec(f);
      if (m && !_briefIndex.has(m[2])) _briefIndex.set(m[2], m[1]);
    }
  } catch (_) { /* no dispatch dir — fall through to the heuristic */ }
  return _briefIndex;
}

/**
 * Which window owns this branch.
 *
 * KEY: IT USED TO GUESS FROM THE BRANCH NAME ALONE — and had no W1 rule at all,
 * so every app branch fell through to `?? unattributed`: 26 of 32 rows on
 * 2026-08-27, including every branch with a live worktree. The `path` argument
 * was already being passed in and thrown away.
 *
 * Three sources, most authoritative first:
 *   1. `<worktree>/.orchestrator/window` — the window declared itself. 19 of 19
 *      worktrees carry one, and it is the same marker the claim lock and the
 *      return gate identify by, so this cannot disagree with them.
 *   2. the dispatch brief filename — W0 named the window when it filed the brief.
 *      Covers branches whose worktree is gone, and open PRs.
 *   3. the old branch-name heuristic, kept as a floor, now with the W1 rule.
 */
function labelFor(branch, wtPath) {
  const b = String(branch || '').toLowerCase();
  if (/^main$/.test(b)) return 'main';

  // 1. the worktree's own marker
  if (wtPath) {
    try {
      const raw = fs.readFileSync(path.join(wtPath, '.orchestrator', 'window'), 'utf8').trim();
      const w = raw.startsWith('{') ? String((JSON.parse(raw) || {}).window || '').trim() : raw;
      if (LANES[w]) return LANES[w];
    } catch (_) { /* no marker — next source */ }
  }

  // 2. the dispatch brief that named the branch
  const slug = String(branch || '').replace(/^(feature|fix|chore)\+/, '');
  const owner = briefIndex().get(slug);
  if (owner && LANES[owner]) return LANES[owner];

  // 3. a brief BODY that names this branch. Costs a scan of ~570 small files,
  //    so it runs only for the few branches sources 1-2 could not place —
  //    typically a branch whose worktree is gone and whose slug was reworded
  //    (`orientation-c-piece2` is named inside `W1-105-orientation-piece-2.md`).
  if (slug && slug.length > 6) {
    try {
      const dir = path.join(VAULT_ROOT, 'Projects', 'Cleaning', 'dispatch');
      for (const f of fs.readdirSync(dir)) {
        const m = /^(W\d)-\d+-/.exec(f);
        if (!m || !LANES[m[1]]) continue;
        if (fs.readFileSync(path.join(dir, f), 'utf8').includes(slug)) return LANES[m[1]];
      }
    } catch (_) { /* fall through */ }
  }

  // 4. heuristic floor
  if (/factory|furniture|restyle|bake|asset|atlas|portrait|ear|toilet|crescent|upscaler|alpha-class|watermark|blend/.test(b)) return 'W3 factory';
  if (/backend|rules|function|projection|jest|firestore|reminder|collection/.test(b)) return 'W2 backend';
  if (/shipops|store|ios|icon|privacy|screenshot|submit/.test(b)) return 'W4 shipops';
  if (/lighting|house|render|widget|screen|theme|contrast|tap|layout|coverage|landscap|coach|card/.test(b)) return 'W1 app';
  return '?? unattributed';
}

function sha(cwd, ref = "HEAD") {
  const r = gates.run('git', ['rev-parse', '--short', ref], cwd, 15000);
  return r.ok ? r.out.trim() : '?';
}

function describeTrack(t) {
  if (!fs.existsSync(t.cwd)) return `${t.key}: (worktree missing) — ${t.cwd}`;
  // A branch with no worktree: report its PR/ahead state, but not tree/push
  // state, which belong to a checkout it does not have.
  if (t.detachedBranch) {
    const b = t.detachedBranch;
    const tip = sha(t.cwd, b);
    const ahead = gates.run('git', ['rev-list', '--count', `origin/main..${b}`], t.cwd, 15000).out.trim();
    const pr = gates.run('gh', ['pr', 'list', '--head', b, '--state', 'open', '--json', 'number'], t.cwd, 30000);
    let prTxt = 'PR none';
    try { const j = JSON.parse(pr.out || '[]'); if (j.length) prTxt = `PR #${j[0].number} open`; } catch (e) { /* gh absent */ }
    return `${t.key}: \`${b}\` @ \`${tip}\` | no worktree | ${ahead} ahead of main | ${prTxt}`;
  }
  const branch = gates.branchOf(t.cwd) || '?';
  const tree = gates.treeClean(t.cwd);
  const push = gates.pushed(t.cwd);
  const pr = gates.openPr(t.cwd);
  // THE SILENT ZERO, fixed 2026-08-11. This read used to be
  //     floors[branch] ?? floors.default ?? 0
  // and the vault floor file contains a real `"default": 0` entry, so any
  // branch without its own floor resolved to 0 and printed `test floor 0` —
  // the exact failure 99b921c added a guard against ("a silent 0 reads as
  // 'perfect' when it means 'not measured'"). The `?? 0` never fired; the data
  // defeated it. Resolution now goes through the orchestrator resolver, which
  // treats absent, unparseable AND zero alike as UNKNOWN, and which reads the
  // app repo's floor file rather than the vault copy gates.cjs:26 is pinned to.
  const floor = orchFloors.resolve('test', ORCH_CFG, branch).text;
  const dirtyN = tree.pass ? 0 : tree.detail.split('\n').length - 1;

  return `${t.key}: \`${branch}\` @ \`${sha(t.cwd)}\` | tree ${tree.pass ? 'clean' : `DIRTY (${dirtyN})`}`
       + ` | ${push.pass ? 'pushed' : push.detail.replace('pushed: ', 'WARNING: ')}`
       + ` | ${pr.detail.replace('pr: ', 'PR ')} | test floor ${floor}`;
}

/**
 * The design floor — the counterpart to the test floor, added 2026-08-10 (#136).
 *
 * Read from the Cleaning repo's `test/design/design_baseline.json`, which the
 * design-lint tests measure themselves. Unlike the test floor this number may
 * only FALL: it counts raw colour literals, Material glyphs, bare Material
 * buttons, per-feature design files and sub-44pt tap targets.
 *
 * Read from `main`, not from a worktree, so the block reports the integration
 * tree rather than whatever a window happens to be holding.
 *
 * Absent or unreadable is reported as such rather than as 0 — a silent 0 would
 * read as "perfect" when it means "not measured", which is the exact failure
 * mode the test floor's own stale-2626 reading had.
 *
 * CRITICAL: THE SUM IS NOT COMPARABLE ACROSS A CHANGE IN COUNTER COUNT, and the line
 * now says how many counters it summed so a reader cannot miss it.
 *
 * 2026-08-20: `#577` added a SIXTH counter, `contrastFailures`, which starts at
 * whatever it first measures — 420. The sum went 647 → 1067 with no colour
 * changed and nothing made worse. Under the old line that reads as a 420-point
 * regression against a label that says "may fall, never rise", and W1 flagged
 * it before it could mislead anyone.
 *
 * Keeping the new counter INSIDE the sum is deliberate: excluding it would mean
 * the headline number does not cover legibility, which is the exact gap `#577`
 * was written to close. The fix is not to hide the jump but to make the
 * comparison self-invalidating — a reader who sees "across 6 counters" against
 * yesterday's "across 5" knows the two numbers are different measurements.
 */
function designFloor() {
  const r = gates.run('git', ['show', 'origin/main:test/design/design_baseline.json'], MAIN, 15000);
  if (!r.ok) return 'WARNING: UNKNOWN — no design_baseline.json on origin/main';
  try {
    const d = JSON.parse(r.out);
    const counts = Object.entries(d).filter(([k]) => !k.startsWith('_'));
    const total = counts.reduce((a, [, v]) => a + v, 0);
    const parts = counts.map(([k, v]) => `${k} ${v}`).join(' · ');
    return `${total} across ${counts.length} counters  (${parts})`
      + '  — each counter may fall, never rise; the SUM is NOT comparable to a run with a different counter count';
  } catch (e) {
    return 'WARNING: UNKNOWN — design_baseline.json did not parse';
  }
}

function build() {
  const lines = [];
  lines.push(BEGIN);
  lines.push('## STATE — generated by `/sync-state`, never hand-edit');
  lines.push('');
  lines.push('```');
  const windows = discoverWindows();
  if (!windows.length) lines.push('(no feature worktrees — every window is on main)');
  const covered = new Set();
  for (const t of windows.sort((a, b) => a.key.localeCompare(b.key))) {
    const b = t.detachedBranch || gates.branchOf(t.cwd);
    if (b) covered.add(b);
    lines.push(describeTrack(t));
  }

  // Open PRs, listed unconditionally — a PR with no local ref is still work in
  // review, and is the case that used to vanish entirely.
  const prs = openPrs();
  if (prs === null) {
    lines.push('open PRs: WARNING: UNKNOWN — `gh` query failed. Run `gh pr list --state open` before dispatching.');
  } else if (!prs.length) {
    lines.push('open PRs: none');
  } else {
    for (const p of prs.sort((a, b) => a.number - b.number)) {
      lines.push(
        `PR #${p.number}${p.isDraft ? ' (draft)' : ''} ${labelFor(p.headRefName, '')}: \`${p.headRefName}\``
        + `${covered.has(p.headRefName) ? '' : '  WARNING: no local ref/worktree'}`,
      );
    }
  }

  lines.push(`main:    @ ${sha(MAIN)}   (origin/main @ ${sha(MAIN, 'origin/main')})`);
  lines.push(`design floor: ${designFloor()}`);
  const wt = gates.run('git', ['worktree', 'list'], MAIN, 15000);
  lines.push(`worktrees: ${wt.ok ? wt.out.trim().split('\n').length : '?'}`);
  // Local and remote counted separately. Reporting only the local count read
  // as "1 live" on 2026-08-05 while origin carried 50 refs, 15 of them merged
  // and never deleted — the tidiest possible number over the untidiest tree.
  const br = gates.run('git', ['branch', '--format=%(refname:short)'], MAIN, 15000);
  const rbr = gates.run('git', ['branch', '-r', '--format=%(refname:short)'], MAIN, 15000);
  const nLocal = br.ok ? br.out.trim().split('\n').filter(Boolean).length : '?';
  // The `->` test is for `git branch -r`'s DEFAULT output ("origin/HEAD -> origin/main").
  // This call passes --format, where the symref renders as the bare remote name "origin"
  // with no arrow at all — so that filter never matched and HEAD was counted as a branch.
  // Found 2026-08-09: origin held only `main`, and the block still read "2 on origin".
  // A real remote branch is always "<remote>/<name>", so requiring a slash drops the symref.
  const nRemote = rbr.ok
    ? rbr.out.trim().split('\n').map((s) => s.trim())
        .filter((s) => s && !s.includes('->') && s.includes('/')).length
    : '?';
  const nArch = (gates.run('git', ['tag', '-l', 'archive/*'], MAIN, 15000).out || '')
    .trim().split('\n').filter(Boolean).length;
  lines.push(`branches:  ${nLocal} local · ${nRemote} on origin (archived: ${nArch})`);
  lines.push('```');
  lines.push('');
  lines.push('**Scope contract:** `Projects/Cleaning/SHIP.md` — nothing outside that list until a build is in TestFlight.');
  lines.push('**WIP cap:** one open dispatch brief per window (W1 app · W2 backend · W3 factory · W4 shipops). Merge order W2 → W4 → W1 → W3. Finish with `/land` or archive the branch.');
  lines.push(END);
  return lines.join('\n');
}

function main() {
  const block = build();
  if (process.argv.includes('--print') || !fs.existsSync(HOT)) {
    console.log(block);
    return;
  }
  const cur = fs.readFileSync(HOT, 'utf8');
  let next;
  if (cur.includes(BEGIN) && cur.includes(END)) {
    next = cur.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block);
  } else {
    // First run: insert after the H1, before any narrative.
    const m = cur.match(/^(#[^\n]*\n)/);
    next = m ? cur.replace(m[1], `${m[1]}\n${block}\n`) : `${block}\n\n${cur}`;
  }
  if (next !== cur) {
    fs.writeFileSync(HOT, next);
    console.log(`[sync-state] wiki/hot.md STATE block updated`);
  } else {
    console.log('[sync-state] no change');
  }
  console.log(block);
}

if (require.main === module) main();
module.exports = { build };

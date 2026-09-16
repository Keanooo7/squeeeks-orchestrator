#!/usr/bin/env node
'use strict';

/**
 * return-gate.cjs — refuse to let a window STOP after landing without reporting.
 *
 * 🔑 THIS CLOSES THE SYSTEM'S ONE STRUCTURAL ASYMMETRY.
 *
 * Every step of DISPATCH leaves an artefact and has a guard: the claim
 * (claim.cjs), the packet (packet.cjs --verify), the brief (lint-brief.cjs),
 * and even the message-that-left-no-artefact (dispatch.cjs writes
 * claims/_pending/<id>.json and tick.cjs surfaces it).
 *
 * The RETURN direction had none. return.cjs grades a return that already
 * exists; tick.cjs surfaces one already written; nothing made writing one a
 * precondition of anything. ops-orchestration-system.md:437-448 diagnosed this
 * exact asymmetry for dispatch and never applied it to return.
 *
 * ⚠️ WHY A `Stop` HOOK AND NOT `SessionEnd`.
 * `SessionEnd` cannot block — helpers/hook-handler.cjs:289-290 says so in its
 * own comment, and its [UNLANDED] warning has been advisory ever since. `Stop`
 * can: {"decision":"block","reason":…} on stdout returns the reason to the
 * model and the turn continues.
 *
 * 🔴 AND WHY IT GATES ON A `landed` MARKER RATHER THAN ON "HOLDS A CLAIM".
 * A `Stop` hook fires when Claude finishes RESPONDING — every turn, not at the
 * end of a session. The first version of this file blocked whenever a claim was
 * held with no matching return. That would have refused every turn of every
 * window for the whole life of a brief: four wedged windows, each looping on a
 * demand to report work not yet done. Caught in testing, before it was wired.
 *
 * The gate needs the signal for FINISHED, not BUSY. Both obvious candidates
 * fail here:
 *   · `git branch --merged origin/main` — this repo squash-merges, which makes
 *     a landed branch unreachable from its own tip (land/SKILL.md:172-185).
 *   · a released claim — /land releases as its LAST step (land/SKILL.md:465-468),
 *     by which point the window is already gone.
 * /land writes the outbox return at :432 and releases at :465, so a compliant
 * window has already returned before either signal exists.
 *
 * ✅ So /land drops `.orchestrator/landed` naming the brief, and that is the
 * trigger. A compliant window never sees a block; one that merges a PR and
 * walks away hits it immediately.
 *
 * ⚠️ THE LIMIT, STATED PLAINLY: this catches "landed and did not report". It
 * cannot catch "closed the terminal mid-brief" — no hook can block that. That
 * case belongs to W0's tick, not here.
 *
 * 🔴 STDOUT IS THE PROTOCOL. Standalone rather than a hook-handler.cjs
 * subcommand precisely because that file prints `[OK] …` and `[INTELLIGENCE] …`
 * on other paths; one stray line makes the Stop hook's JSON unparseable.
 *
 * FAIL-OPEN, DELIBERATELY. Every unexpected condition — no marker, no adapter,
 * malformed JSON — allows the stop. A gate that fails closed on its own bug
 * strands a window with no way out, and that is worse than a missed return: a
 * missed return is recoverable by the tick, a wedged session is not.
 *
 * 📌 2026-08-27 — MALFORMED IS NO LONGER SILENT, BUT IT STILL ALLOWS.
 * `readJson` swallowed a parse error and returned null, and the check below
 * read null as "nothing landed". So a marker that EXISTS but is freeform prose
 * was indistinguishable from no marker at all, and this gate was unreachable
 * for precisely the windows it was built to catch — all 8 markers on disk fail
 * `JSON.parse`. `readLanded` now separates ABSENT from MALFORMED and records
 * the malformed case to `state/malformed-landed.log`.
 * 🔴 It still allows. Blocking on a malformed marker today would brick eight
 * live worktrees at once. Flipping to fail-closed is a SEPARATE, LATER step,
 * gated on that log going quiet — do not bring it forward.
 *
 * Usage:  return-gate.cjs [--cwd <dir>] [--explain]
 *   --explain  human verdict on stderr instead of hook JSON; exit 1 when it
 *              WOULD block. For testing the gate without a hook.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ORCH = __dirname;
// Verified silent on require (it writes nothing at module scope) — which is a
// precondition here, not a detail: STDOUT IS THE PROTOCOL and one stray line
// makes this hook's JSON unparseable.
const gates = require(path.join(ORCH, '..', 'helpers', 'gates.cjs'));
const DEFAULT_PROJECT = process.env.ORCH_PROJECT || 'cleaning';

const argv = process.argv.slice(2);
const EXPLAIN = argv.includes('--explain');
// 📌 LOG-ONLY ROLLOUT (2026-08-27). The gate is being installed in <repo>/.claude
// for the first time — until now it was wired only in the vault, where no window
// ever works, so it has never fired in anger. Every would-be block is recorded
// to state/gate-blocks.log and ALLOWED. Turn blocking on by removing
// ORCH_GATE_LOGONLY from the hook command, once that log shows the blocks are
// the ones you meant.
const LOG_ONLY = argv.includes('--log-only') || process.env.ORCH_GATE_LOGONLY === '1';
const cwdFlag = argv.indexOf('--cwd');
const CWD = cwdFlag >= 0 && argv[cwdFlag + 1] ? argv[cwdFlag + 1] : process.cwd();

/** Allow the stop. Silence is consent for a Stop hook. */
function allow(why) {
  if (EXPLAIN) process.stderr.write(`ALLOW — ${why}\n`);
  process.exit(0);
}

/** Refuse the stop, and say exactly what to do about it. */
function block(reason) {
  if (LOG_ONLY) {
    try {
      const dir = path.join(ORCH, 'state');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'gate-blocks.log'),
        JSON.stringify({ at: new Date().toISOString(), cwd: CWD, wouldBlock: reason.split('\n')[0] }) + '\n');
    } catch (_) { /* logging is never load-bearing */ }
    if (EXPLAIN) process.stderr.write(`WOULD BLOCK (log-only)\n${reason}\n`);
    process.exit(0);
  }
  if (EXPLAIN) {
    process.stderr.write(`BLOCK\n${reason}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/**
 * Read the landed marker, distinguishing ABSENT from MALFORMED.
 * `readJson` above cannot: both come back as null. That conflation is the bug.
 * Returns {state:'absent'} | {state:'ok', value} | {state:'malformed', error, raw}.
 */
function readLanded(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return { state: 'absent' }; }
  try { return { state: 'ok', value: JSON.parse(raw) }; }
  catch (e) { return { state: 'malformed', error: e.message.split('\n')[0], raw }; }
}

/**
 * Append one line per malformed marker, so the drain has something to count down.
 * ⚠️ Never throws. A gate that dies because its own logging failed is strictly
 * worse than the missed return it was trying to record.
 */
function logMalformed(file, win, error) {
  try {
    const dir = path.join(ORCH, 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'malformed-landed.log'),
      JSON.stringify({ at: new Date().toISOString(), window: win, marker: file, error }) + '\n'
    );
  } catch (_) { /* logging is never load-bearing */ }
}

// ── 1. Identity ────────────────────────────────────────────────────────────
// Identified the same way the pre-commit lock does it (hooks/pre-commit-claim:
// 68-83): ORCH_WINDOW, else a .orchestrator/window marker searched UPWARD from
// cwd so it is found from inside a worktree subdirectory. No marker means this
// is not a window session — W0's own, or a scratch one — and the gate has no
// opinion about it.
function findOrchDir(startDir) {
  if (process.env.ORCH_WINDOW) {
    return { window: process.env.ORCH_WINDOW.trim(), dir: path.join(path.resolve(startDir), '.orchestrator') };
  }
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    const orchDir = path.join(dir, '.orchestrator');
    const marker = path.join(orchDir, 'window');
    if (fs.existsSync(marker)) {
      const raw = fs.readFileSync(marker, 'utf8').trim();
      // Bare token in every live worktree, but the lock accepts JSON too, so
      // accept both rather than diverge from it.
      if (raw.startsWith('{')) {
        const j = readJson(marker);
        if (j && j.window) return { window: String(j.window).trim(), dir: orchDir };
      }
      return { window: raw, dir: orchDir };
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const found = findOrchDir(CWD);
if (!found) allow('no .orchestrator/window marker — not a window session');
const { window, dir: orchDir } = found;
if (!/^W[1-5]$/.test(window)) allow(`window marker "${window}" is not W1-W5`);

// ── 2. Config ──────────────────────────────────────────────────────────────
const cfg = readJson(path.join(ORCH, 'projects', `${DEFAULT_PROJECT}.json`));
if (!cfg || !cfg.vault || !cfg.repo) allow('no usable adapter — cannot resolve the outbox');

// ── 3. Has this window FINISHED something? ─────────────────────────────────
// 🔑 THE WHOLE DESIGN. Silent while work is in progress; speaks only once
// /land has written the marker, because only then is "no return" a break-away
// rather than a window mid-brief.
const landedFile = path.join(orchDir, 'landed');
const marker = readLanded(landedFile);

// 🔴 MALFORMED IS NOT ABSENT — AND IT NO LONGER PASSES.
// Staged deliberately: this was log-and-allow from the moment the split landed
// until the 8 freeform markers on disk had been drained and the log stayed
// empty. Flipping first would have bricked eight live worktrees at once. The
// log is still written, because a marker that cannot be read is worth counting
// whichever way the gate then decides.
if (marker.state === 'malformed') {
  logMalformed(landedFile, window, marker.error);
  block(
    `🔴 STOP REFUSED — ${window}'s landed marker exists but is not JSON.` +
    `\n  ${landedFile}` +
    `\n  parse error: ${marker.error}` +
    `\n\n  It was almost certainly hand-written. /land §5c writes it for you, from` +
    `\n  inside your worktree, the moment the merge succeeds.` +
    `\n\n  A marker that does not parse used to read as NO marker at all — which is` +
    `\n  why this gate stayed silent for exactly the windows it exists to catch.` +
    `\n  Fix the file or delete it, then stop again.`
  );
}

if (marker.state === 'absent') {
  allow(`${window} has landed nothing since its last return — still working`);
}

const landed = marker.value;
if (!landed || !landed.brief) allow('landed marker names no brief');
const brief = landed.brief;

// ── 4. Does the outbox carry THIS brief's return? ──────────────────────────
// 🔑 The brief match is the whole check. An outbox holds exactly ONE return
// (D1379), and between ack and land it still shows the PREVIOUS brief's — so
// "a return exists" is not the question. "A return for the brief you just
// landed exists" is.
const outbox = path.join(cfg.repo, (cfg.outboxDir || '.orchestrator/outbox'), `${window}.md`);
const HOWTO =
  `\n  Write it to: ${outbox}` +
  `\n  FIRST LINE must be exactly:  status: RETURNED    (or QUESTION / BLOCKED)` +
  `\n  second line:  brief: ${brief}` +
  `\n\n  tick.cjs parses plain \`key: value\` lines from the top. A block opening with` +
  `\n  "# ${window} RETURN" or "**status:**" is filed UNPARSED and W0 goes blind to it.` +
  `\n\n  Then clear the marker:  rm ${path.join(orchDir, 'landed')}`;

if (!fs.existsSync(outbox)) {
  block(
    `🔴 STOP REFUSED — ${window} landed ${brief} and filed no return.` + HOWTO
  );
}

const raw = fs.readFileSync(outbox, 'utf8');
// The same parse tick.cjs uses: plain `key: value` from the top of the file.
const head = raw.split('\n').slice(0, 40);
const field = (key) => {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'i');
  for (const line of head) {
    const m = line.match(re);
    if (m) return m[1].trim();
  }
  return null;
};

const status = field('status');
const briefInBox = field('brief');

if (!status) {
  block(
    `🔴 STOP REFUSED — ${window}'s outbox has no \`status:\` line, so tick.cjs files it as` +
    ` UNPARSED and W0's file layer cannot see it at all.` + HOWTO
  );
}

// The brief field is often "W2-129 · title" or a path, so match by containment.
if (!briefInBox || !briefInBox.includes(brief)) {
  block(
    `🔴 STOP REFUSED — ${window} landed ${brief}, but the outbox reports` +
    ` \`brief: ${briefInBox || '(none)'}\`.` +
    `\n\n  That is a previous brief's return. An outbox holds exactly one and it lags` +
    `\n  between ack and land by design — so a stale one reads exactly like a filed one.` +
    HOWTO
  );
}

// ── 5. Shape ───────────────────────────────────────────────────────────────
// return.cjs is the existing grader and already owns the shape rules, including
// the `-N` failure-tail detector it calls "the single highest-value check in
// the file". Reuse it rather than restating it — a second copy of a rule is
// how the two floor files drifted apart in the first place.
try {
  execFileSync(process.execPath, [path.join(ORCH, 'return.cjs'), outbox], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  const detail = [e.stdout, e.stderr].filter(Boolean).map(String).join('\n').trim();
  block(
    `🔴 STOP REFUSED — ${window}'s return for ${brief} exists but fails return.cjs.` +
    `\n\n${detail}` +
    `\n\n  Fix the block at ${outbox}, then stop again.` +
    `\n  If a check does not apply — no gates ran because nothing was built — SAY THAT` +
    `\n  explicitly in the block. return.cjs accepts "nothing to record"; it does not` +
    `\n  accept silence, because silence reads identically to a window that measured nothing.`
  );
}

// ── 6. Did a DART landing leave the floor banked on a sha that survives? ───
//
// 🔑 THIS IS THE ONLY MOMENT THE DEBT IS BOTH INCURRED AND COLLECTIBLE.
// `record-floor.cjs` stamps `commit_is_pre_squash: true` whenever a floor is
// measured on a feature branch — a note meaning *this commit stops existing the
// moment you squash-merge; come back and re-record*. It has recorded that debt
// honestly every time and NOTHING HAS EVER COLLECTED IT. That, not a missing
// recorder, is why the Dart floor has been wrong three times.
//
// A window squash-merges, then stops. At the moment this hook fires the squash
// commit exists on origin/main — so the integrated tip is available to measure.
// Earlier the debt cannot be paid; later nobody is looking.
//
// 🔴 FAIL-OPEN AT EVERY UNKNOWN, like every other branch in this file. A gate
// that fails closed on its own bug strands a window with no way out, and a
// wedged session is worse than a missed return: the tick recovers a missed
// return, nothing recovers a wedge.
const repo = cfg.repo;
const sha = landed.sha ? String(landed.sha).trim() : null;

if (!sha) {
  allow(`${window} filed a passing return for ${brief} — marker names no sha, floor provenance not checkable`);
}

// Which files did the squash actually carry? `--format=` strips the header, so
// what remains is exactly this landing's paths.
const shown = gates.run('git', ['show', '--name-only', '--format=', sha], repo, 30000);
if (!shown.ok) {
  allow(`${window} filed a passing return for ${brief} — ${sha} is not resolvable in ${repo}`);
}
const dartFiles = shown.out.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.dart'));
if (dartFiles.length === 0) {
  // /land §3 already says this in its own words: a brief that touched no Dart
  // has no Flutter floor to record, because the count is unchanged BY
  // CONSTRUCTION. Demanding a floor here would make the gate cry wolf on every
  // art and backend landing, and a gate that cries wolf gets relaxed rather
  // than debugged.
  allow(`${window} filed a passing return for ${brief} — ${sha} touched 0 .dart files, so no floor is owed`);
}

// origin/main must be CURRENT before anything is called reachable from it. A
// remote-tracking ref only moves on fetch, so skipping this reads whatever this
// tree last saw — and a stale ref answers "unreachable" about a sha that landed
// minutes ago, which is a FALSE BLOCK in the one direction that wedges a window.
const fetched = gates.run('git', ['fetch', '--quiet', 'origin', 'main'], repo, 10000);
if (!fetched.ok) {
  allow(`${window} filed a passing return for ${brief} — \`git fetch origin main\` failed, `
      + `so reachability cannot be judged and this gate will not guess`);
}

const anchor = gates.floorAnchor(repo, 'main');
if (!anchor.readable || !anchor.present) {
  allow(`${window} filed a passing return for ${brief} — no readable 'main' floor entry to judge`);
}
if (anchor.banked) {
  allow(`${window} filed a passing return for ${brief} — floor ${anchor.count} banked at ${anchor.commit}`);
}

// THE ESCAPE THAT PREVENTS A WEDGE, AND WHY IT IS NARROW.
// Collecting the debt means landing a floor file, which is a tracked file and
// therefore a second PR — one this window cannot merge itself. So a window that
// has DONE its part and is waiting on W0 must be allowed to stop, or it loops
// forever on a demand only someone else can satisfy.
//
// 🔴 BUT `treeAnchor.banked` ALONE IS NOT A BAR — IT IS THE BASE STATE.
// A branch cut from main carries main's committed floor entry, whose sha is of
// course reachable. Allowing on that would fire for every window that never
// touched the floor at all, and the refusal would never once execute. The
// escape therefore requires a DIFFERENT and not-lower anchor: evidence of a
// re-record, not evidence of an inheritance.
const treeRoot = path.dirname(orchDir);
let treeAnchor = null;
if (fs.existsSync(path.join(treeRoot, '.claude', 'test-floor.json'))) {
  treeAnchor = gates.floorAnchor(treeRoot, 'main', { from: 'tree' });
  if (treeAnchor.banked
      && treeAnchor.commit !== anchor.commit
      && (treeAnchor.count || 0) >= (anchor.count || 0)) {
    allow(`${window} filed a passing return for ${brief} — floor re-recorded in-tree at `
        + `${treeAnchor.commit} (${treeAnchor.count}), awaiting a merge W0 owns`);
  }
}

block(
  `🔴 STOP REFUSED — ${window} landed ${brief}, which changed ${dartFiles.length} Dart file(s),` +
  `\n  and the Dart floor on origin/main is banked on a commit that does not survive.` +
  `\n\n  ${anchor.why}` +
  `\n  floor: ${anchor.count} · commit: ${anchor.commit || '(none)'} · measured_at: ${anchor.measured_at || '(unrecorded)'}` +
  (treeAnchor && treeAnchor.present
    ? `\n  your tree: ${treeAnchor.count} @ ${treeAnchor.commit || '(none)'} — ${treeAnchor.banked ? 'reachable, but the same entry main already has' : 'also not banked'}`
    : '') +
  `\n\n  🔑 THIS IS THE ONLY MOMENT THE DEBT IS COLLECTIBLE. ${sha} exists on origin/main` +
  `\n  right now, so the integrated tip can be measured. record-floor.cjs has stamped` +
  `\n  this debt honestly every time and nothing has ever collected it — which is why` +
  `\n  the floor has been wrong three times.` +
  `\n\n  COLLECT IT — /land §5b, on the integrated tip, which is now one command:` +
  `\n    git -C ${repo} fetch origin` +
  `\n    git worktree add --detach <tip-dir> origin/main && cd <tip-dir>` +
  `\n    node ${path.join(ORCH, 'record-floor.cjs')} --measure --branch main` +
  `\n\n  --measure RUNS the suite and banks what it says, so the number is never` +
  `\n  retyped and the sha it stamps is HEAD of the tree it actually measured.` +
  `\n  /land §5b's own warning — "origin/main IS NOT a synonym for the tree I` +
  `\n  measured" — is what that closes.` +
  `\n\n  ⚠️ Only bank a count you MEASURED. If you cannot run the suite now, say so` +
  `\n  explicitly in the return block and leave the flag set: a re-record with a` +
  `\n  copied count trades a stale sha for a fabricated measurement, which is worse.` +
  `\n\n  Then commit ${'.claude/test-floor.json'}, open the floor PR, and stop again.`
);

allow(`${window} filed a passing return for ${brief}`);

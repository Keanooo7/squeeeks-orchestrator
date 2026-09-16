#!/usr/bin/env node
/**
 * dispatch.cjs — prepare a brief for dispatch, and make the SEND impossible to
 * forget.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-12 W0 twice wrote a brief, took the claim, stamped the packet and
 * ran the linter — and never sent it.
 *
 *   W2-16  claimed 12:14Z, dispatched 12:30Z.  W2 was idle the whole time and
 *          answered the brief's disproof from a STATUS CHECK. Its diagnosis:
 *          "A LIVE CLAIM IS NOT EVIDENCE A WINDOW IS WORKING — it is evidence
 *          YOU DISPATCHED."
 *   W1-54  referenced in three messages, never stamped, never sent. W1 declined
 *          to start it: "Starting a brief I have not been given is how a window
 *          ends up building the thing it imagined rather than the thing that
 *          was specified."
 *
 * 🔑 THE MECHANISM. Every other step leaves an artefact — a claim file, a
 * PACKET block, a linter exit code. THE SEND LEAVES NOTHING. So a brief that
 * was 3/4 dispatched is indistinguishable on disk from one that was 4/4, and
 * every check W0 runs reports success.
 *
 * This tool does the three mechanical steps AND writes a PENDING marker that
 * only clears when the send is confirmed. tick.cjs surfaces pending markers, so
 * an undispatched brief becomes as loud as an unreturned one.
 *
 * It deliberately does NOT send the message. Delivery is W0's SendMessage tool
 * and this is a CLI. Automating the send here would replace a visible omission
 * with an invisible one — the failure mode is not that the send is hard, it is
 * that its absence is silent.
 *
 * USAGE
 *   dispatch.cjs prepare <brief-path> --window W2 [--paths '<globs>'] [--budget feature] [--hours 8]
 *   dispatch.cjs sent <brief-id>          mark delivered — run AFTER SendMessage returns
 *   dispatch.cjs pending                  list briefs prepared but never sent
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ORCH = __dirname;
const DEFAULT_PROJECT = process.env.ORCH_PROJECT || 'cleaning';

function loadConfig(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ORCH, 'projects', `${name}.json`), 'utf8'));
  } catch {
    process.stderr.write(`dispatch: no usable adapter for '${name}'\n`);
    process.exit(2);
  }
}

/**
 * ⚠️ WARN — DO NOT REFUSE — when the claim about to be released never filed a return.
 *
 * 🔴 WHY THE RELEASE BELOW STAYS BARE. `claim.cjs:406-407` keeps `--brief`
 * optional precisely so W0 retains an administrative release, and this is that
 * release: a rotation from the outgoing brief to the incoming one. Passing
 * `--brief <the new id>` here would hit the mismatch guard at `claim.cjs:409`
 * and REFUSE **every** dispatch — the window still holds the OLD brief at this
 * point — after which the re-claim fails on the claim file that survived.
 * Traced and rejected 2026-08-27; do not "fix" it that way again.
 *
 * ✅ SO THIS ONLY OBSERVES. The real hazard is rotating a lane whose previous
 * brief was never reported, which erases the only record that a return was
 * owed. Warn, log, release anyway — the same logging-only discipline
 * `return-gate.cjs` uses for a malformed marker, and for the same reason: a
 * refusal here can stop W0 dispatching at all, and a wedged orchestrator is
 * worse than a missed return.
 */
function warnUnreturnedClaim(cfg, window) {
  try {
    const cf = path.join(cfg.vault, (cfg.claim && cfg.claim.dir) || '.claude/claims', `${window}.json`);
    if (!fs.existsSync(cf)) return;
    let held = null;
    try { held = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch { return; }
    if (!held || !held.brief) return;

    // The same containment match return-gate.cjs:187 uses — an outbox `brief:`
    // is often "W2-129 · title", not a bare id.
    const outbox = path.join(cfg.repo, cfg.outboxDir || '.orchestrator/outbox', `${window}.md`);
    let filed = null;
    try {
      for (const line of fs.readFileSync(outbox, 'utf8').split('\n').slice(0, 40)) {
        const m = line.match(/^brief:\s*(.+)$/i);
        if (m) { filed = m[1].trim(); break; }
      }
    } catch { /* no outbox at all reads the same as no return */ }

    if (filed && filed.includes(held.brief)) return;

    process.stdout.write(
      `⚠️  ${window} holds '${held.brief}' but its outbox reports 'brief: ${filed || '(none)'}'.\n`
      + `    Rotating the claim now discards the only record that a return was owed.\n`
      + `    Releasing anyway — this is W0's administrative release.\n`
      + `    Outbox: ${outbox}\n\n`);

    const dir = path.join(ORCH, 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'unreturned-rotations.log'),
      JSON.stringify({ at: new Date().toISOString(), window, held: held.brief, outboxBrief: filed }) + '\n');
  } catch { /* observation is never load-bearing */ }
}

function pendingDir(cfg) {
  const d = path.join(cfg.vault, '.claude', 'claims', '_pending');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// 🔴 `base` added 2026-08-20. `prepare` REGENERATES the packet, so without a
// passthrough it silently overwrote a cross-branch base with origin/main —
// undoing the fix W1 asked for, one layer up from where it was applied. A brief
// targeting another window's branch would have been prepared pointing at main,
// which is the exact failure W1 described: "a window trusting the packet over
// the body would have rebuilt W1-144's failure exactly."
const KNOWN = new Set(['window', 'paths', 'budget', 'hours', 'project', 'base', 'no-premise-check']);

const BOOLEAN = new Set(['no-premise-check']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!KNOWN.has(k)) {
        process.stderr.write(`dispatch: unknown flag '--${k}'\n`
          + `          known: ${[...KNOWN].map((x) => `--${x}`).join(' ')}\n`);
        process.exit(2);
      }
      // Boolean flags take no value — consuming the next token would silently
      // swallow a positional (the brief path) and the failure would look like a
      // missing argument rather than a mis-parsed flag.
      if (BOOLEAN.has(k)) { out[k] = true; continue; }
      out[k] = argv[++i];
      continue;
    }
    out._.push(a);
  }
  return out;
}

function run(script, args) {
  try {
    return { ok: true, out: execFileSync('node', [path.join(ORCH, script), ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status };
  }
}

/** The brief id — W2-16 — from the filename. The registry key for everything else. */
function briefIdOf(file) {
  const m = path.basename(file).match(/^(W[0-5]-\d+)/);
  if (!m) {
    process.stderr.write(`dispatch: '${path.basename(file)}' does not start with a brief id (W2-16-...)\n`);
    process.exit(2);
  }
  return m[1];
}

function cmdPrepare(cfg, args) {
  const file = args._[1];
  if (!file || !fs.existsSync(file)) {
    process.stderr.write('dispatch: prepare needs an existing brief path\n');
    process.exit(2);
  }
  const window = args.window;
  if (!window) { process.stderr.write('dispatch: --window is required\n'); process.exit(2); }
  const id = briefIdOf(file);

  // 0. PREMISE CHECK — before the claim, because a false premise must not take a
  //    lock. Five briefs were dispatched on false premises on 2026-08-24/25 and
  //    every one was caught by the WINDOW, after it had acked and cut a worktree.
  //    Each was a one-command check. `verify before asserting` already existed as
  //    a rule; nothing mechanical stood behind it, which is the same defect the
  //    codebase diagnoses in its own `SYNC:` comments one layer down.
  //    🔴 --no-premise-check is the deliberate, greppable escape hatch.
  {
    // 🔴 FETCH FIRST — 81 of the 86 premise rows in the corpus (94%) query
    // `origin/main`, and until 2026-08-27 the only fetch in this pipeline lived
    // in `packet.cjs` at step 2, i.e. AFTER this check. So the gate that exists
    // to catch a false premise was itself reading a stale ref: a brief whose
    // premise had just been made false by a merge still passed, because this
    // machine had not seen the merge. A premise is only true at its timestamp —
    // that timestamp has to be after the fetch, not before it.
    try {
      require('child_process').execFileSync('git', ['fetch', '--quiet', 'origin'],
        { cwd: cfg.repo, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
    } catch (e) {
      // Offline is not a reason to refuse a dispatch, but it IS a reason to say
      // so — otherwise a green premise check is indistinguishable from a stale one.
      process.stdout.write('⚠️  git fetch failed — premise rows querying `origin/main` are being\n'
        + '   evaluated against whatever this machine last saw. Treat a PASS as provisional.\n\n');
    }
    const pr = run('premise.cjs', [file]);
    if (pr.code === 3) {
      if (!args['no-premise-check']) {
        process.stdout.write(
          '🔴 NO PREMISE CHECK IN THIS BRIEF — refusing to prepare.\n\n'
          + '   Add a ```premise block declaring the observations the brief depends on:\n\n'
          + '     ```premise\n'
          + '     expect  <literal substring>  ::  <command that should print it>\n'
          + '     absent  <literal substring>  ::  <command that should NOT print it>\n'
          + '     ```\n\n'
          + '   It runs here, before the claim. A brief whose premise is already false\n'
          + '   costs a refused prepare instead of a window\'s ack, worktree and reading.\n'
          + '   Deliberate opt-out: --no-premise-check (greppable, and say why in the brief).\n');
        process.exit(1);
      }
      process.stdout.write('⚠️  premise check SKIPPED by --no-premise-check\n\n');
    } else if (!pr.ok) {
      process.stdout.write(`${pr.out}\n❌ PREMISE FAILED — no claim taken, nothing prepared.\n`);
      process.exit(1);
    } else {
      process.stdout.write(`${pr.out}\n`);
    }
  }

  // 1. claim — only if paths were given; otherwise assume the caller already holds one
  if (args.paths) {
    warnUnreturnedClaim(cfg, window);
    const r = run('claim.cjs', ['release', window]);
    const c = run('claim.cjs', ['claim', window, '--brief', id, '--paths', args.paths,
      ...(args.hours ? ['--hours', args.hours] : [])]);
    if (!c.ok) { process.stdout.write(`❌ CLAIM FAILED\n${c.out}\n`); process.exit(1); }
    void r;
  }

  // 2. stamp — update in place if a PACKET exists, else emit for insertion
  const hasPacket = fs.readFileSync(file, 'utf8').includes('PACKET:BEGIN');
  const p = run('packet.cjs', [file, '--window', window,
    ...(args.base ? ['--base', args.base] : []),
    ...(args.budget ? ['--budget', args.budget] : []), ...(hasPacket ? ['--update'] : [])]);
  if (!p.ok) { process.stdout.write(`❌ PACKET FAILED\n${p.out}\n`); process.exit(1); }
  if (!hasPacket) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    fs.writeFileSync(file, [lines[0], '', p.out.trim(), ...lines.slice(1)].join('\n'));
  }

  // 3. lint — a brief that fails the contract must not be announced as ready
  const l = run('lint-brief.cjs', [file]);
  if (!l.ok) { process.stdout.write(`❌ LINT FAILED — not marked pending\n${l.out}\n`); process.exit(1); }

  // 4. the marker. This is the whole point: the send has no artefact, so we
  //    manufacture one that persists until the send is CONFIRMED.
  fs.writeFileSync(path.join(pendingDir(cfg), `${id}.json`),
    `${JSON.stringify({ brief: id, window, file, prepared_at: new Date().toISOString() }, null, 2)}\n`);

  process.stdout.write(
    `${l.out.trim()}\n\n`
    + `🔴 ${id} IS PREPARED AND **NOT SENT**.\n`
    + `   Nothing has reached ${window}. A live claim is not evidence a window is working.\n\n`
    + `   1. SendMessage to ${window}:  DISPATCH  ${file}\n`
    + `   2. Then confirm:  node .claude/orchestrator/dispatch.cjs sent ${id}\n\n`
    + `   Until step 2, tick.cjs will report ${id} as UNDISPATCHED.\n`,
  );
}

function cmdSent(cfg, args) {
  const id = args._[1];
  if (!id) { process.stderr.write('dispatch: sent needs a brief id\n'); process.exit(2); }
  const f = path.join(pendingDir(cfg), `${id}.json`);
  if (!fs.existsSync(f)) {
    process.stderr.write(`dispatch: ${id} is not pending — nothing to confirm.\n`
      + '          Either it was never prepared, or it was already marked sent.\n');
    process.exit(2);
  }
  fs.unlinkSync(f);
  process.stdout.write(`✅ ${id} marked delivered\n`);
}

function cmdPending(cfg) {
  const d = pendingDir(cfg);
  const files = fs.readdirSync(d).filter((f) => f.endsWith('.json'));
  if (!files.length) { process.stdout.write('no undispatched briefs\n'); return; }
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
    const mins = Math.round((Date.now() - Date.parse(r.prepared_at)) / 60000);
    process.stdout.write(`🔴 UNDISPATCHED  ${r.brief}  ${r.window}  prepared ${mins}m ago  ${r.file}\n`);
  }
  process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.project || DEFAULT_PROJECT);
  switch (args._[0]) {
    case 'prepare': return cmdPrepare(cfg, args);
    case 'sent': return cmdSent(cfg, args);
    case 'pending': return cmdPending(cfg);
    default:
      process.stderr.write('usage: dispatch.cjs prepare <brief> --window W2 [--paths …] [--budget …]\n'
        + '       dispatch.cjs sent <brief-id>\n'
        + '       dispatch.cjs pending\n');
      process.exit(2);
  }
}

if (require.main === module) main();
module.exports = { pendingDir, briefIdOf };

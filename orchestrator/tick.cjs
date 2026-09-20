#!/usr/bin/env node
/**
 * tick.cjs — W0's status read. Eight small reads: four outbox headers and four
 * claim files.
 *
 * THE POINT: the file layer must be sufficient on its own. Messages are a
 * doorbell, not the record — so a dropped, queued or duplicated message costs
 * latency and nothing else. If this tick can see everything W0 needs, the
 * control channel degrades gracefully all the way down to the human pasting a
 * one-line pointer.
 *
 * An outbox's first three lines are its header and are all this reads by
 * default:
 *     status: IDLE | WORKING | RETURNED | BLOCKED | QUESTION
 *     brief:  W1-41 | none
 *     updated: <iso8601> | never
 *
 * USAGE
 *   tick.cjs             one-screen status
 *   tick.cjs --full      also print each outbox body
 *   tick.cjs --json      machine-readable
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ORCH = __dirname;
const claimLib = require(path.join(ORCH, 'claim.cjs'));

// UNPARSED is in here deliberately. An outbox this tool cannot read is not a
// quiet window — it is a window whose state W0 does not know, and the whole
// point of the file layer is that not-knowing must be VISIBLE. Fail loud.
const NEEDS_W0 = new Set(['RETURNED', 'BLOCKED', 'QUESTION', 'UNPARSED']);

const VERBS = ['RETURNED', 'BLOCKED', 'QUESTION', 'CHECKPOINT', 'WORKING', 'IDLE'];

function readHeader(file) {
  if (!fs.existsSync(file)) return { status: 'ABSENT', brief: null, updated: null, missing: true };
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').slice(0, 6);
  const get = (k) => {
    const l = lines.find((x) => x.toLowerCase().startsWith(`${k}:`));
    return l ? l.slice(l.indexOf(':') + 1).trim() : null;
  };

  // TWO readers, because the one below was fiction for the whole program.
  //
  // 2026-08-11: this function only ever looked for `status:` / `brief:` /
  // `updated:` key lines. NOT ONE WINDOW HAS EVER WRITTEN THEM. All four write a
  // human markdown title — `# RETURNED · W1-47 · The bounded ground` — so `get`
  // returned null, status fell to 'UNKNOWN', UNKNOWN is not in NEEDS_W0, and the
  // tick printed "nothing waiting on W0" over a RETURNED brief that sat unread
  // for an hour.
  //
  // The contract existed only in this file's own docstring. That is the whole
  // lesson: a format nobody was told about is not a protocol, it is an
  // assumption — and this one degraded to a REASSURING value, which is why it
  // survived a full program of waves. The design's load-bearing claim was "the
  // tick alone is sufficient, so a dropped message costs latency and nothing
  // else." It was never sufficient; W0 was running on the doorbell and could not
  // have known.
  //
  // So: read what windows ACTUALLY write, and treat an unreadable outbox as
  // something needing W0 rather than something that is fine.
  const title = raw.split('\n').find((l) => l.trim().startsWith('#')) || '';
  const fromTitle = VERBS.find((v) => new RegExp(`\\b${v}\\b`, 'i').test(title));
  const briefFromTitle = (title.match(/\b(W[0-5]-\d+)\b/) || [])[1] || null;

  const explicit = get('status');
  const status = (explicit || fromTitle || 'UNPARSED').toUpperCase();

  // Prefer the id parsed from the TITLE over a `brief:` key line.
  //
  // 2026-08-12: W2's returns quote the dispatch line verbatim near the top —
  //   **Brief:** `Projects/Cleaning/dispatch/W2-08-…md` · base `origin/main @ …`
  // — so `get('brief')` scraped a whole file path and the tick rendered it as the
  // brief id, blowing out the column and reading as corruption. A key line only
  // wins if it actually looks like a brief id.
  const keyBrief = get('brief');
  const briefLooksRight = keyBrief && /^W[0-5]-\d+$/.test(keyBrief.trim());

  return {
    status,
    brief: briefLooksRight ? keyBrief.trim() : (briefFromTitle || keyBrief),
    // THE MTIME IS A FACT. `updated:` IS A CLAIM. Prefer the fact.
    //
    // 2026-08-12: W4 wrote the documented header — status/brief/updated, the
    // format this file had spent the whole program looking for — and stamped
    // `updated: 2026-08-12T12:05:00Z`, an hour in the FUTURE. Two consequences,
    // both silent:
    //   · ageOf() went NEGATIVE (-64m), which reads as corruption
    //   · the ack could never stick, because `acked >= updated` is unsatisfiable
    //     against a future timestamp — so the row flagged for W0 forever
    //
    // Same shape as the brief-field scrape one function up: a self-reported value
    // beating a measured one. The file's mtime cannot be wrong about when the
    // file was written; a window's own clock, formatting or arithmetic can.
    //
    // The key line is kept only for display when it AGREES, so a window writing a
    // sensible timestamp still sees it echoed.
    updated: (() => {
      const mtime = fs.statSync(file).mtime;
      const claimed = get('updated');
      const t = claimed ? Date.parse(claimed) : NaN;
      // Accept the claim only if it parses AND is not in the future AND is within
      // a day of the mtime. Otherwise the file itself is the authority.
      if (Number.isFinite(t) && t <= Date.now() && Math.abs(t - mtime.getTime()) < 86400000) {
        return new Date(t).toISOString();
      }
      return mtime.toISOString();
    })(),
    inferred: !explicit && !!fromTitle,
    missing: false,
  };
}

// ---- ack: the other half of making the tick loud ---------------------------
//
// Fixing D32 made every unread outbox flag. Without a way to say "I read this",
// all four rows flag forever — and an instrument that always shouts is ignored
// exactly as fast as one that never does. That would reproduce the original
// blindness from the opposite direction, which is the failure this tool has
// already demonstrated once today.
//
// An ack stores the outbox's mtime at the moment W0 read it. A newer write
// re-flags automatically, so the ack cannot mask a fresh return — it only
// silences the exact bytes W0 has seen.
const ACK_FILE = path.join(ORCH, 'state', 'acked.json');

function readAcks() {
  try { return JSON.parse(fs.readFileSync(ACK_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeAck(window, mtimeIso) {
  const acks = readAcks();
  acks[window] = mtimeIso;
  fs.mkdirSync(path.dirname(ACK_FILE), { recursive: true });
  fs.writeFileSync(ACK_FILE, `${JSON.stringify(acks, null, 2)}\n`);
}

// ---- worktree warmth -------------------------------------------------------
//
// "Is this window mid-run or is it dead?" is the question every wave asks, and
// answering it wrong in either direction is expensive: interrupt a working
// window and you cost it its context; wait on a dead one and you stall the
// program.
//
// 2026-08-11 (D35): W0 was answering it with
//     find <worktree> -newermt '25 minutes ago' | wc -l
// and `find` on this machine is **bfs**, which rejects that timestamp as
// invalid, writes the error to STDERR, and **exits 0**. Through `wc -l` that is
// a confident `0` — "no activity" — for every worktree, always. It read as a
// clean negative answer and contributed to a window being judged stalled.
//
// So: no shelling out to find, and no relative timestamp strings. Walk the tree
// in node, prune the directories that churn for reasons unrelated to work, and
// report the newest mtime as an age.
const PRUNE = new Set(['.git', 'build', '.dart_tool', 'node_modules', '.worktrees', 'Pods', '.symlinks']);

function newestMtime(dir, budget = { n: 20000 }) {
  let newest = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of entries) {
    if (budget.n-- <= 0) break;
    if (e.name.startsWith('.') && e.name !== '.orchestrator') { if (PRUNE.has(e.name)) continue; }
    if (PRUNE.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const m = newestMtime(p, budget);
      if (m > newest) newest = m;
    } else {
      try { const m = fs.statSync(p).mtimeMs; if (m > newest) newest = m; } catch (err) { /* raced */ }
    }
  }
  return newest;
}

function worktreeWarmth(repo) {
  const out = gitOut(repo, ['worktree', 'list', '--porcelain']);
  const dirs = out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim());
  return dirs.map((d) => {
    const m = newestMtime(d);
    return { dir: d, name: path.basename(d), ageMin: m ? Math.round((Date.now() - m) / 60000) : null };
  });
}

function gitOut(cwd, args) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  return (r.stdout || '').toString();
}

function ageOf(iso) {
  if (!iso || iso === 'never') return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

function collect(cfg) {
  const acks = readAcks();
  const claims = claimLib.liveClaims(cfg);
  const byWindow = Object.fromEntries(claims.map((c) => [c.window, c]));
  const rows = [];
  for (const w of Object.keys(cfg.windows).filter((k) => k !== 'W0')) {
    const outbox = path.join(cfg.repo, cfg.outboxDir, `${w}.md`);
    const h = readHeader(outbox);
    const c = byWindow[w] || null;
    const acked = acks[w] && h.updated && Date.parse(acks[w]) >= Date.parse(h.updated);

    // CRITICAL: `acked` ABOVE AND `claimAcked` BELOW ARE DIFFERENT FACTS, and the name
    // collision is why the second went missing for a week. `acked` is W0 having
    // SEEN A RETURN (state/acked.json). `claimAcked` is THE WINDOW HAVING
    // STARTED THE BRIEF (claims/W<n>.json `acked_at`, written only by
    // claim.cjs:ack).
    //
    // ops-orchestration-system.md:776-779 names `acked_at` as THE liveness
    // signal — "has the window STARTED?" — and this function, the liveness
    // instrument, dropped it on the floor. So the one question the tick exists
    // to answer was the one field it did not carry.
    //
    // WARNING: Unacked alone is NOT an alarm: W0 takes the claim before dispatching,
    // so every claim is legitimately unacked for the minutes between prepare
    // and the window reading its brief. It becomes a signal only once it has
    // been unacked for longer than a window could plausibly take to start.
    const claimAcked = c && c.acked_at ? c.acked_at : null;
    const claimAgeMs = c && c.started ? Date.now() - Date.parse(c.started) : 0;
    const staleUnacked = !!(c && c.brief && !claimAcked && !c.expired
      && claimAgeMs > 2 * 3600 * 1000);
    rows.push({
      window: w,
      role: cfg.windows[w].role,
      status: h.status,
      brief: h.brief,
      updated: h.updated,
      age: ageOf(h.updated),
      acked: !!acked,
      // WARNING: staleUnacked deliberately does NOT feed needsW0. `needsW0` means
      // "this window is waiting on W0", and a window that never started is not
      // waiting on anybody — folding it in would overload a flag that already
      // has a precise meaning and make `► N waiting on W0` a lie. It gets its
      // own report line instead.
      needsW0: NEEDS_W0.has(h.status) && !acked,
      staleUnacked,
      claim: c ? {
        brief: c.brief, paths: c.paths, expires: c.expires, expired: c.expired,
        acked_at: c.acked_at ?? null, ageHours: Math.round(claimAgeMs / 3600000),
      } : null,
      outbox,
    });
  }
  return rows;
}

function main() {
  const argv = process.argv.slice(2);
  const cfg = claimLib.loadConfig(process.env.ORCH_PROJECT || 'cleaning');

  const ackIdx = argv.indexOf('--ack');
  if (ackIdx !== -1) {
    // CRITICAL: VALIDATE AGAINST THE ROSTER, NOT A LITERAL. This read `/^W[1-4]$/`
    // while `collect()` above walks `Object.keys(cfg.windows)` — so W5, which
    // IS in the roster, prints a row, and can RETURN, could never be acked.
    // 2026-08-30: W5-12 (landed as #631 four days earlier) held the ► flag with
    // no way to clear it, and `--ack W5` exited 2 with "needs one or more
    // windows" — a message that reads as a typo, not a roster gap. That is the
    // same blindness the comment below was written to prevent, reached from a
    // third side: the headline `► N waiting on W0` was permanently wrong by one.
    const roster = new Set(Object.keys(cfg.windows).filter((k) => k !== 'W0'));
    const targets = argv.slice(ackIdx + 1).filter((a) => roster.has(a));
    if (!targets.length) {
      process.stderr.write('tick: --ack needs one or more windows, e.g. `tick.cjs --ack W1 W3`\n');
      process.exit(2);
    }
    for (const w of targets) {
      const outbox = path.join(cfg.repo, cfg.outboxDir, `${w}.md`);
      if (!fs.existsSync(outbox)) { process.stderr.write(`tick: ${w} has no outbox to ack\n`); continue; }
      // CRITICAL: ACK THE SAME QUANTITY `collect()` COMPARES, NOT THE MTIME.
      //
      // 2026-08-14: this wrote `statSync(outbox).mtime` while `collect()` tests
      // `acks[w] >= h.updated`, and `readHeader` prefers the `updated:` KEY when
      // the window wrote one. W1's outbox carried `updated: 17:30:00Z` against
      // an mtime of 16:33:41Z — a window stamping a timestamp that is not when
      // the bytes landed — so the ack stored 16:33 and the comparison demanded
      // >= 17:30. UNSATISFIABLE. W1 flagged ► through four consecutive acks and
      // W0 stopped believing the column, which is the exact blindness the ack
      // was added to prevent, reached from the other side.
      //
      // Take the LATER of the two: the ack must dominate whatever `collect()`
      // will read, and a window that stamps a future `updated:` should still be
      // silenceable once W0 has actually read those bytes.
      const h = readHeader(outbox);
      const mtime = fs.statSync(outbox).mtime.toISOString();
      const m = (h.updated && Date.parse(h.updated) > Date.parse(mtime))
        ? h.updated
        : mtime;
      writeAck(w, m);
      process.stdout.write(`acked ${w} at ${m} — a newer write will flag again\n`);
    }
    return;
  }

  const rows = collect(cfg);

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  process.stdout.write('W0 TICK — file layer only; no message required\n\n');
  for (const r of rows) {
    const flag = r.needsW0 ? '►' : (r.acked ? '·' : ' ');
    const ack = r.claim && !r.claim.expired
      ? (r.claim.acked_at ? ' ACKED' : (r.staleUnacked ? ' CRITICAL: UNACKED' : ' unacked'))
      : '';
    const claim = r.claim
      ? (r.claim.expired ? `claim EXPIRED (${r.claim.brief || '-'})` : `claim ${r.claim.brief || '-'}${ack} → ${r.claim.expires}`)
      : 'no claim';
    process.stdout.write(
      `${flag} ${r.window.padEnd(3)} ${r.role.padEnd(9)} ${r.status.padEnd(9)} `
      + `${(r.brief || '-').padEnd(14)} ${(r.age ? `${r.age} ago` : 'never').padEnd(10)} ${claim}\n`);
  }

  // A claim held by a window whose outbox says it is idle is the shape that
  // blocks the next brief for up to 8h for no reason.
  // …but ONLY when the outbox is talking about the SAME brief as the claim.
  //
  // A freshly dispatched window legitimately has a claim for W1-48 while its
  // outbox still reads `RETURNED · W1-47` — it has not written anything yet.
  // Without the brief comparison this printed "release it or it blocks the next
  // brief" about a claim taken ninety seconds earlier, and following that advice
  // would unlock a window mid-dispatch. A guard that tells you to undo the thing
  // you just correctly did is worse than no guard.
  const stale = rows.filter((r) => r.claim && !r.claim.expired
    && ['IDLE', 'RETURNED', 'ABSENT'].includes(r.status)
    && (!r.claim.brief || !r.brief || r.claim.brief === r.brief));
  const needs = rows.filter((r) => r.needsW0);

  process.stdout.write('\n');
  if (needs.length) {
    process.stdout.write(`► ${needs.length} window(s) waiting on W0: ${needs.map((r) => `${r.window} ${r.status}`).join(', ')}\n`);
    for (const r of needs) process.stdout.write(`    read ${r.outbox}\n`);
  } else {
    process.stdout.write('nothing waiting on W0.\n');
  }

  // KEY: A CLAIM NOBODY ACKED IS THE ONE THING THIS TICK COULD NOT SEE.
  // ops-orchestration-system.md:776-779 designates `acked_at` as the liveness
  // signal and collect() dropped it, so a window that never picked up its brief
  // was indistinguishable from one working quietly. W0 twice reported a window
  // as "never started" on a brief it had already finished and merged — the
  // reading was backwards because the instrument was blind, not stale.
  //
  // Two hours is the threshold because W0 claims BEFORE dispatching: every
  // claim is legitimately unacked for the minutes between prepare and the
  // window opening its brief, and an alarm that fires on that is an alarm that
  // is always on (tick.cjs:126-127 on exactly this failure).
  const unacked = rows.filter((r) => r.staleUnacked);
  if (unacked.length) {
    process.stdout.write(
      `\nCRITICAL: ${unacked.length} claim(s) never acked — the window may never have opened the brief:\n`);
    for (const r of unacked) {
      process.stdout.write(
        `    ${r.window} ${r.claim.brief} · claimed ${r.claim.ageHours}h ago, no ack\n`);
    }
    process.stdout.write(
      '    Confirm before re-dispatching: an unacked claim on MERGED work means the\n'
      + '    window worked without acking, not that it never started. Check origin/main.\n');
  }

  // Briefs prepared but never SENT.
  //
  // 2026-08-12: W0 twice completed claim → packet → lint and skipped the send.
  // Every one of those steps leaves an artefact; THE SEND LEAVES NOTHING, so a
  // 3/4-dispatched brief is indistinguishable on disk from a 4/4 one and every
  // check reports success. W2 sat idle for 16 minutes under a live claim;
  // W1 declined to start a brief it had only ever seen summarised.
  //
  // dispatch.cjs manufactures the missing artefact. This surfaces it, so an
  // UNDISPATCHED brief is exactly as loud as an unread return.
  // Anchored on ORCH (__dirname), not on a config object this function does not
  // hold. The first draft read CFG.vault, which is not in scope here — and the
  // try/catch below swallowed the ReferenceError, so the block silently printed
  // nothing. That is the exact defect this file exists to surface, committed in
  // the code meant to surface it. The catch now reports rather than hides.
  const pdir = path.join(ORCH, '..', 'claims', '_pending');
  try {
    const pend = fs.existsSync(pdir) ? fs.readdirSync(pdir).filter((f) => f.endsWith('.json')) : [];
    if (pend.length) {
      process.stdout.write(`\nCRITICAL: ${pend.length} brief(s) PREPARED BUT NEVER SENT — a live claim is not a dispatch:\n`);
      for (const f of pend) {
        const r = JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'));
        const mins = Math.round((Date.now() - Date.parse(r.prepared_at)) / 60000);
        process.stdout.write(`    ${r.brief} → ${r.window}   prepared ${mins}m ago   ${r.file}\n`);
      }
      process.stdout.write('    send it, then: node .claude/orchestrator/dispatch.cjs sent <brief-id>\n');
    }
  } catch (e) {
    // A missing directory is normal and already handled by existsSync above, so
    // anything reaching here is a real fault. Say so — a guard that fails
    // silently is worse than no guard.
    process.stdout.write(`\nWARNING:  pending-dispatch check FAILED: ${e.message}\n`);
  }
  // Warmth is reported for every worktree, unattributed — a claim records a
  // brief, not a directory, so W0 reads the mapping rather than the tool
  // guessing it. WARM is evidence a window is working; COLD is a prompt to look,
  // never a verdict on its own. A window can legitimately sit cold through a
  // long bake or a gallery render.
  const warmth = worktreeWarmth(cfg.repo);
  if (warmth.length) {
    process.stdout.write('\nworktrees\n');
    for (const w of warmth) {
      const age = w.ageMin === null ? '  ?' : (w.ageMin < 90 ? `${w.ageMin}m` : `${Math.round(w.ageMin / 60)}h`);
      const tag = w.ageMin === null ? '' : (w.ageMin <= 20 ? '  WARM' : (w.ageMin >= 120 ? '  cold' : ''));
      process.stdout.write(`    ${w.name.padEnd(30)} touched ${age.padStart(4)} ago${tag}\n`);
    }
  }

  for (const r of stale) {
    process.stdout.write(`WARNING:  ${r.window} holds a live claim but reports ${r.status} — release it or it blocks the next brief:\n`
      + `      node .claude/orchestrator/claim.cjs release ${r.window}\n`);
  }

  // CLAIM-vs-DISPATCH RECONCILIATION — W3's idea, 2026-08-15, and it closes a
  // hole this tool could not otherwise see.
  //
  // tick reads WINDOWS. It has never read BRIEFS. So when W4 dispatched W3
  // directly — a real brief, correctly claimed, work that landed as #371 — two
  // PRs went by with W0 unaware they existed, and W0 then told W4 its claim
  // stood 40 minutes after W4 had released it, because it was reasoning about a
  // board that had moved without it.
  //
  // The cheap signal is that a claim's brief id has no corresponding file in
  // Projects/Cleaning/dispatch/. W0 writes every brief it dispatches, so a claim
  // naming a brief W0 never wrote is either a peer-to-peer dispatch or a typo,
  // and both are worth a line. This needs nothing tick cannot already reach.
  //
  // WARNING: It reports; it does not refuse. A peer dispatch is not misconduct — W3's
  // was verified through the claim registry and produced good work — and a tool
  // that blocked it would cost more than the blindness it cures.
  // WARNING: ANCHORED ON ORCH (__dirname), like the _pending block above, and for the
  // reason that block already records: the first draft of THIS block read a
  // `VAULT` that is not in scope, and a bare `catch {}` swallowed the
  // ReferenceError so it printed nothing at all. That is the same defect the
  // file warns about forty lines up, committed again in the code meant to fix a
  // different blindness. The catch reports.
  const ddir = path.join(ORCH, '..', '..', 'Projects', 'Cleaning', 'dispatch');
  try {
    const briefFiles = fs.existsSync(ddir) ? fs.readdirSync(ddir) : [];
    const unlogged = rows.filter((r) => r.claim && !r.claim.expired && r.claim.brief
      && !briefFiles.some((f) => f.startsWith(`${r.claim.brief}-`) || f === `${r.claim.brief}.md`));
    for (const r of unlogged) {
      process.stdout.write(`NOTE: ${r.window} holds claim ${r.claim.brief}, and W0 wrote no brief by that id.\n`
        + '      A peer-dispatched brief, or a typo. Not an error — but it is work W0 cannot see.\n');
    }
  } catch (e) {
    process.stdout.write(`WARNING:  claim/dispatch reconciliation failed: ${e.message}\n`
      + `      (looked in ${ddir})\n`);
  }

  if (argv.includes('--full')) {
    for (const r of rows) {
      if (r.status === 'ABSENT') continue;
      process.stdout.write(`\n───── ${r.window} ─────\n${fs.readFileSync(r.outbox, 'utf8')}\n`);
    }
  }
}

if (require.main === module) main();
module.exports = { collect, readHeader };

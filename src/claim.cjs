#!/usr/bin/env node
/**
 * claim.cjs — path locks for the 1+5 windows.
 *
 * FIX-3 has failed four times as prose: three branches independently authoring
 * the same PrivacyInfo.xcprivacy; two windows executing W1-07 simultaneously
 * ("I wrote that rule into CLAUDE.md … and then broke it the same day"); PR
 * #60; and a day-night spec that would have reproduced #60 verbatim. It failed
 * a fifth time during the forensics session itself, when a peer window's
 * `git add -A` swept four review files into an unrelated commit.
 *
 * Every one of those mitigations asked a window to NOTICE something. A rule
 * that asks a window to notice is not a lock. This is a lock: the claim is a
 * file, and a pre-commit hook reads it.
 *
 * USAGE
 *   claim.cjs claim W1 --brief W1-41 --paths 'lib/**,test/**' [--hours 8]
 *   claim.cjs ack W1 --brief W1-41                   DO THIS FIRST, on every brief
 *   claim.cjs release W1 [--brief W1-107]   (--brief REFUSES on a rotated claim)
 *   claim.cjs check <path> [<path>…] [--window W1]   exit 1 if claimed by another
 *   claim.cjs list
 *
 * 🔴 `ack` was IMPLEMENTED AND UNDOCUMENTED from its introduction until
 *    2026-08-14, described only in the DESIGN NOTES ~220 lines below. Every
 *    window read this block, none read the note, and `acked_at` sat frozen
 *    for all four windows for two days while `list` dutifully printed
 *    UNACKED. The liveness instrument reported a real signal that measured
 *    documentation, not liveness — nobody was skipping a step, the step was
 *    invisible. A subcommand that is not in USAGE does not exist.
 *
 * DESIGN NOTES
 *   - Expiry is mandatory. A dead window must not block the repo forever; the
 *     failure mode of a lock nobody can clear is worse than the collision.
 *   - Claims are per-window, not per-branch. Two branches from one window are
 *     that window's problem; the lock exists to separate WINDOWS.
 *   - Matching is prefix + glob, deliberately coarse. A lock that is subtle is
 *     a lock that gets argued with.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ORCH = __dirname;
const DEFAULT_PROJECT = process.env.ORCH_PROJECT || 'cleaning';

function loadConfig(name) {
  const file = path.join(ORCH, 'projects', `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    process.stderr.write(`claim: no usable adapter at ${file}\n`);
    process.exit(2);
  }
}

function claimsDir(cfg) {
  const dir = path.join(cfg.vault, (cfg.claim && cfg.claim.dir) || '.claude/claims');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function claimFile(cfg, window) {
  return path.join(claimsDir(cfg), `${window}.json`);
}

/** All claims that have not expired. Expired files are reported, not deleted. */
function liveClaims(cfg) {
  const dir = claimsDir(cfg);
  const now = Date.now();
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    // `_registry.json` shares this directory but is a binding table, not a
    // claim. It was being listed as `EXPIRED _registry — until undefined`.
    // Harmless today only because it has no `paths` key, so it matched nothing;
    // an underscore-prefixed file is never a claim.
    if (f.startsWith('_')) continue;
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    const expired = !c.expires || Date.parse(c.expires) <= now;
    out.push({ ...c, window: c.window || path.basename(f, '.json'), expired });
  }
  return out;
}

/**
 * Does `file` fall under `pattern`?
 *
 * Supports the two shapes the adapter actually uses — a directory prefix
 * (`lib/`, `lib/**`) and a literal path (`pubspec.yaml`) — plus a simple `*`
 * wildcard. Intentionally not a full glob engine: a lock whose semantics need
 * a manual is a lock that will be argued with rather than obeyed.
 */
function matches(file, pattern) {
  const p = String(pattern).replace(/\/\*\*$/, '/').replace(/\/$/, '/');
  if (p.endsWith('/')) return file === p.slice(0, -1) || file.startsWith(p);
  if (p.includes('*')) {
    const rx = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return rx.test(file);
  }
  return file === p || file.startsWith(`${p}/`);
}

/** Which live claim, if any, held by a DIFFERENT window, covers this file. */
function conflictFor(cfg, file, selfWindow) {
  for (const c of liveClaims(cfg)) {
    if (c.expired) continue;
    if (selfWindow && c.window === selfWindow) continue;
    for (const p of c.paths || []) {
      if (matches(file, p)) return { claim: c, pattern: p };
    }
  }
  return null;
}

// The flags this tool actually understands. Anything else is a mistake, and a
// mistake here is SILENT AND VACUOUS rather than loud.
//
// 2026-08-12: W0 ran `check W3 --paths '3d-source/measure_palette.py'`, copying
// the flag form that `claim` uses. `check` takes POSITIONAL paths, so --paths
// was swallowed as an unknown flag and the positional list was ['W3'] — the
// tool dutifully checked a path named "W3", found no claim on it, and printed
//   ok — 1 path(s) clear
// exit 0. A conflict check that never looked at the file reports the same
// "clear" as one that did. That is D52's shape again (a lock that is live,
// well-formed, and guarding nothing) and D39's fix (packet.cjs already exits 2
// on an unknown flag; this tool never got the same treatment).
// Derived by grepping every `args.<x>` read in this file, not by memory — the
// first draft of this list omitted --epoch and --session, both of which the
// handle verification reads, and a whitelist that is wrong in the omitting
// direction turns a working flag into a hard exit 2.
const KNOWN_FLAGS = new Set([
  'window', 'brief', 'paths', 'hours', 'project', 'token', 'epoch', 'session',
]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!KNOWN_FLAGS.has(key)) {
        process.stderr.write(
          `claim: unknown flag '--${key}'.\n`
          + `       known: ${[...KNOWN_FLAGS].map((k) => `--${k}`).join(' ')}\n`
          + '       Refusing rather than reporting "clear" on a check that never ran.\n'
          + '       Note: `check` takes POSITIONAL paths — `check <path>… [--window W1]`.\n',
        );
        process.exit(2);
      }
      out[key] = argv[++i];
      continue;
    }
    out._.push(a);
  }
  return out;
}

// Read the binding registry, tolerantly. A claim must still be takeable if the
// registry is missing or unreadable — the lock's job is keeping two windows out
// of one file, and it must not become a second thing that can fail closed.
function readBindings(cfg) {
  try {
    // eslint-disable-next-line global-require
    return require('./bind.cjs').readRegistry(cfg) || {};
  } catch {
    return {};
  }
}

function cmdClaim(cfg, args) {
  const bindings = readBindings(cfg);
  const window = resolveWindow(cfg, args, args._[1]);
  // Split on commas OR whitespace.
  //
  // 2026-08-12 (D52): this split on commas only. W0 passed
  //   --paths 'lib/features/customization/** lib/features/shop/** test/**'
  // and the tool stored it as ONE glob with spaces in it — a pattern that
  // matches no file on earth. `list` printed it space-separated, which is
  // exactly how a correct multi-path claim would look, so the display confirmed
  // the mistake. Every multi-path claim taken today was VACUOUS: the lock was
  // live, named the right window and the right brief, and guarded nothing.
  //
  // W4 caught it by running `check` instead of trusting the dispatch message.
  //
  // Accepting both separators removes the footgun rather than documenting it —
  // no path glob in this project contains a space, so whitespace is unambiguous.
  // A trap that cannot be stepped on beats a trap that is well-signposted.
  const paths = args.paths
    ? args.paths.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    : (cfg.windows[window].owns || []);
  if (!paths.length) { process.stderr.write('claim: no paths to claim\n'); process.exit(2); }

  // 2026-08-20 (W4): REFUSE STRAY POSITIONALS. `--paths` consumes exactly ONE
  // argv token, so
  //     claim W4 --paths 'a/**' 'b/**' 'c/**'
  // stored ONLY 'a/**' and dropped the rest into args._ — where nothing read
  // them. The claim was taken, `list` printed it, and the tool reported success
  // while guarding ONE THIRD of what was asked for.
  //
  // That is the same shape as D52 above and strictly worse than the D52 bug: a
  // vacuous claim guards nothing and is at least uniformly wrong, whereas a
  // SILENTLY NARROWED one guards the first directory and leaves the others open
  // while every display agrees with you. W4 found it by re-checking rather than
  // by the tool complaining — which is exactly what a lock must not require.
  //
  // Refusing is correct rather than helpfully joining them: if this silently
  // did `paths.concat(extras)`, the same command would mean different things
  // depending on the caller's quoting, and the next reader could not tell which.
  const strays = args._.slice(2);
  if (strays.length) {
    process.stderr.write(
      `claim: REFUSED — ${strays.length} stray argument(s) after the window: ${strays.join(' ')}\n`
      + "       `--paths` takes ONE argument. Quote the whole list:\n"
      + `         --paths '${[...paths, ...strays].join(',')}'\n`
      + '       Passing them separately claims only the FIRST and reports success —\n'
      + '       a claim narrowed in silence guards less than it says it does.\n',
    );
    process.exit(2);
  }

  // Refuse to claim over another window. W0 claims BEFORE dispatching, so this
  // is where a double-dispatch dies — before two windows are already working.
  const clashes = [];
  for (const p of paths) {
    const probe = p.replace(/\*\*?$/, '').replace(/\/$/, '') || p;
    const c = conflictFor(cfg, probe, window);
    if (c) clashes.push(`  ${p}  →  held by ${c.claim.window} (${c.claim.brief || 'no brief'}) until ${c.claim.expires}`);
  }
  if (clashes.length && !process.env.CLAIM_OVERRIDE) {
    process.stderr.write(`claim: REFUSED — these paths are already claimed:\n${clashes.join('\n')}\n`
      + `Dispatching here would reproduce the PR #60 collision. Wait, narrow the brief, or set CLAIM_OVERRIDE=1.\n`);
    process.exit(1);
  }

  // 2026-08-13 (D429). W2 spent hours editing an UNCLAIMED file while its claim
  // read LIVE: the claim named
  // `lib/features/home_dashboard/presentation/game/components/character_placement.dart`,
  // which does not exist. The real file is under `features/characters/domain/
  // services/` and `check` on it returned "1 path(s) clear" the whole time.
  //
  // 🔑 This tool locks path STRINGS and never asked whether they resolve, so a
  // claim on a typo reported identically to a claim on a real file — and in the
  // dangerous direction: you believe you are protected while you are not.
  //
  // WARN, do not refuse. A literal path may legitimately name a file the brief
  // is about to CREATE (W4-36 claimed `housemateToken.ts` before writing it).
  // Globs are skipped entirely — `assets/images/furniture/laundry_room/**`
  // matching nothing is exactly what W3-60 expects on its first run.
  const missing = paths.filter((p) => !/[*?\[]/.test(p)
    && !fs.existsSync(path.resolve(cfg.repo, p)));
  if (missing.length) {
    process.stderr.write(
      `claim: ⚠️  ${missing.length} literal path(s) do not exist under ${cfg.repo}:\n`
      + missing.map((p) => `  ${p}\n`).join('')
      + `Claiming anyway — a brief may be about to create them. But if this is a\n`
      + `typo, the lock protects nothing and the real file stays open to any window.\n`);
  }

  const hours = parseFloat(args.hours) || (cfg.claim && cfg.claim.defaultHours) || 8;
  const now = new Date();
  // Read what this window held before, so an ack can survive a re-prepare of
  // the same brief. Read here rather than inside the record so the failure mode
  // is a plain null, not a throw inside an object literal.
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(claimFile(cfg, window), 'utf8')); } catch (e) { prior = null; }

  const rec = {
    window,
    brief: args.brief || null,
    paths,
    started: now.toISOString(),
    // 2026-08-12 (W2's finding). W0 wrote a brief, took this claim, stamped the
    // packet, ran the linter — and never sent the dispatch message. The claim
    // was live, the file was on disk, and no window had ever seen it. `list`
    // showed a working window.
    //
    // 🔑 "A LIVE CLAIM IS NOT EVIDENCE A WINDOW IS WORKING — it is evidence YOU
    // DISPATCHED." Those are different facts and only the second was recorded.
    // Same shape as the `check` bug (D124): the reassuring state belongs to a
    // step that never completed.
    //
    // So a claim starts UNACKED. The window acknowledges by running
    //   claim.cjs ack W2 --brief W2-16
    // which is the first thing it does on any brief anyway. An unacked claim is
    // now visibly distinct from a working one, instead of identical to it.
    // 🔴 EXCEPT WHEN THE BRIEF HAS NOT CHANGED — 2026-08-19.
    // `dispatch.cjs prepare` does release-then-claim on EVERY run (:115-117),
    // and W0 re-prepares the same brief routinely: to regenerate a packet whose
    // base has moved, or to WIDEN a claim after a window asks for more paths.
    // Each of those silently cleared a real ack, so `acked_at` was null on all
    // four windows at once and `list` printed UNACKED for windows that were
    // working — an alarm that is always on is ignored exactly as fast as one
    // that never fires (tick.cjs:126-127).
    //
    // 🔑 W0 acted on that reading twice in one day, telling Brendan that W1 had
    // never picked up a brief it had already finished and MERGED. The field was
    // not stale; it was being reset by the orchestrator itself.
    //
    // A genuine ROTATION to a different brief must still reset — the new brief
    // has genuinely not been acked. So carry the ack forward only when the
    // brief is identical, which is exactly the re-prepare case and nothing else.
    acked_at: (prior && prior.brief && args.brief && prior.brief === args.brief)
      ? prior.acked_at
      : null,
    expires: new Date(now.getTime() + hours * 3600 * 1000).toISOString(),
    // 2026-08-12: this read `args.session || CLAUDE_SESSION_ID || null` and was
    // ALWAYS null in practice, because W0 takes the claim on the window's
    // behalf and CLAUDE_SESSION_ID (when set at all) is W0's, not the window's.
    // Every claim on disk held `"session": null`.
    //
    // An unregistered session that spent thirty minutes believing it was W0
    // found this field on its own and named it precisely: "a claim with a null
    // holder is the field that would have let me overwrite it without a
    // conflict." Two other windows had already flagged the same null
    // independently. A claim that does not say who holds it cannot be
    // contradicted by anyone.
    //
    // The holder is the window's BOUND ADDRESS from the registry — the one
    // fact in this system that an unbound session cannot forge, because
    // bind.cjs entries are minted against a challenge the window answers.
    // Falling back to null is kept, but it is now VISIBLE rather than
    // universal: a null here means the window is genuinely unbound.
    session: args.session || bindings[window]?.address || null,
    epoch: bindings[window]?.epoch ?? null,
  };
  fs.writeFileSync(claimFile(cfg, window), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`claimed ${window} · ${paths.join(' ')} · expires ${rec.expires}\n`);
}

/**
 * Resolve a window identity from the positional arg, --window, or the
 * environment — and refuse rather than invent one.
 *
 * D3 (2026-08-11, found by W1): `release --window W1` printed
 * "no claim held by undefined" and exited **0**. A false success on a release
 * is worse than a crash: the claim stays live, the next window is blocked for
 * up to 8h, and nothing anywhere reports it. Both spellings now work, and an
 * unresolvable identity is a non-zero exit.
 */
function resolveWindow(cfg, args, positional) {
  const w = positional || args.window || process.env.ORCH_WINDOW || null;
  if (!w) {
    process.stderr.write('claim: no window given. Use `claim.cjs release W1` or `--window W1`.\n');
    process.exit(2);
  }
  if (!cfg.windows[w]) {
    process.stderr.write(`claim: unknown window '${w}'. Known: ${Object.keys(cfg.windows).join(' ')}\n`);
    process.exit(2);
  }
  return w;
}

// 2026-08-12 (D248) — RELEASE DEFENDED THE SUBTREE AND NOT ITSELF.
//
// This function used to resolve a window name, unlink the file, and print
// `released <W>` — with NO ownership check of any kind. `verifyHandle` sits
// twenty lines below and was never called from this path. So ANY window could
// unlock ANY other window's lane, from a one-word typo, and both the lock and
// the log would report success.
//
// It happened: a window mis-pasted as W2 ran `release W2` and deleted 21978's
// live lock on functions/**. The blast radius was small BY LUCK — the claim
// guarded work that had already landed. Had that window been mid-brief, the
// pre-commit lock would have silently stopped protecting a live lane with
// nothing anywhere reporting it.
//
// That is FIX-3 from a direction the ledger did not cover: every recorded
// instance is two windows WRITING one path. This is one window REMOVING
// another's protection.
//
// Two changes, and the second matters more than the first:
//   --session   when supplied, must match the claim's own session or it aborts.
//   the echo    a release now PRINTS what it is destroying — window, brief,
//               session, paths. W0 legitimately releases other windows' claims
//               all the time, so a hard owner-only rule would break the
//               orchestrator; making the act loud is what turns a silent wrong
//               release into an obvious one, at the moment it happens.
function cmdRelease(cfg, args) {
  const window = resolveWindow(cfg, args, args._[1]);
  const f = claimFile(cfg, window);
  if (!fs.existsSync(f)) {
    process.stdout.write(`no claim held by ${window}\n`);
    return;
  }

  let held = null;
  try { held = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { /* corrupt: still releasable */ }

  // 2026-08-16 (D1180, found by W1) — RELEASE IS KEYED BY WINDOW, SO IT CANNOT
  // TELL "the brief I just finished" FROM "the brief I was just handed".
  //
  // W1 finished W1-107 and ran `/land`, whose closing step is `release W1`.
  // Between the landing and the release, W0 had rotated the window's claim to
  // W1-108. So the release freed W1-108 — a lane nobody had written in yet —
  // and printed a cheerful success naming paths W1 had never touched. The
  // window that lost its protection was the NEXT brief, which is exactly the
  // one nobody is watching.
  //
  // This is D248's shape one turn later: that fix made a wrong release LOUD,
  // and loud was not enough, because the output looked correct to a reader who
  // did not already know which brief was current.
  //
  // `--brief` is the guard. It is optional so W0 keeps its administrative
  // release, but `/land` passes the brief it just landed, and a mismatch is
  // refused rather than reported.
  if (args.brief && held && held.brief && args.brief !== held.brief) {
    process.stdout.write(
      `REFUSED — ${window} holds '${held.brief}', not '${args.brief}'.\n`
      + `    holding: ${held.brief}\n`
      + `    you named: ${args.brief}\n`
      + `  The claim was almost certainly ROTATED to a new brief while you were\n`
      + `  landing the old one. Releasing now would free a lane that has not been\n`
      + `  written in yet. Confirm with \`claim.cjs list\`, then re-run WITHOUT\n`
      + `  --brief if you really mean to drop '${held.brief}'.\n`);
    process.exit(1);
  }

  if (args.session && held && held.session && args.session !== held.session) {
    process.stdout.write(
      `REFUSED — ${window}'s claim belongs to another session.\n`
      + `    claim session: ${held.session}\n`
      + `    yours:         ${args.session}\n`
      + `  A window cannot release a lane it does not hold. If you are W0 acting\n`
      + `  administratively, re-run without --session and the release will be logged.\n`);
    process.exit(1);
  }

  // 🔴 LOG THE RELEASE, BECAUSE THIS FILE ALREADY PROMISES THAT IT DOES.
  //
  // The refusal above tells W0 that an administrative release "will be logged".
  // It was not. `release` was a bare unlinkSync — the claim file is DELETED and
  // nothing anywhere records that it existed, who released it, or when.
  //
  // 2026-08-30: W0 released three claims as housekeeping. W2 saw its live claim
  // vanish 30 hours before its expiry, correctly reported it as "a reset, not an
  // expiry", and asked how to tell. W0 nominated the release row as evidence
  // checkable WITHOUT trusting W0 — and W2 established there is no such row:
  // `claim.cjs list` reports only current holdings, and it declined to read W0's
  // state files directly, which is the correct boundary.
  //
  // 🔑 SO "WAS THIS RELEASED OR DID IT EXPIRE?" WAS UNANSWERABLE FROM STATE, for
  // everyone including W0. A destructive action with no trace is one a window
  // cannot distinguish from a fault — and the window is then reasoning about a
  // fleet event with nothing to read.
  //
  // Append-only, one line per release, never read by any gate: this exists to be
  // greppable after the fact, not to be branched on.
  try {
    const relLog = path.join(ORCH, 'state', 'claim-releases.log');
    fs.mkdirSync(path.dirname(relLog), { recursive: true });
    fs.appendFileSync(relLog, JSON.stringify({
      at: new Date().toISOString(),
      window,
      brief: (held && held.brief) || null,
      session: (held && held.session) || null,
      paths: (held && held.paths) || [],
      expires: (held && held.expires) || null,
      by: args.session ? 'window' : 'W0-administrative',
    }) + '\n');
  } catch (e) {
    // A log that cannot be written must not block the release it describes.
    process.stderr.write(`claim: release log not written (${e.code || e.message})\n`);
  }

  fs.unlinkSync(f);
  process.stdout.write(
    `released ${window}`
    + (held ? ` · ${held.brief || '(no brief)'} · session ${held.session || 'unknown'}\n`
            + `  freed: ${(held.paths || []).join(' ') || '(none)'}\n`
      : '\n'));
}

/**
 * OPERATIONAL IDENTITY — the window holding the lock on a path IS that window.
 *
 * Identity stops being declarative and becomes a consequence: a misidentified
 * window writing outside its subtree is rejected by the lock manager with no
 * identity check involved at all. What this validates is the HANDLE, not a
 * claim about the self — epoch against the registry, the way an NFS filehandle
 * carries a generation number so a recycled inode cannot be reached with a
 * stale reference.
 *
 * Fail-stop, not fail-silent: a mismatch aborts the commit rather than
 * proceeding under the wrong author.
 */
function verifyHandle(cfg, window, presented) {
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(path.join(cfg.vault, '.claude', 'claims', '_registry.json'), 'utf8'));
  } catch (e) {
    return null; // no registry yet — pre-epoch behaviour, nothing to validate against
  }
  const r = reg[window];
  if (!r) return `no binding recorded for ${window} — W0 holds no handle for it`;
  if (presented.epoch !== undefined && String(r.epoch) !== String(presented.epoch)) {
    return `STALE HANDLE — marker carries epoch ${presented.epoch}, registry holds ${r.epoch}. `
         + `This window respawned or was re-bound; its channel became a lie.`;
  }
  if (presented.token !== undefined && r.token !== presented.token) {
    return `token mismatch — the presented value was never delivered to ${window}'s address`;
  }
  if (presented.epoch === undefined && r.epoch) {
    return `marker carries no epoch, but ${window} is bound at epoch ${r.epoch}. `
         + `Rewrite the marker from the bind message.`;
  }
  return null;
}

function cmdCheck(cfg, args) {
  const files = args._.slice(1);
  const self = args.window || process.env.ORCH_WINDOW || null;

  // Zero paths is not "everything is clear", it is "nothing was examined".
  // Same failure as the flag case: the reassuring output belongs to a check
  // that never ran.
  if (!files.length) {
    process.stderr.write('claim: check needs at least one path.\n'
      + '       usage: claim.cjs check <path>… [--window W1]\n'
      + '       Zero paths checked is not zero conflicts.\n');
    process.exit(2);
  }

  // Validate the handle BEFORE the path check. An unresolvable or stale handle
  // must abort rather than fall through to a path comparison made under an
  // identity nobody verified.
  if (self && (args.epoch !== undefined || args.token !== undefined)) {
    const bad = verifyHandle(cfg, self, { epoch: args.epoch, token: args.token });
    if (bad) {
      process.stdout.write(`REFUSED — handle check failed for ${self}\n  ${bad}\n`
        + `\n  This is fail-stop by design. Ask W0 to re-mint:\n`
        + `    node .claude/orchestrator/bind.cjs mint ${self} --address <your address>\n`);
      process.exit(1);
    }
  }

  const bad = [];
  for (const f of files) {
    const c = conflictFor(cfg, f, self);
    if (c) bad.push(`  ${f}\n      claimed by ${c.claim.window} via '${c.pattern}' `
      + `for ${c.claim.brief || 'an unnamed brief'} until ${c.claim.expires}`);
  }
  if (!bad.length) {
    // 2026-08-12 (W2's finding): `check` answers "is this path free of OTHER
    // windows' claims". It has never answered "do you hold it" — and the
    // reassuring line NAMES THE WINDOW, which is what makes it read as
    // confirmation of a claim that may not exist.
    //
    // W2 ran `check <path> --window W2` at the start of three briefs and read
    // `ok — 1 path(s) clear for W2` as "my claim is in place". A window holding
    // a perfect claim and a window holding NOTHING produce the identical line.
    //
    // This is the same defect W1-52 exists to close, one level up: a harness
    // with no code path for failure reports success at a question it was never
    // asked. The zero-paths guard above already makes this argument; the code
    // did not make the jump to the holder.
    //
    // Not fatal — "is this path free" is a legitimate question and callers ask
    // it before claiming. But it must never again be silently readable as
    // "and you hold it."
    if (self) {
      const mine = liveClaims(cfg).find((c) => c.window === self && !c.expired);
      if (!mine) {
        process.stdout.write(
          `ok — ${files.length} path(s) clear (free of other windows' claims)\n`
          + `⚠️  BUT ${self} HOLDS NO LIVE CLAIM. This says the path is FREE, not that it is YOURS.\n`
          + `    Nothing protects it and the pre-commit lock will not defend it.\n`
          + `    If you are starting a brief, W0 must claim it:\n`
          + `      node .claude/orchestrator/claim.cjs claim ${self} --brief <id> --paths '<globs>'\n`,
        );
        return;
      }
      // 2026-08-12 (W1's finding, D170) — THE SAME DEFECT ONE LEVEL DEEPER.
      // The block above closed "you hold NOTHING". It did not close "you hold
      // something, but not THIS". W1 ran
      //   check lib/features/cleaning_session/.../task_completion_page.dart --window W1
      // and got `ok — 1 path(s) clear · W1 holds W1-58`. Both halves true, and
      // the conclusion false: W1-58's globs covered lib/features/tasks/**, not
      // cleaning_session. The line reads as "you may write here" and the one
      // comparison it never made is the path against the caller's OWN globs.
      //
      // Naming the holder made the wrong answer MORE convincing rather than
      // more correct — which is why this is filed as a distinct defect from the
      // fix above rather than a regression of it.
      const uncovered = files.filter(
        (f) => !(mine.paths || []).some((p) => matches(f, p)),
      );
      if (uncovered.length) {
        process.stdout.write(
          `⚠️  ${uncovered.length} of ${files.length} path(s) are FREE but NOT YOURS.\n`
          + `    ${self} holds ${mine.brief || '(no brief)'}, whose globs do not cover:\n`
          + uncovered.map((f) => `      ${f}\n`).join('')
          + `    held globs: ${(mine.paths || []).join(' ') || '(none)'}\n`
          + `    No other window claims these, so there is no conflict — but the\n`
          + `    pre-commit lock protects only what your claim names. Ask W0 to widen it:\n`
          + `      node .claude/orchestrator/claim.cjs claim ${self} --brief ${mine.brief || '<id>'} --paths '<globs>'\n`
          + `    CLAIM_OVERRIDE is NOT the answer to a claim that is merely wrong.\n`,
        );
        return;
      }
      process.stdout.write(
        `ok — ${files.length} path(s) clear AND covered by ${self}'s claim `
        + `${mine.brief || '(no brief)'} until ${mine.expires}\n`,
      );
      return;
    }
    process.stdout.write(`ok — ${files.length} path(s) clear\n`);
    return;
  }
  process.stdout.write(`REFUSED — ${bad.length} path(s) belong to another window:\n${bad.join('\n')}\n`);
  process.exit(1);
}

// A window marks its own claim as seen. Deliberately trivial to run — the
// value is entirely in the DIFFERENCE between acked and not, so anything that
// makes it a chore defeats it.
function cmdAck(cfg, args) {
  const window = resolveWindow(cfg, args, args._[1]);
  const f = claimFile(cfg, window);
  let c;
  try { c = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { process.stderr.write(`ack: ${window} holds no claim to acknowledge\n`); process.exit(2); }
  if (args.brief && c.brief && args.brief !== c.brief) {
    process.stderr.write(`ack: ${window} holds ${c.brief}, not ${args.brief}.\n`
      + '     Refusing — acking the wrong brief is worse than not acking.\n');
    process.exit(2);
  }
  c.acked_at = new Date().toISOString();
  fs.writeFileSync(f, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`acked ${window} · ${c.brief || '(no brief)'} · ${c.acked_at}\n`);
}

function cmdList(cfg) {
  const cs = liveClaims(cfg);
  for (const c of cs) {
    const state = c.expired ? 'EXPIRED' : (c.acked_at ? 'LIVE   ' : 'UNACKED');
    process.stdout.write(`${state} ${c.window}  ${c.brief || '-'}  `
      + `${(c.paths || []).join(' ')}  until ${c.expires}\n`);
  }
  // An empty row is information. Listing only live claims made an unclaimed
  // window INVISIBLE rather than absent — you had to notice a row that was not
  // there, and a missing row is the hardest thing in any output to see.
  // W2 spent a session believing a claim existed partly because nothing ever
  // said it did not.
  const held = new Set(cs.filter((c) => !c.expired).map((c) => c.window));
  const bound = Object.keys(cfg.windows || {}).filter((w) => w !== 'W0' && !held.has(w));
  for (const w of bound) {
    process.stdout.write(`UNCLAIMED ${w}  —  holds nothing (${cfg.windows[w].role})\n`);
  }
  if (!cs.length && !bound.length) process.stdout.write('no claims\n');
}

// Per-command, because a GLOBAL whitelist does not close this hole. The flag
// that produced the vacuous check was `--paths`, which is perfectly valid — for
// `claim`. `check` takes positional paths, so `check W3 --paths <file>` parsed
// as "check the path named W3", found nothing claimed on it, and printed
//   ok — 1 path(s) clear
// The flag was legal, the command was legal, the combination was nonsense, and
// nonsense read exactly like success. A flag is only known relative to a verb.
const COMMAND_FLAGS = {
  claim: new Set(['window', 'brief', 'paths', 'hours', 'project']),
  // `brief` added 2026-08-16 (D1180). ⚠️ THE GUARD IN `cmdRelease` WAS WRITTEN
  // FIRST AND WAS DEAD ON ARRIVAL WITHOUT THIS LINE: `enforceCommandFlags` runs
  // before the subcommand, so `release --brief …` exited 2 on an unknown flag
  // and the new check never executed. Caught by running the refusal case as a
  // control rather than trusting that the code was reached — the same lesson
  // this file already records for `check --paths`.
  release: new Set(['window', 'project', 'session', 'brief']),
  check: new Set(['window', 'project', 'epoch', 'token', 'session']),
  ack: new Set(['window', 'project', 'brief']),
  list: new Set(['project']),
};

function enforceCommandFlags(cmd, args) {
  const allowed = COMMAND_FLAGS[cmd];
  if (!allowed) return;
  const wrong = Object.keys(args).filter((k) => k !== '_' && !allowed.has(k));
  if (!wrong.length) return;
  process.stderr.write(
    `claim: '${cmd}' does not take ${wrong.map((k) => `--${k}`).join(' ')}.\n`
    + `       '${cmd}' accepts: ${[...allowed].map((k) => `--${k}`).join(' ')}\n`
    + (cmd === 'check' && wrong.includes('paths')
      ? '       `check` takes POSITIONAL paths: check <path>… [--window W1]\n'
        + '       Refusing rather than reporting "clear" on a path you did not name.\n'
      : ''),
  );
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.project || DEFAULT_PROJECT);
  enforceCommandFlags(args._[0], args);
  switch (args._[0]) {
    case 'claim': return cmdClaim(cfg, args);
    case 'release': return cmdRelease(cfg, args);
    case 'check': return cmdCheck(cfg, args);
    case 'ack': return cmdAck(cfg, args);
    case 'list': return cmdList(cfg);
    default:
      process.stderr.write('usage: claim.cjs claim W1 --brief W1-41 --paths "lib/**" [--hours 8]\n'
        + '       claim.cjs release W1 [--brief W1-41]\n'
        + '       claim.cjs check <path>… [--window W1]\n'
        + '       claim.cjs ack W1 [--brief W1-53]\n'
        + '       claim.cjs list\n');
      process.exit(2);
  }
}

if (require.main === module) main();
module.exports = { matches, conflictFor, liveClaims, loadConfig };

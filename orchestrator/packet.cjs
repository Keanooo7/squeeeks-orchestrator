#!/usr/bin/env node
/**
 * packet.cjs — emit the generated PACKET block for a dispatch brief.
 *
 * THE POINT: W0 never types a number. Every field below is measured at
 * generation time from a file or from git. This is the answer to the largest
 * defect in the system — the same value restated in a brief header, a gate
 * section, hot.md, the design queue and a skill, with only one of them
 * generated. On 2026-08-11 the design floor was live at four different values
 * simultaneously (669 / 666 / 662 / measured 653).
 *
 * It also resolves a doctrine contradiction: dispatch/SKILL.md:106 says "cite
 * the source of truth, don't restate it", while its own template at :65
 * REQUIRES restating it. Under this script the brief cites; the packet
 * measures.
 *
 * SECURITY: every subprocess uses execFileSync via gates.run with an argv
 * array, never a shell string. See wiki/security-helpers-remediation.md.
 *
 * USAGE
 *   node packet.cjs <brief-path> [options]
 *     --project <name>    adapter in projects/ (default: cleaning)
 *     --window  <W1..W4>  owning window (default: inferred from the brief name)
 *     --paths   <glob,…>  paths to claim (default: the window's owned paths)
 *     --budget  <class>   mechanical|feature|investigation|research (default: the window's)
 *     --hours   <n>       claim duration (default: from the adapter)
 *
 *   node packet.cjs <brief-path> --base origin/feature+<branch>
 *     Stamp a base OTHER than origin/main. Use for any brief whose work lands
 *     on another window's branch rather than on main.
 *
 *   node packet.cjs --verify <brief-path>
 *     Re-measures and exits non-zero if the brief's embedded packet has gone
 *     stale. THIS IS THE PASTE-TIME GATE: a packet whose base no longer matches
 *     origin/main is refused, which is what kills the W1-39 unpinned-base
 *     regression.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ORCH = __dirname;
const gates = require(path.join(ORCH, '..', 'helpers', 'gates.cjs'));
const floors = require(path.join(ORCH, 'lib', 'floors.cjs'));
const claimLib = require(path.join(ORCH, 'claim.cjs'));

const BEGIN = '<!-- PACKET:BEGIN';
const END = '<!-- PACKET:END -->';

function die(msg, code = 2) {
  process.stderr.write(`packet: ${msg}\n`);
  process.exit(code);
}

function loadConfig(name) {
  const file = path.join(ORCH, 'projects', `${name}.json`);
  if (!fs.existsSync(file)) die(`no adapter at ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`adapter ${name}.json did not parse: ${e.message}`);
  }
}

/** Short sha of a ref, measured. Returns null rather than a plausible string. */
function shaOf(repo, ref) {
  const r = gates.run('git', ['rev-parse', '--short', ref], repo, 15000);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

/** Refresh remote refs so `origin/main` is not itself a stale local copy. */
function fetch(repo) {
  return gates.run('git', ['fetch', '--quiet', 'origin'], repo, 60000).ok;
}

// An unknown flag is an ERROR, not something to ignore.
//
// 2026-08-11 (D39): W0 generated a packet with `--class investigation`. The real
// flag is `--budget`. `--class` was accepted into the options object, never
// read, and the packet emitted `budget: mechanical · 80k · no checkpoint` — the
// window's default — for a 400k investigation. Nothing warned. The block says
// "generated · DO NOT HAND-EDIT", so the wrong budget carries the authority of a
// measured field, and a window that believed it would have stopped at 80k on a
// brief that needs five times that.
//
// This is the fourth silent-failure of the day and the pattern is identical
// every time: a wrong input produces a plausible output instead of a refusal.
// The floors already refuse to guess. So does this now.
const KNOWN_FLAGS = new Set(['project', 'window', 'paths', 'budget', 'hours', 'verify', 'update', 'base']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verify') { out.verify = true; continue; }
    if (a === '--update') { out.update = true; continue; }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!KNOWN_FLAGS.has(name)) {
        process.stderr.write(`packet: unknown flag '${a}'.\n`
          + `        known: ${[...KNOWN_FLAGS].map((f) => `--${f}`).join(' ')}\n`
          + '        Refusing rather than emitting a packet with a default you did not ask for.\n');
        process.exit(2);
      }
      out[name] = argv[++i];
      continue;
    }
    out._.push(a);
  }
  return out;
}

/** W1-41-orientation-lock.md -> {id: 'W1-41', window: 'W1', slug: 'orientation-lock'} */
function parseBriefName(briefPath) {
  const base = path.basename(briefPath, '.md');
  // Addendum form first: `W2-02.addendum-01`. W2 (2026-08-11) hit a version of
  // this that could not parse an addendum AND suggested `--window W1` in its
  // remedy — for a file whose name begins W2. A window in a hurry pastes the
  // suggestion and runs the check as the wrong window. Same species as the
  // CLAIM_OVERRIDE text: the remedy sentence is the dangerous part.
  const add = base.match(/^(W(\d)-(\d+))\.addendum-(\d+)$/);
  if (add) return { id: add[1], window: `W${add[2]}`, slug: add[1], addendum: add[4] };
  const m = base.match(/^(W(\d)-(\d+))-(.+)$/);
  if (!m) return { id: base, window: null, slug: base };
  return { id: m[1], window: `W${m[2]}`, slug: m[4] };
}

function pad(label) {
  return (`${label}:`).padEnd(14, ' ');
}

function build(briefPath, opts) {
  const cfg = loadConfig(opts.project || 'cleaning');
  const repo = cfg.repo;
  if (!fs.existsSync(repo)) die(`repo not found: ${repo}`);

  const meta = parseBriefName(briefPath);
  const window = opts.window || meta.window;
  if (!window || !cfg.windows[window]) {
    die(`could not determine the owning window from "${path.basename(briefPath)}".\n`
      + `       Pass the window explicitly, e.g. --window W2. Do NOT copy an example: this message\n`
      + `       used to suggest a specific window and would have been pasted for the wrong one.`);
  }
  const win = cfg.windows[window];

  // ---- base: measured, never quoted -------------------------------------
  fetch(repo);
  // 🔴 `--base <ref>` — 2026-08-20, found by W1 on W1-145.
  //
  // A brief that targets ANOTHER WINDOW'S BRANCH still got `base: origin/main`
  // stamped unconditionally, while its body correctly named
  // `origin/feature+first-furniture-finish-batch`. The packet and the prose
  // disagreed, and the packet is the half a window is told to trust.
  //
  // 🔑 W1's own words: "a window trusting the packet over the body would have
  // rebuilt W1-144's failure exactly" — which is the failure where twelve
  // ledger entries on a main-based branch go red twelve times because the art
  // they describe lives on the other branch. The packet would have sent the
  // next window straight back into it.
  //
  // ⚠️ A sha in a packet is only true at its timestamp, so a cross-branch base
  // must be RE-MEASURED at paste time like any other — which `--verify` does.
  const baseRef = opts.base || cfg.baseRef || 'origin/main';
  const base = shaOf(repo, baseRef);
  if (!base) die(`could not resolve ${baseRef} in ${repo} — check the ref name and that it is fetched`);

  // Floors are resolved against the BASE branch AND read out of the base ref
  // itself. Two reasons: the feature branch does not exist yet at packet time,
  // and the root checkout may be dirty or mid-rebase — a window branching from
  // origin/main must beat origin/main's floors, not the root's working copy.
  const baseBranch = baseRef.replace(/^origin\//, '');

  // Resolve the floor THIS WINDOW'S GATE ACTUALLY MEASURES.
  //
  // 2026-08-12 (D83): this always resolved 'test' — the Flutter suite — and W2's
  // packet told a backend window its floor was 3062 when `npm test` in functions/
  // measures 342. A window trusting the packet would gate against a suite it
  // never runs, and the block is headed "generated · DO NOT HAND-EDIT", so the
  // wrong number carried the authority of a measured one.
  //
  // Same family as the flag that silently emitted a default budget: a generated
  // block substituting a plausible value for the right one.
  const floorName = win.floor || 'test';
  const testFloor = floors.resolve(floorName, cfg, baseBranch, baseRef);
  const designFloor = floors.resolve('design', cfg, baseBranch, baseRef);

  // ---- budget ------------------------------------------------------------
  const cls = opts.budget || win.budget || 'feature';
  const b = (cfg.budgets || {})[cls];
  const budgetText = b
    ? `${cls} · ${Math.round(b.budget / 1000)}k` + (b.checkpoint ? ` · checkpoint at ${Math.round(b.checkpoint / 1000)}k` : ' · no checkpoint')
    : `⚠️ UNKNOWN budget class '${cls}'`;

  // ---- claim -------------------------------------------------------------
  const hours = parseInt(opts.hours, 10) || (cfg.claim && cfg.claim.defaultHours) || 8;
  const now = new Date();

  // Report the LIVE claim when there is one — never the window's default paths.
  //
  // 2026-08-11 (D33): W1-48 was claimed as `lib/features/home_dashboard/** test/**`
  // and the packet printed `lib/** test/** pubspec.yaml pubspec.lock` — the
  // window's `owns` list from the adapter. A window reading that packet would
  // believe it holds ALL of lib/, which is the exact over-claim the lock exists
  // to prevent, and it would believe it on the authority of a block whose banner
  // says every number in it was measured.
  //
  // Same defect as the floors one level out: a generated block that quietly
  // substitutes a default for the real value is worse than a hand-typed one,
  // because "generated" is read as "true".
  let claimPaths = opts.paths ? opts.paths.split(',').map((s) => s.trim()) : null;
  let expires = new Date(now.getTime() + hours * 3600 * 1000);
  let claimNote = ' · PROPOSED, not yet claimed';
  if (!claimPaths) {
    const live = (claimLib.liveClaims(cfg) || []).find((c) => c.window === window && !c.expired);
    if (live) {
      claimPaths = live.paths;
      expires = new Date(live.expires);
      claimNote = '';
    } else {
      claimPaths = win.owns || [];
    }
  }

  const worktree = `git worktree add ${cfg.worktreeDir}/${meta.slug} -b ${cfg.branchPrefix}${meta.slug} ${base}`;
  const outbox = path.join(repo, cfg.outboxDir, `${window}.md`);

  const lines = [];
  lines.push(`${BEGIN} — generated ${now.toISOString()} · DO NOT HAND-EDIT · regenerate at paste time -->`);
  lines.push(`${pad('brief')}${briefPath}`);
  lines.push(`${pad('window')}${window} · ${win.role} · gate: ${win.gate}`);
  lines.push(`${pad('base')}${baseRef} @ ${base}          (measured)`);
  lines.push(`${pad('worktree')}${worktree}`);
  lines.push(`${pad('test floor')}${testFloor.text}`
    + (testFloor.status === floors.OK ? `      (${path.basename(testFloor.source)} · may rise, never fall)` : ''));
  lines.push(`${pad('design floor')}${designFloor.text}`
    + (designFloor.status === floors.OK ? `      (design_baseline.json · may fall, never rise)` : ''));
  if (testFloor.detail && testFloor.status !== floors.OK) lines.push(`${' '.repeat(14)}↳ ${testFloor.detail}`);
  if (designFloor.detail && designFloor.status !== floors.OK) lines.push(`${' '.repeat(14)}↳ ${designFloor.detail}`);
  lines.push(`${pad('claim')}${window} · ${claimPaths.join(' ')} · expires ${expires.toISOString()}${claimNote}`);
  lines.push(`${pad('outbox')}${outbox}`);
  lines.push(`${pad('context map')}.claude/context/${window}.md`);
  lines.push(`${pad('budget')}${budgetText}`);
  lines.push(END);

  return {
    text: lines.join('\n'),
    base,
    baseRef,
    window,
    meta,
    testFloor,
    designFloor,
    stale: false,
  };
}

/**
 * --verify: re-measure and compare against the packet already embedded in the
 * brief. Exit 0 only if the base still matches. Floors that MOVED are reported
 * but are not fatal on their own — a floor legitimately changes when something
 * lands; a base sha changing means the brief is pinned to history.
 */
function verify(briefPath, opts) {
  if (!fs.existsSync(briefPath)) die(`no such brief: ${briefPath}`);
  const body = fs.readFileSync(briefPath, 'utf8');
  const start = body.indexOf(BEGIN);
  const stop = body.indexOf(END);
  if (start === -1 || stop === -1) {
    process.stdout.write(`REFUSED — ${path.basename(briefPath)} has no PACKET block.\n`
      + `Every number in a brief must sit inside one. Generate it:\n`
      + `  node .claude/orchestrator/packet.cjs ${briefPath}\n`);
    process.exit(1);
  }
  const embedded = body.slice(start, stop + END.length);
  const embeddedBase = (embedded.match(/^base:\s+\S+\s+@\s+(\S+)/m) || [])[1] || null;

  const fresh = build(briefPath, opts);

  if (embeddedBase !== fresh.base) {
    process.stdout.write(
      `REFUSED — packet is stale.\n`
      + `  embedded base: ${embeddedBase || '(none — unpinned)'}\n`
      + `  measured base: ${fresh.base}\n`
      + `A brief pinned to a base that is no longer ${fresh.baseRef} sends a window to history.\n`
      + `Regenerate before pasting:\n`
      + `  node .claude/orchestrator/packet.cjs ${briefPath}\n`);
    process.exit(1);
  }

  const notes = [];
  for (const f of [fresh.testFloor, fresh.designFloor]) {
    if (f.status !== floors.OK) notes.push(`  ${f.name} floor: ${f.text}`);
    else if (!embedded.includes(String(f.value))) {
      notes.push(`  ${f.name} floor MOVED to ${f.value} since this packet was generated — regenerate`);
    }
  }
  process.stdout.write(`FRESH — base ${fresh.base} still matches ${fresh.baseRef}.\n`
    + (notes.length ? `${notes.join('\n')}\n` : ''));
  process.exit(0);
}

/**
 * --update: replace the PACKET block inside the brief itself.
 *
 * W2 (2026-08-11) found the structural hole this closes. `--verify` reads the
 * packet embedded in the BRIEF; an addendum carrying a corrected packet is a
 * file the verifier does not read. So "use the packet in the addendum" is an
 * instruction to a human that the gate cannot see, and the gate fails closed
 * forever — correctly refusing, while the right answer sits in a file it never
 * opens. F8 pointed the other way.
 *
 * Resolution: the PACKET is the ONE mutable region of an otherwise immutable
 * brief, because it is GENERATED rather than authored. Its own header says
 * "DO NOT HAND-EDIT · regenerate at paste time" — regenerating it is not
 * editing the brief's instructions. Addenda never restate a packet.
 */
function update(briefPath, opts) {
  if (!fs.existsSync(briefPath)) die(`no such brief: ${briefPath}`);
  const body = fs.readFileSync(briefPath, 'utf8');
  const start = body.indexOf(BEGIN);
  const stop = body.indexOf(END);
  if (start === -1 || stop === -1) die(`${path.basename(briefPath)} has no PACKET block to update`);

  const fresh = build(briefPath, opts);
  const before = (body.slice(start, stop).match(/^base:\s+\S+\s+@\s+(\S+)/m) || [])[1] || '(none)';
  let next = body.slice(0, start) + fresh.text + body.slice(stop + END.length);

  // 2026-09-13 (W0): --update rewrote the PACKET and LEFT THE PREMISE BLOCK
  // STALE, so every re-packeted brief carried a base the packet had moved past
  // and an `expect <old-sha>` gate that could only fail. A one-time sweep of 94
  // briefs produced 91 guaranteed-failing premise gates in a single command,
  // and `dispatch.cjs prepare` then refused all of them — correctly, and for a
  // reason the tool had just created.
  // 🔑 The base sha is GENERATED, exactly like the packet, so the premise row
  // that asserts it belongs to the same regeneration. Only the row whose
  // COMMAND resolves origin/main is touched; every other premise row is the
  // brief's own authored assertion and is left alone.
  let premiseMoved = 0;
  next = next.replace(
    /^expect\s+([0-9a-f]{7,40})\s+::\s+(.*rev-parse\s+--short\s+origin\/main.*)$/gm,
    (line, oldSha, cmd) => {
      if (oldSha === fresh.base) return line;
      premiseMoved += 1;
      return `expect ${fresh.base} :: ${cmd}`;
    },
  );

  fs.writeFileSync(briefPath, next);
  process.stdout.write(`updated ${path.basename(briefPath)} — base ${before} → ${fresh.base}`
    + (premiseMoved ? ` · ${premiseMoved} premise row(s) re-pinned` : '')
    + `\n`);
  const bad = [fresh.testFloor, fresh.designFloor].filter((f) => f.status !== floors.OK);
  if (bad.length) process.stderr.write(`packet: ${bad.length} floor(s) not cleanly measured\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const briefPath = args._[0];
  if (!briefPath) {
    process.stderr.write('usage: packet.cjs <brief-path> [--window W1] [--paths a,b] [--budget feature]\n'
      + '       packet.cjs --verify <brief-path>    check freshness, exit 1 if stale\n'
      + '       packet.cjs --update <brief-path>    rewrite the PACKET in place\n');
    process.exit(2);
  }
  if (args.verify) return verify(briefPath, args);
  if (args.update) return update(briefPath, args);

  const p = build(briefPath, args);
  process.stdout.write(`${p.text}\n`);

  // A non-ok floor is not a crash, but it must not pass silently either: the
  // whole point is that "not measured" never renders as a confident number.
  const bad = [p.testFloor, p.designFloor].filter((f) => f.status !== floors.OK);
  if (bad.length) {
    process.stderr.write(`\npacket: ${bad.length} floor(s) not cleanly measured — read the block above before dispatching.\n`);
    process.exit(3);
  }
}

if (require.main === module) main();
module.exports = { build, parseBriefName };

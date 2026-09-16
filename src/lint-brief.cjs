#!/usr/bin/env node
/**
 * lint-brief.cjs — enforce the dispatch brief contract.
 *
 * FIX-5 is drift in a template that nothing enforces. dispatch/SKILL.md:45-96
 * prescribes a format; the last four briefs use none of it. The two sections
 * the doctrine says exist to prevent NAMED, RECORDED failures appear as
 * headings in ZERO of five briefs read:
 *
 *   ## Hypothesis (not instruction)  — the antidote to "briefs have been wrong
 *       on their central claim repeatedly, including two of mine that shipped
 *       as merged PRs". W1-30 blamed bake framing and warned the next window
 *       off the catalogue; the real cause was the renderer sizing sprites by
 *       footprint, fixed in #96.
 *   ## Bar — "a bar with no file is an adjective".
 *
 * A template nothing checks is advice. This makes it a gate.
 *
 * USAGE
 *   lint-brief.cjs <brief.md>…        exit 1 if any brief fails
 *   lint-brief.cjs --all              lint every brief in the dispatch dir
 *   lint-brief.cjs --quiet <file>…    only print failures
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ORCH = __dirname;
const DEFAULT_PROJECT = process.env.ORCH_PROJECT || 'cleaning';

const REQUIRED = [
  { heading: '## Files in scope', why: 'a brief that says "fix the shop" invites a 40-file diff' },
  { heading: '## Hypothesis (not instruction)', why: 'a confident wrong cause propagates straight into the diff (W1-30 → #96)' },
  { heading: '## Bar', why: 'a bar with no file is an adjective' },
  { heading: '## Done when', why: 'nothing is done until it is on main' },
  { heading: '## Do NOT', why: 'the most useful line — it names the adjacent tempting scope balloon' },
  { heading: '## Report', why: 'the return block is how W0 knows anything is true' },
];

// Numbers that must never appear outside a generated PACKET block. These are
// the exact values that were live at four different readings simultaneously on
// 2026-08-11 (design floor 669 / 666 / 662 / measured 653).
//
// 2026-08-12: the bare `floor` alternative with an unbounded `[^\n]*?` gap fired
// TWICE on prose that had nothing to do with a gate:
//   "floor checker. **#207"            → a PR number
//   "plate floor with the lever ... +20" → the REFERENCE PLATE's L* floor
// "plate floor" and "shadow floor" are legitimate domain language in the bake
// programme and will keep recurring, so rewording each brief is not the fix.
//
// Two changes: qualified forms (test/design floor) keep a generous window
// because "test floor: 3082" may sit in a table; a BARE `floor` must be followed
// by digits almost immediately, which "floor 3082" satisfies and a sentence
// about a plate does not. And an explicit exclusion for the domain senses.
// The first alternation is the precise rule: "test floor"/"design floor" near a
// number is always a restated floor. The second is a deliberately loose catch-all
// for bare "floor 2846" — and being loose, it needs two exclusions that cost it
// nothing:
//
//   (?<!#)     a PR reference. "the unit floor rose with #218" is not a restated
//              floor value; #218 is a pull request. (D167)
//   (?!\.\d)   a decimal. Floors are integer counts (3112, 650, 558). A decimal
//              near "floor" is a measurement — an L*p5, a gap, a ratio — as in
//              the doc's own "never one library floor: fridge 57.6". (D176)
//
// Both false positives cost a real dispatch a rewrite before the rule was fixed;
// the second one nearly taught W0 to phrase around the linter rather than trust
// it, which is how a guard stops being read.
// THIRD false positive, 2026-08-16 (D1194): `floor` followed by `-` or `_` is an
// IDENTIFIER, not a measurement — `.worktrees/floor-3797`, `feature+floor-3797`,
// `floor_provenance`. W0 hit it twice in one session and phrased around it the
// first time, which is precisely the failure the comment above names: "the second
// one nearly taught W0 to phrase around the linter rather than trust it, which is
// how a guard stops being read." Rewording a brief to appease a false positive is
// how a gate that cries wolf gets switched off.
// `(?![-_])` after `floor` costs nothing and cannot mask a real restatement,
// because a real one reads "floor 3797" or "floor is 3797" — never "floor-3797".
const FLOOR_WORDS = /\b(?:test floor|design floor)\b[^\n]{0,40}?\b\d{2,}\b|(?<!plate |shadow |ground |sub)\bfloor\b(?![-_])[^\n]{0,12}?(?<!#)\b\d{2,}\b(?!\.\d)/gi;

function loadConfig(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ORCH, 'projects', `${name}.json`), 'utf8'));
  } catch (e) {
    process.stderr.write(`lint-brief: no usable adapter '${name}'\n`);
    process.exit(2);
  }
}

/** Byte ranges covered by PACKET blocks — numbers inside these are generated. */
function packetRanges(text) {
  const out = [];
  const re = /<!-- PACKET:BEGIN[\s\S]*?<!-- PACKET:END -->/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  return out;
}

const inRanges = (i, rs) => rs.some(([a, b]) => i >= a && i < b);

/** Lines that look like a fenced code block or an inline command — exempt. */
function codeRanges(text) {
  const out = [];
  const re = /```[\s\S]*?```/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  return out;
}

function lint(file, cfg) {
  const problems = [];
  if (!fs.existsSync(file)) return [{ level: 'ERROR', msg: 'file does not exist' }];
  const text = fs.readFileSync(file, 'utf8');
  const packets = packetRanges(text);
  const code = codeRanges(text);
  const repo = cfg.repo;
  const vault = cfg.vault;

  // --- 1. required headings ------------------------------------------------
  for (const r of REQUIRED) {
    const rx = new RegExp(`^${r.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
    if (!rx.test(text)) {
      problems.push({ level: 'ERROR', msg: `missing \`${r.heading}\` — ${r.why}` });
    }
  }

  // --- 1b. a ```premise block must exist -----------------------------------
  // 🔑 THIS IS THE DECODE STAGE, AND UNTIL 2026-08-27 IT WAS OPTIONAL — so it
  // was carried by 23 of 584 briefs (3.9%). On 2026-08-24/25 five briefs were
  // dispatched on premises already false AT DISPATCH TIME, and every one was
  // caught by the receiving WINDOW, after it had acked, cut a worktree and
  // started reading — the most expensive moment available. Each was a
  // one-command check. `premise.cjs` existed for all five; nothing required it.
  //
  // ⚠️ A brief with nothing to verify is legitimate — greenfield work asserts
  // nothing about the current tree. Say so IN the block, so "I checked and
  // there was nothing to check" stays distinguishable from "I forgot":
  //     ```premise
  //     # none — greenfield; this brief asserts nothing about the current tree
  //     ```
  // Escape hatch, greppable on purpose: ORCH_PREMISE_OPTIONAL=1
  if (process.env.ORCH_PREMISE_OPTIONAL !== '1' && !/```premise\s*\n/.test(text)) {
    problems.push({
      level: 'ERROR',
      msg: 'no ```premise block — this brief declares no observation anyone can check before dispatch. '
         + 'Add `expect <needle> :: <cmd>` / `absent <needle> :: <cmd>` rows, or an explicit `# none — <why>`.',
    });
  }

  // --- 2. a PACKET block must exist ---------------------------------------
  if (!packets.length) {
    problems.push({
      level: 'ERROR',
      msg: 'no PACKET block — every number must be generated, not typed. '
         + `Run: node .claude/orchestrator/packet.cjs ${path.relative(vault, file) || file}`,
    });
  }

  // --- 3. an unpinned base -------------------------------------------------
  // W1-39:5 regressed to "rebase onto whatever it is when you start", a day
  // after W1-35 pinned all three of its values.
  if (/rebase onto whatever|whatever it is when you start|latest main|current main/i.test(text)) {
    problems.push({ level: 'ERROR', msg: 'unpinned base — the brief must pin a measured sha (see the PACKET `base:` line), not "whatever main is when you start"' });
  }

  // --- 4. floor numbers outside a PACKET ----------------------------------
  let m;
  FLOOR_WORDS.lastIndex = 0;
  while ((m = FLOOR_WORDS.exec(text)) !== null) {
    if (inRanges(m.index, packets) || inRanges(m.index, code)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    problems.push({
      level: 'ERROR',
      msg: `line ${line}: a floor number outside the PACKET block — "${m[0].trim().slice(0, 60)}". `
         + 'Cite the packet; never restate the value. This is the contradiction between '
         + 'dispatch/SKILL.md:106 and its own template at :65.',
    });
  }

  const packetBase = (text.match(/^base:\s+\S+\s+@\s+([0-9a-f]{7,40})/m) || [])[1] || null;

  // --- 5. ## Bar must name a path that exists ------------------------------
  const barMatch = text.match(/^## Bar\s*$([\s\S]*?)(?=^## |\Z)/m);
  if (barMatch) {
    const body = barMatch[1];
    if (/^\s*$/.test(body)) {
      problems.push({ level: 'ERROR', msg: '`## Bar` is empty — omit the section for pure-logic work, or name a reference file' });
    } else if (!/\bomit|not applicable|pure.logic|the suite is (already )?the bar/i.test(body)) {
      // .webp was missing until 2026-08-12 (D90). Every avatar in this project is
      // .webp — all 15 in assets/images/avatars/ — so a brief whose Bar named the
      // fox portrait was told it "names no reference file". The bar existed; the
      // linter could not see it, and a checker blind to a whole format reports the
      // same ERROR as a genuinely missing file.
      // 2026-08-12 (D181): the .webp fix (D90) was too NARROW. It patched the
      // instance rather than asking which extensions the four lanes actually
      // use. The list still had no .ts, .py or .rules — so a W2 brief whose Bar
      // named functions/src/index.ts, or a W3/W4 brief naming a bake script,
      // failed with "a bar with no file is an adjective" while naming a real
      // file. Derived from the lanes this time, not from the failure in hand:
      //   W1 dart · W2 ts + rules · W3/W4 py + png/webp/blend · docs md/json
      // 2026-08-19 (W4-106): THIRD instance of this same defect, and the first
      // two are documented directly above. D90 added .webp, D181 added .ts/.py/
      // .rules "derived from the lanes this time, not from the failure in hand"
      // — but W4's lane was still missed. W4 ships BUILD ARTEFACTS, and a brief
      // whose Bar named build/ios/ipa/cleaning-1.0.0+6.ipa was told it "names no
      // reference file" while naming a 92 MB file that exists.
      // 🔑 The lesson the two earlier fixes both stated and neither applied: ask
      // which artefacts EACH LANE actually produces, not which one just failed.
      //   W1 dart · W2 ts + rules · W3 py + png/webp/blend
      //   W4 ipa/xcarchive/plist/pbxproj/entitlements/xcconfig/storekit · docs md/json
      // ⚠️ `+` belongs in the character class. Flutter names build artefacts
      // `<version>+<build>` — cleaning-1.0.0+6.ipa — and without `+` the match
      // starts AFTER it, yielding the path fragment `6.ipa`, which of course
      // does not exist. The error then reads "names 6.ipa, which does not
      // exist" and looks like a typo in the brief rather than a bug here.
      // `sh` added 2026-09-03 (W4-141). W4-140 landed `ios/verify_storekit.sh`, the
      // first shell GATE in the repo, and the follow-up brief could not name it as
      // its bar: the Bar was rejected as "names no reference file" while pointing at
      // a real, committed, executable guard. Same shape as the .webp gap of
      // 2026-08-12 — an allowlist is a population, and a population is where a
      // gate's blindness lives.
      // 2026-09-13 (W4-151): FOURTH instance of this same defect, and the three
      // above each said the lesson and each patched the instance in hand. W4's
      // lane deals in DEPENDENCY PIN FILES and neither extension was here:
      // `ios/Runner.xcworkspace/xcshareddata/swiftpm/Package.resolved` (the real
      // iOS dependency record now that Podfile.lock is down to one pod) and
      // `ios/Podfile.lock`. A brief whose Bar was that exact file — tracked, on
      // origin/main, and the literal subject of the brief — was told it "names no
      // reference file".
      // 🔑 Applying the stated lesson rather than the instance: `.resolved` and
      // `.lock` are both PIN files, both tracked, and both are what a ship-ops
      // brief measures. Added together for that reason, not because one failed.
      const paths = body.match(/[\w.+/-]+\.(png|jpg|jpeg|webp|md|dart|json|blend|ts|py|cjs|js|sh|rules|yaml|yml|ipa|xcarchive|plist|pbxproj|entitlements|xcconfig|storekit|resolved|lock)\b/g) || [];
      if (!paths.length) {
        problems.push({ level: 'ERROR', msg: '`## Bar` names no reference file — a bar with no file is an adjective' });
      } else {
        // 2026-08-15 (D1106): the SAME bug family a third time, and the first
        // two fixes (D90 .webp, D181 the extension list) both patched WHICH
        // paths are matched. This one is about WHERE they are looked for.
        // existsSync reads the ROOT CHECKOUT's working tree, which is an
        // integration tree nobody pulls — it sat at 8c62069 while origin/main
        // was 30+ commits ahead. So a Bar naming 3d-source/factory-floor.json
        // or factory_verify.py (both landed in #409) failed as "does not exist
        // in either repo" while being live on main and readable by any window.
        // A brief citing anything added recently was unlandable.
        //
        // 🔑 This does NOT weaken the check — a path that exists nowhere still
        // errors. It only stops a STALE tree from answering an existence
        // question about a repo that has moved.
        const onMain = (p) => {
          try {
            execFileSync('git', ['-C', repo, 'cat-file', '-e', `origin/main:${p}`], { stdio: 'ignore' });
            return true;
          } catch { return false; }
        };
        // ⚠️ EXPAND `~`. CLAUDE.md REQUIRES a visual return to cite its frame by
        // absolute sandbox path — `make gallery-shots` renders into
        // ~/Library/Containers/com.example.cleaning/Data/Documents/… and the
        // repo copy is destroyed by /land — so a Bar naming the only durable
        // evidence is CORRECT and was being failed for it. The regex strips the
        // leading `~`, leaving `/Library/…`, which resolves nowhere.
        // Found 2026-08-19 writing W1-143, whose bar is the last known-healthy
        // render of the specimen under investigation.
        const home = process.env.HOME || '';
        const expand = (q) => (q.startsWith('/Library/') && home
          ? path.join(home, q)
          : q);
        for (const p of paths) {
          const hit = [repo, vault].some((root) => fs.existsSync(path.join(root, p)))
            || fs.existsSync(p)
            || fs.existsSync(expand(p))
            || onMain(p);
          if (!hit) {
            problems.push({ level: 'ERROR', msg: `\`## Bar\` names \`${p}\`, which does not exist in either repo — /critic cannot open it, so the loop cannot terminate` });
          }
        }
      }
    }
  }

  // --- 5c. prose must not send a window to a base the PACKET has moved past ---
  //
  // 2026-09-13 (W3-166). `packet.cjs --update` regenerates the PACKET block and
  // (since today) the premise row, but it CANNOT touch prose. W3-166's Task
  // section said "rebase onto 0c7b5a0" while its own packet and Done-when said
  // 3ff99ce — SIXTEEN COMMITS apart. The window noticed and used the packet's
  // sha; a window that trusted the Task would have branched from a stale base
  // and every gate it ran would have been green about the wrong tree.
  //
  // 🔑 Only INSTRUCTION-SHAPED shas are flagged. A brief that cites `87c793f`
  // as the commit that landed a fix is making a historical claim and must stay
  // untouched — rewriting those would corrupt real provenance to fix a
  // different problem. So the test is a sha NEAR branch/rebase language, not a
  // sha anywhere. Measured at introduction: 46 briefs carried a stale base sha
  // somewhere in prose; far fewer carry one in an instruction.
  if (packetBase) {
    const prose = text
      .replace(/<!-- PACKET:BEGIN[\s\S]*?PACKET:END -->/g, '')
      .replace(/```premise[\s\S]*?```/g, '');
    const shaRx = /\b([0-9a-f]{7,40})\b/g;
    let sm;
    const seen = new Set();
    while ((sm = shaRx.exec(prose)) !== null) {
      const sha = sm[1];
      if (sha === packetBase || packetBase.startsWith(sha) || sha.startsWith(packetBase)) continue;
      if (seen.has(sha)) continue;
      const around = prose.slice(Math.max(0, sm.index - 70), sm.index + 70);
      // 2026-09-13, second gap found the same day: W2-182's Done-when named a
      // sha as the "restore baseline" for its temporary mutations — two waves
      // stale, and the window caught it rather than the gate. A restore target
      // is an instruction shape exactly like a rebase target: follow it and you
      // compare your work against the wrong tree.
      if (!/rebase|worktree add|checkout -b|branch from|branch off|\bonto\b|branch at|base(?:d)? (?:on|at)|\*{0,2}Base:\*{0,2}|baseline|restore(?:d)? (?:to|against)|compare(?:d)? against/i.test(around)) continue;
      // 2026-09-13, found by the rule's own first corpus run: W1-217 cites
      // `45899ed` as the BRANCH POINT of `feature+orientation-c-piece2`, a
      // different branch it explicitly calls 309 commits behind — and the word
      // "branch" beside it tripped the instruction test. A sha that names
      // ANOTHER branch is provenance, not a base instruction, and rewriting it
      // would destroy the citation the brief exists to carry.
      if (/branch point|feature\+|commits behind|ancestor of/i.test(around)) continue;
      seen.add(sha);
      const line = prose.slice(0, sm.index).split('\n').length;
      problems.push({
        level: 'ERROR',
        msg: `line ~${line}: prose tells the window to branch/rebase at \`${sha}\`, but the PACKET base is \`${packetBase}\`. `
           + 'A window that trusts the prose branches from a stale tree and every gate it runs is green about the wrong commit. '
           + 'Regenerate with packet.cjs and correct the prose, or drop the sha and say "the PACKET base".',
      });
    }
  }

  // --- 5b. every PACKET claim glob must match something ---------------------
  // W2-129, 2026-08-19. The packet claimed `functions/test/**`. That directory
  // does not exist — jest lives in functions/src/__tests__/ — so the glob matched
  // ZERO paths and protected nothing, while the file the work actually needed
  // sat outside the claim. The pre-commit path lock would have refused the
  // commit AFTER the gates had already run.
  //
  // 🔑 A claim that matches nothing reads exactly like a claim that matches
  // everything it should: `claim.cjs list` prints it back verbatim either way.
  // Nothing downstream can tell the two apart, which is why it has to be caught
  // here, at generation time. W2 found it by inspection and asked for this rule.
  const claimLine = text.match(/^claim:\s*(.+)$/m);
  if (claimLine) {
    // Strip the window token, the expiry clause and the PROPOSED suffix.
    // ⚠️ Strip the LEADING window token first, then only the TRAILING
    // `· expires …` clause. Splitting on the first `·` deletes every path and
    // makes this rule vacuous — it passed W2-129, the very brief that motivated
    // it, until that was caught. A lint rule that cannot fail is the defect it
    // was written to prevent.
    const globs = claimLine[1]
      .replace(/^\s*W\d\s*·\s*/, '')
      .replace(/\s*·\s*expires[\s\S]*$/, '')
      .trim()
      .split(/\s+/)
      .filter((g) => g && !/^(expires|PROPOSED|not|yet|claimed)$/i.test(g));

    for (const g of globs) {
      // Resolve the glob's fixed prefix — the part before any wildcard. A glob
      // whose literal prefix does not exist cannot match anything under it.
      let prefix = g.split(/[*?[]/)[0].replace(/\/+$/, '');
      if (!prefix) continue;
      // ⚠️ A brief may legitimately claim a file it is about to CREATE — a new
      // verifier script, a new spec. Checking the full literal path would fail
      // every such brief, so for a wildcard-free path that looks like a FILE
      // (has an extension), check its PARENT DIRECTORY instead. The directory
      // not existing is the real defect; the file not existing is the point.
      // Caught 2026-08-19 while writing W3-120, before it refused a valid brief.
      // 🔑 A GLOB AND A LITERAL PATH ASK DIFFERENT QUESTIONS.
      // A glob FILTERS what exists, so `functions/test/**` matching nothing is
      // a real defect — that is the W2-129 case this rule was written for.
      // A literal path may name a file, or a whole directory, that the brief is
      // ABOUT TO CREATE: `docs/design-refs/fridge--default.png` is correct even
      // though nothing under `docs/design-refs` exists yet.
      //
      // So for a wildcard-free path, walk up to the nearest EXISTING ancestor
      // and accept if the claim is rooted in the repo at all. Only a path whose
      // TOP-LEVEL segment is missing is a typo rather than a plan.
      // Caught 2026-08-20 writing W4-110, whose whole job is creating the
      // reference directory that does not exist.
      if (!/[*?[]/.test(g)) {
        const parts = prefix.split('/').filter(Boolean);
        let rooted = false;
        for (let n = parts.length - 1; n >= 1; n--) {
          const anc = parts.slice(0, n).join('/');
          if (fs.existsSync(path.join(repo, anc)) || fs.existsSync(path.join(vault, anc))) {
            rooted = true; break;
          }
        }
        if (rooted) continue;
      }
      let hit = fs.existsSync(path.join(repo, prefix)) || fs.existsSync(path.join(vault, prefix));
      if (!hit) {
        try {
          execFileSync('git', ['-C', repo, 'cat-file', '-e', `origin/main:${prefix}`], { stdio: 'ignore' });
          hit = true;
        } catch { /* still a miss */ }
      }
      if (!hit) {
        problems.push({
          level: 'ERROR',
          msg: `PACKET claim glob \`${g}\` matches NOTHING — \`${prefix}\` does not exist in either repo. `
             + 'A claim that matches nothing reads as protection and is not: the path lock would refuse '
             + 'the commit after the gates have run. Re-derive the paths from the tree, not from memory.',
        });
      }
    }
  }

  // --- 6. a factual claim with no file:line -------------------------------
  // FIX-7: the orientation spec asserted "all 35 tasks" when task_library.dart
  // has held 30 since 2026-05-11, with a live test asserting it the whole time.
  // It was wrong the DAY IT WAS WRITTEN, then copied into W1-10:43 as a bolded
  // directive an agent was told to obey.
  const claimRx = /^(?!\s*[-*]?\s*(?:base|test floor|design floor)\b).*?\b(all|exactly|there are|we have)\s+(\d{2,})\s+([a-z][\w -]{2,30})/gim;
  while ((m = claimRx.exec(text)) !== null) {
    if (inRanges(m.index, packets) || inRanges(m.index, code)) continue;
    const around = text.slice(Math.max(0, m.index - 200), m.index + 300);
    if (/[\w/-]+\.(dart|ts|py|json|md):\d+/.test(around)) continue; // cited nearby
    const line = text.slice(0, m.index).split('\n').length;
    problems.push({
      level: 'ERROR',
      msg: `line ${line}: counted claim "${m[1]} ${m[2]} ${m[3]}".trim() with no \`file:line\` citation nearby. `
         + 'A spec asserting a count must cite the file it counted — the orientation spec\'s "all 35 tasks" '
         + 'was never true and was obeyed for seven days.',
    });
  }

  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  const quiet = argv.includes('--quiet');
  const cfg = loadConfig(DEFAULT_PROJECT);
  let files = argv.filter((a) => !a.startsWith('--'));

  if (argv.includes('--all')) {
    const dir = path.join(cfg.vault, cfg.dispatchDir);
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => path.join(dir, f));
  }
  if (!files.length) {
    process.stderr.write('usage: lint-brief.cjs <brief.md>… | --all [--quiet]\n');
    process.exit(2);
  }

  // 🔴 A BRIEF ID MUST RESOLVE TO EXACTLY ONE FILE (2026-08-16, D1181, found by W1).
  //
  // A claim names a brief ID and nothing else. On 2026-08-16 W0 numbered a new
  // brief `W4-76` (the fridge) without checking that `W4-76-home-framing.md`
  // already existed. `claim.cjs list` then printed `claimed by W4 … for W4-76`,
  // W1 opened the OTHER W4-76, and correctly concluded that a queued twin of its
  // own brief was about to rebuild work it had just landed.
  //
  // 🔑 Nobody misread anything. TWO WINDOWS REASONED CORRECTLY FROM THE SAME
  // STRING AND REACHED DIFFERENT BRIEFS. That is not a discipline problem and no
  // amount of "read more carefully" fixes it — the identifier was ambiguous.
  //
  // A scan the same day found TWENTY colliding ids in this directory, so the
  // instance W1 tripped over was the visible one, not the only one. Historical
  // duplicates are tolerated when retired: a brief carrying RETIRED or
  // SUPERSEDED in its first 40 lines is a record, not a live instruction, and
  // cannot be claimed against by mistake.
  // ⚠️ AN ADDENDUM IS NOT A DUPLICATE — it is SUPPOSED to share its brief's id.
  // The first version of this check flagged every `<id>[-slug].addendum-NN.md`
  // and turned 349 briefs into 130 failures on its first run. A gate that cries
  // wolf on day one gets relaxed rather than debugged, so it excludes addenda
  // before counting rather than after.
  const isAddendum = (f) => /\.addendum-\d+\.md$/i.test(path.basename(f));
  const idOf = (f) => (isAddendum(f) ? null : (path.basename(f).match(/^(W\d+-\d+)/) || [])[1] || null);
  const retired = (f) => {
    try {
      return /\b(RETIRED|SUPERSEDED)\b/i.test(fs.readFileSync(f, 'utf8').split('\n').slice(0, 40).join('\n'));
    } catch { return false; }
  };
  // 🔴 SCAN THE WHOLE DIRECTORY, NOT JUST THE FILES PASSED IN.
  //
  // `dispatch.cjs prepare` lints ONE file. If this check only compared the
  // argument list, a brand-new brief would never collide with anything and the
  // gate would pass — which is exactly what happened when W0 created a second
  // `W4-76` and linted it alone. The collision is a property of the DIRECTORY,
  // so the directory is what has to be read, every time.
  const dupes = new Map();
  const seen = new Set();
  const dirs = new Set(files.map((f) => path.dirname(path.resolve(f))));
  const pool = [];
  for (const d of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(d).filter((e) => e.endsWith('.md')).map((e) => path.join(d, e)); } catch { /* not a dir we can read */ }
    for (const e of entries) if (!seen.has(e)) { seen.add(e); pool.push(e); }
  }
  for (const f of pool) {
    const id = idOf(f);
    if (id) dupes.set(id, [...(dupes.get(id) || []), f]);
  }
  const collisions = [...dupes.entries()]
    .map(([id, fs_]) => [id, fs_.filter((f) => !retired(f))])
    .filter(([, live]) => live.length > 1);

  // ⚠️ BLOCK ONLY ON A COLLISION INVOLVING A BRIEF YOU ARE ACTUALLY LINTING.
  //
  // Reading the whole directory is what makes the check work at dispatch time —
  // and it also surfaces 14 historical duplicates that predate this gate. Failing
  // every `dispatch.cjs prepare` on somebody else's 2026-07 debt is the textbook
  // way to get a new gate switched off in its first week. So: the id you are
  // dispatching must be unambiguous (FAIL); the rest of the directory is a NOTE.
  const asked = new Set(files.map((f) => path.resolve(f)));
  let failed = 0;
  let noted = 0;
  for (const [id, live] of collisions) {
    const mine = live.some((f) => asked.has(path.resolve(f)));
    if (!mine) { noted += 1; continue; }
    failed += 1;
    process.stdout.write(`FAIL  ${id}  (1)\n`);
    process.stdout.write(`        brief id '${id}' resolves to ${live.length} LIVE files — a claim naming it is ambiguous:\n`);
    for (const f of live) process.stdout.write(`          ${path.basename(f)}\n`);
    process.stdout.write('        Renumber one, or mark the superseded one RETIRED in its first 40 lines.\n');
  }
  if (noted) {
    process.stdout.write(`NOTE  ${noted} pre-existing duplicate brief id(s) elsewhere in this directory `
      + '— not yours, not blocking. `lint-brief.cjs <dir>/*.md` lists them.\n');
  }

  for (const f of files) {
    const problems = lint(f, cfg);
    if (!problems.length) {
      if (!quiet) process.stdout.write(`PASS  ${path.basename(f)}\n`);
      continue;
    }
    failed += 1;
    process.stdout.write(`FAIL  ${path.basename(f)}  (${problems.length})\n`);
    for (const p of problems) process.stdout.write(`        ${p.msg}\n`);
  }

  const n = files.length;
  process.stdout.write(`\n${n - failed}/${n} briefs pass the contract.\n`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();
module.exports = { lint, loadConfig };

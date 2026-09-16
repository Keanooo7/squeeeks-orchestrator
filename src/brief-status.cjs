#!/usr/bin/env node
'use strict';
/**
 * brief-status.cjs — DERIVE a `status:` for every brief, and optionally stamp it.
 *
 * WHY THIS EXISTS
 *
 * There are 584 briefs in `Projects/Cleaning/dispatch/` and **no way to ask
 * which ones are finished.** Three of the 584 carry frontmatter. Answering
 * "what is still open?" means reading filenames and guessing, which is how
 * sixteen branches sat ahead of `origin/main` — the oldest for eleven weeks —
 * while nobody could see them as a list.
 *
 * 🔑 STATUS IS DERIVED, NEVER TYPED. A hand-maintained `status:` field is a
 * second representation of a fact git already holds, and two representations of
 * one fact drift — this vault has the receipts (`test-floor.json` read 2975
 * while the suite measured 2990). So every status here is computed from git and
 * re-computed on every run. Stamping is a cache of the derivation, not a
 * source; re-run it and a stale stamp corrects itself.
 *
 * THE LADDER, most-certain evidence first:
 *   landed      a commit on origin/main names the brief id or its slug
 *   in-flight   a branch or worktree exists for the slug, not yet merged
 *   dispatched  the brief carries a generated PACKET, but no branch exists
 *   draft       no PACKET — it has never been prepared for a window
 *
 * ⚠️ `landed` IS THE ONLY STATUS WITH HARD EVIDENCE. The other three are
 * absence arguments: "no branch exists" is also true of a brief whose branch was
 * archived, and `archive/*` tags are invisible to `git branch` by design. A
 * brief showing `dispatched` may have been finished and tidied away. Do not read
 * the lower three as "unfinished" — read them as "no landing evidence found".
 *
 * Usage:
 *   brief-status.cjs                 counts + the open list
 *   brief-status.cjs --json          machine-readable, every brief
 *   brief-status.cjs --stamp         write `status:` frontmatter (idempotent)
 *   brief-status.cjs --dir <d> --repo <r>
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ORCH = __dirname;
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = argv.includes('--json');
const STAMP = argv.includes('--stamp');

const cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ORCH, 'projects', 'cleaning.json'), 'utf8')); }
  catch { return {}; }
})();
const VAULT = cfg.vault || process.env.ORCH_VAULT || '/path/to/vault';
const REPO = arg('--repo', cfg.repo || process.env.ORCH_REPO || '/path/to/repo');
const DIR = arg('--dir', path.join(VAULT, cfg.dispatchDir || 'Projects/Cleaning/dispatch'));

const git = (args, d = REPO) => {
  try { return execFileSync('git', args, { cwd: d, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return ''; }
};

// ── evidence, gathered once ──────────────────────────────────────────────────
// 🔴 THE COMMIT LOG CANNOT ANSWER "DID THIS LAND". This repo squash-merges, so
// the branch name never reaches the commit message: PR #595's subject is
// `fix(gate): style_review honours the declared watermark (#595)` and the slug
// `style-review-ignores-the-watermark-every-sibling-honours` appears **zero**
// times anywhere in the log. The first version of this file matched on the log
// and reported `landed 0` against 291 merged PRs — a confident, wrong, silent
// answer, which is the exact failure mode this whole pipeline exists to refuse.
// The merged PR's `headRefName` is the only place the branch survives.
const mergedBranches = (() => {
  try {
    const out = execFileSync('gh',
      ['pr', 'list', '--state', 'merged', '--limit', '1000', '--json', 'headRefName', '--jq', '.[].headRefName'],
      { cwd: REPO, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch {
    return null;   // gh absent or offline — say so rather than reporting a false 0
  }
})();
const branches = new Set(git(['branch', '--format=%(refname:short)']).split('\n').map(s => s.trim()).filter(Boolean));
const worktrees = new Set(git(['worktree', 'list', '--porcelain']).split('\n')
  .filter(l => l.startsWith('worktree ')).map(l => path.basename(l.slice(9).trim())));
const prefix = cfg.branchPrefix || 'feature+';

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.md')).sort();

function statusOf(file) {
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const m = /^(W\d)-(\d+)-?(.*)\.md$/.exec(file) || /^(A)-(\d+)-?(.*)\.md$/.exec(file);
  const id = m ? `${m[1]}-${m[2]}` : null;
  const slug = m ? m[3].replace(/\.addendum-\d+$/, '') : file.replace(/\.md$/, '');
  const hasPacket = /<!--\s*PACKET:BEGIN/.test(text);

  // landed — a MERGED PR carried a branch named for this slug. Checked first:
  // a local branch often outlives its merge (`--delete-branch` fails while a
  // worktree holds it), so "a branch exists" does not mean "not landed".
  if (mergedBranches && slug) {
    for (const p of [prefix, 'fix+', 'chore+', 'art+', 'asset+']) {
      if (mergedBranches.has(p + slug)) {
        return { id, slug, status: 'landed', why: `merged PR head ${p}${slug}` };
      }
    }
  }

  // in-flight — a branch or worktree still holds it, and no merged PR claims it
  if (slug && (branches.has(prefix + slug) || worktrees.has(slug))) {
    return { id, slug, status: 'in-flight', why: `branch or worktree exists for ${slug}` };
  }
  if (hasPacket) return { id, slug, status: 'dispatched', why: 'PACKET generated; no branch found' };
  return { id, slug, status: 'draft', why: 'no PACKET block — never prepared' };
}

const rows = files.map(f => ({ file: f, ...statusOf(f) }));
const counts = rows.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});

// ── stamp ────────────────────────────────────────────────────────────────────
if (STAMP) {
  const today = new Date().toISOString().slice(0, 10);
  let wrote = 0, same = 0;
  for (const r of rows) {
    const fp = path.join(DIR, r.file);
    let text = fs.readFileSync(fp, 'utf8');
    const block = `---\nbrief: ${r.id || r.file.replace(/\.md$/, '')}\nstatus: ${r.status}\n`
      + `status_derived: ${today}\nstatus_source: ${r.why}\n---\n`;
    const existing = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (existing) {
      // only replace a block WE generated — never clobber hand-written frontmatter
      if (!/^status_source:/m.test(existing[1])) { same++; continue; }
      const next = block + text.slice(existing[0].length);
      if (next === text) { same++; continue; }
      fs.writeFileSync(fp, next); wrote++;
    } else {
      fs.writeFileSync(fp, block + text); wrote++;
    }
  }
  console.log(`stamped ${wrote} brief(s); ${same} unchanged or hand-written`);
}

// ── report ───────────────────────────────────────────────────────────────────
if (JSON_OUT) { console.log(JSON.stringify({ total: rows.length, counts, briefs: rows }, null, 2)); process.exit(0); }

console.log(`brief-status — ${rows.length} briefs in ${path.relative(VAULT, DIR)}`);
for (const s of ['landed', 'in-flight', 'dispatched', 'draft']) {
  console.log(`  ${s.padEnd(12)} ${String(counts[s] || 0).padStart(4)}`);
}
const open = rows.filter(r => r.status === 'in-flight');
if (open.length) {
  console.log(`\n  IN FLIGHT — a branch or worktree still holds these ${open.length}:`);
  for (const r of open) console.log(`     ${(r.id || '?').padEnd(8)} ${r.slug}`);
}
if (!mergedBranches) {
  console.log('\n  🔴 `gh` returned nothing — NO merged-PR evidence was available, so every');
  console.log('     brief below is under-reported. This is not "nothing landed"; it is');
  console.log('     "nothing could be checked". Re-run with gh authenticated.');
}
console.log('\n  ⚠️ only `landed` has hard evidence. The other three are absence arguments —');
console.log('     an archived branch is invisible to `git branch` by design, so a tidied-away');
console.log('     brief reads as `dispatched`. Read them as "no landing evidence found".');

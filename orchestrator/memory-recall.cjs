#!/usr/bin/env node
'use strict';
/**
 * memory-recall.cjs — answer a question with N memory CARDS instead of the index.
 *
 * WHY THIS EXISTS
 *
 * The palace's best asset is that all 348 memories carry a hand-written
 * `description` — 47,297 B of natural language, mean 136 chars — and **none of
 * it has ever reached a session.** The only thing a session sees is `MEMORY.md`
 * pasted whole: 348 bare slugs, 17,390 B ≈ 4,347 tokens, no evidence, no
 * resolved value. A slug is a claim you have to open a file to cash.
 *
 * KEY: THE TRADE. A `slug + description` card is ~183 B. Eight cards is ~1,466 B
 * ≈ 367 tokens — about **one twelfth** the cost of today's whole index, and
 * unlike the index it carries the actual finding rather than a pointer to it.
 *
 * WARNING: THIS DOES NOT REPLACE THE INDEX, IT RUNS ALONGSIDE IT. The index is
 * exhaustive and unranked; recall is ranked and partial. A ranked list that
 * silently misses the one memory that mattered is worse than a complete list
 * you can grep — so recall always reports what it did NOT return.
 *
 * NOTE: It deliberately does NOT reuse `intelligence.cjs`'s Jaccard-trigram +
 * PageRank ranker. That ranker scores `auto-memory-store.json`, a write-only
 * mirror whose backend's `search()` is literally `return []` — retired
 * 2026-08-27. This reads the memory files themselves, which are the source of
 * truth, and needs no store, no graph and no cache.
 *
 * Usage:
 *   memory-recall.cjs "<query>" [-n 8] [--json] [--full] [--dir <d>]
 *     -n      how many cards (default 8)
 *     --full  include each memory's first body paragraph, not just the description
 *     --json  machine-readable
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = argv.includes('--json');
const FULL = argv.includes('--full');
const N = Math.max(1, parseInt(arg('-n', '8'), 10) || 8);
// CRITICAL: READ EVERY STORE THE FLEET WRITES TO, NOT JUST THE VAULT'S.
//
// This resolved to ONE directory — the vault's — and `CLAUDE.md` points every
// session here to answer "has this bitten us before?". But a window running in
// the Cleaning repo writes to the CLEANING project's store, by construction:
// the memory path is derived from the session's own project. On 2026-08-30 four
// windows wrote THIRTEEN memories in an afternoon — the cast is not skinned, a
// one-sided probe answers a different question, verify a peer against state it
// had to write — and recall could not see one of them.
//
// WARNING: THE FAILURE IS NOT "RECALL RETURNS NOTHING", IT IS THAT RECALL RETURNS
// NOTHING CONFIDENTLY. A window asks whether this has bitten us before, hears
// no, and concludes the ground is fresh — so the tool that exists to prevent
// repeats was quietly guaranteeing them. (W4's framing, 2026-08-30.)
//
// NOTE: `--dir` still pins a single store, so any caller that passes it is
// unaffected. Only the DEFAULT widens.
const DEFAULT_STORES = [
  '-Users-brendankeane-Desktop-Claude-Memory-Palace',
  '-Users-brendankeane-Documents-GitHub-Cleaning',
].map(p => path.join(process.env.HOME, '.claude/projects', p, 'memory'));

const dirArg = arg('--dir', null);
const MEM_DIRS = (dirArg ? [dirArg] : DEFAULT_STORES).filter(d => fs.existsSync(d));

// CRITICAL: REFUSE AN EMPTY SEARCH RATHER THAN REPORTING ONE AS "A MISS IS A FINDING".
// A mistyped --dir used to search zero files and print the no-prior-record line,
// which is the same confident-negative this widening exists to remove — it would
// tell a window the ground is fresh because the path was wrong. Exit 2 (not 1):
// "could not look" and "looked and found nothing" are different facts.
if (MEM_DIRS.length === 0) {
  console.error(dirArg
    ? `memory-recall: --dir does not exist: ${dirArg}\n` +
      '  Refusing to report an unsearched store as "no prior record".'
    : 'memory-recall: no memory store found. Refusing to report zero files as a miss.');
  process.exit(2);
}

const query = argv.filter((a, i) =>
  !a.startsWith('-') && argv[i - 1] !== '-n' && argv[i - 1] !== '--dir').join(' ').trim();

if (!query) {
  console.error('usage: memory-recall.cjs "<query>" [-n 8] [--full] [--json]');
  process.exit(2);
}

// ── load ─────────────────────────────────────────────────────────────────────
/** Frontmatter is scalar-only here, so a 20-line reader beats a YAML dependency. */
function readMemory(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const out = { slug: path.basename(file, '.md'), description: '', type: '', learned_at: '', body: '' };
  if (!m) { out.body = text.trim(); return out; }
  for (const line of m[1].split('\n')) {
    const kv = /^\s*(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    // single- or double-quoted scalar → unwrap, doubling-escape for single
    if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    else if (/^".*"$/.test(v)) v = v.slice(1, -1);
    if (kv[1] === 'description') out.description = v;
    if (kv[1] === 'type') out.type = v;
    if (kv[1] === 'learned_at') out.learned_at = v;
  }
  out.body = m[2].trim();
  return out;
}

// A slug present in two stores is ONE memory, and the vault's copy wins because
// it is the curated one — DEFAULT_STORES is ordered, first writer of a slug keeps it.
const bySlug = new Map();
for (const dir of MEM_DIRS) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    const m = readMemory(path.join(dir, f));
    if (!bySlug.has(m.slug)) bySlug.set(m.slug, m);
  }
}
const memories = [...bySlug.values()];

// ── score ────────────────────────────────────────────────────────────────────
const STOP = new Set(('a an the is are was were be been it its this that these those of to in on for'
  + ' and or but not no with without from by as at into over under can cannot do does did done you your'
  + ' i we they them he she his her their our if then than so such only just also very more most'
).split(/\s+/));

const tok = s => (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 2 && !STOP.has(w));

/** IDF over the corpus, so a term every memory shares carries no weight. */
const df = new Map();
const docs = memories.map(m => {
  const t = new Set([...tok(m.slug), ...tok(m.description)]);
  for (const w of t) df.set(w, (df.get(w) || 0) + 1);
  return t;
});
const idf = w => Math.log((memories.length + 1) / ((df.get(w) || 0) + 1));

const qt = tok(query);
const qSet = new Set(qt);

const scored = memories.map((m, i) => {
  const d = docs[i];
  let score = 0;
  for (const w of qSet) if (d.has(w)) score += idf(w);
  // a query term appearing in the SLUG is a stronger signal than in the prose:
  // the slug is the claim, so an exact slug hit is what the reader asked for
  const slugTok = new Set(tok(m.slug));
  for (const w of qSet) if (slugTok.has(w)) score += 0.5 * idf(w);
  // substring rescue: "worktree" should still find "worktrees"
  if (!score) {
    const hay = `${m.slug} ${m.description}`.toLowerCase();
    for (const w of qSet) if (w.length > 4 && hay.includes(w)) score += 0.25 * idf(w);
  }
  return { m, score };
}).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.m.slug.localeCompare(b.m.slug));

const hits = scored.slice(0, N);

// ── render ───────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({
    query, matched: scored.length, returned: hits.length, corpus: memories.length,
    cards: hits.map(h => ({
      slug: h.m.slug, description: h.m.description,
      type: h.m.type, learned_at: h.m.learned_at, score: +h.score.toFixed(3),
    })),
  }, null, 2));
  process.exit(hits.length ? 0 : 1);
}

if (!hits.length) {
  console.log(`no memory matches "${query}" — ${memories.length} searched.`);
  console.log('A miss is a finding: it means this is not written down yet.');
  process.exit(1);
}

let bytes = 0;
const out = [];
for (const { m } of hits) {
  const age = m.learned_at ? ` · ${m.learned_at}` : '';
  out.push(`[[${m.slug}]]${age}\n  ${m.description}`);
  if (FULL) {
    const para = m.body.split('\n\n').find(p => p.trim()) || '';
    if (para) out.push(`  ${para.replace(/\n/g, '\n  ').slice(0, 600)}`);
  }
}
const text = out.join('\n\n');
bytes = Buffer.byteLength(text);
console.log(text);

console.log(`\n— ${hits.length} of ${scored.length} matches, ${memories.length} memories searched`);
console.log(`— ${bytes} B ≈ ${Math.round(bytes / 4)} tokens  (whole index: 17390 B ≈ 4347 tokens)`);
if (scored.length > hits.length) {
  console.log(`— NOT shown: ${scored.length - hits.length} lower-ranked matches. `
    + `Re-run with -n ${Math.min(scored.length, hits.length + 10)}, or grep MEMORY.md — ranking is partial by design.`);
}

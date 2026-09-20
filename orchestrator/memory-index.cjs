#!/usr/bin/env node
'use strict';
/**
 * memory-index.cjs — GENERATE MEMORY.md instead of maintaining it.
 *
 * WHY THIS EXISTS
 *
 * `MEMORY.md` is pasted whole into every session, so it is the single most
 * expensive file in the palace and the one most likely to quietly go wrong. It
 * was hand-maintained: 348 links across 15 categories, kept under a ~17 KB cap
 * by a human remembering to. On 2026-08-27 it was audited and found *correct* —
 * 348 of 348 present, zero orphans — which is exactly why it was worth
 * mechanising before it wasn't. An index nothing checks is a claim, not a fact.
 *
 * KEY: IT PRESERVES THE CURATION RATHER THAN REPLACING IT. The category
 * assignment is human work and better than anything derivable — "Tests that
 * pass and prove nothing" is a judgement, not a keyword. So the existing
 * slug→category map is read back out of the current MEMORY.md and kept, in its
 * existing order. Only memories the index has never seen need placing, and
 * those go to `Unfiled` where a human can see them, never silently guessed
 * into a category that happens to share a word.
 *
 * WHAT IT REFUSES
 *   · a memory on disk that no category lists       (it would be invisible)
 *   · a link naming a file that no longer exists     (it would 404 on click)
 *   · the same memory listed twice                   (two rows, one fact)
 *   · the rendered file over its own byte cap        (later groups get cut)
 *
 * WARNING: ONE LINK PER MEMORY, NO PROSE PER ENTRY, NO TITLES. Titles restated the
 * slugs, cost 10.6 KB, and pushed the file past its read limit so later groups
 * vanished entirely. The slug IS the claim; the description belongs to
 * retrieval, not to the index.
 *
 * Usage:
 *   memory-index.cjs            audit only — exit 1 on any drift
 *   memory-index.cjs --write    regenerate MEMORY.md
 *   memory-index.cjs --json     machine-readable audit
 *   memory-index.cjs --dir <d>  operate on another memory dir
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const WRITE = argv.includes('--write');
const JSON_OUT = argv.includes('--json');

const MEM = arg('--dir', path.join(process.env.HOME,
  '.claude/projects/-Users-brendankeane-Desktop-Claude-Memory-Palace/memory'));
const INDEX = path.join(MEM, 'MEMORY.md');
const CAP = 17 * 1024;
const UNFILED = 'Unfiled — place these, or merge them away';

if (!fs.existsSync(MEM)) { console.error(`memory-index: no such dir ${MEM}`); process.exit(2); }

const disk = fs.readdirSync(MEM)
  .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
  .map(f => f.slice(0, -3))
  .sort();
const diskSet = new Set(disk);

/** Split the current index into: header prose, ordered categories, and the map. */
function parseIndex(text) {
  const lines = text.split('\n');
  const firstHeading = lines.findIndex(l => /^##\s+/.test(l));
  const header = (firstHeading === -1 ? lines : lines.slice(0, firstHeading)).join('\n').replace(/\s+$/, '');
  const order = [];
  const members = new Map();   // category -> [slug…] in file order
  let cur = null;
  for (const line of lines.slice(firstHeading === -1 ? lines.length : firstHeading)) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { cur = h[1].trim(); if (!members.has(cur)) { members.set(cur, []); order.push(cur); } continue; }
    if (!cur) continue;
    for (const m of line.matchAll(/\[\[([^\]|#]+)\]\]/g)) {
      const slug = m[1].trim();
      if (!members.get(cur).includes(slug)) members.get(cur).push(slug);
    }
  }
  return { header, order, members };
}

const existing = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '# Memory index\n';
const { header, order, members } = parseIndex(existing);

// ── audit ────────────────────────────────────────────────────────────────────
const seen = new Map();                       // slug -> [categories]
for (const c of order) for (const s of members.get(c)) (seen.get(s) || seen.set(s, []).get(s)).push(c);

const listed = new Set(seen.keys());
const missing = disk.filter(s => !listed.has(s));                 // on disk, unlisted
const orphans = [...listed].filter(s => !diskSet.has(s)).sort();  // listed, no file
const dupes = [...seen.entries()].filter(([, cs]) => cs.length > 1)
  .map(([s, cs]) => ({ slug: s, categories: cs }));

// ── render ───────────────────────────────────────────────────────────────────
const outOrder = order.slice();
const outMembers = new Map(order.map(c => [c, members.get(c).filter(s => diskSet.has(s))]));
if (missing.length) {
  if (!outMembers.has(UNFILED)) { outOrder.push(UNFILED); outMembers.set(UNFILED, []); }
  outMembers.set(UNFILED, [...outMembers.get(UNFILED), ...missing]);
}
// drop a category that ended up empty
for (const c of [...outOrder]) if (!outMembers.get(c).length) outOrder.splice(outOrder.indexOf(c), 1);

// de-duplicate globally, keeping the FIRST category that claimed the slug
const placed = new Set();
for (const c of outOrder) {
  outMembers.set(c, outMembers.get(c).filter(s => (placed.has(s) ? false : (placed.add(s), true))));
}

const body = outOrder.map(c => `## ${c}\n\n${outMembers.get(c).map(s => `[[${s}]]`).join(' · ')}`).join('\n\n');
const rendered = `${header}\n\n${body}\n`;

const report = {
  memories: disk.length,
  listed: listed.size,
  categories: outOrder.length,
  missing, orphans, dupes,
  bytes: Buffer.byteLength(rendered), cap: CAP,
};
const drift = missing.length || orphans.length || dupes.length || report.bytes > CAP;

if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); process.exit(drift ? 1 : 0); }

console.log(`memory-index — ${INDEX}`);
console.log(`  memories on disk   ${report.memories}`);
console.log(`  linked in index    ${report.listed}  across ${report.categories} categories`);
console.log(`  rendered size      ${report.bytes} B / ${CAP} B cap` + (report.bytes > CAP ? '  CRITICAL: OVER' : '  ok'));
console.log(`  unlisted memories  ${missing.length}` + (missing.length ? '  CRITICAL: invisible to every session' : ''));
for (const s of missing) console.log(`      + ${s}`);
console.log(`  orphan links       ${orphans.length}` + (orphans.length ? '  CRITICAL: named file does not exist' : ''));
for (const s of orphans) console.log(`      - ${s}`);
console.log(`  duplicate links    ${dupes.length}`);
for (const d of dupes) console.log(`      ! ${d.slug}  in ${d.categories.join(' + ')}`);

if (WRITE) {
  if (report.bytes > CAP) {
    console.error(`\nCRITICAL: REFUSING TO WRITE — ${report.bytes} B exceeds the ${CAP} B cap.`);
    console.error('   Merge or retire memories; do not raise the cap. Past it, later groups are');
    console.error('   silently truncated out of the session and nothing reports it.');
    process.exit(1);
  }
  const changed = rendered !== existing;
  fs.writeFileSync(INDEX, rendered);
  console.log(`\n✅ wrote ${INDEX}${changed ? '' : ' (byte-identical — the index was already correct)'}`);
  process.exit(0);
}
if (drift) console.log('\n  run with --write to regenerate');
process.exit(drift ? 1 : 0);

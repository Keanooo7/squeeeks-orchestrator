#!/usr/bin/env node
'use strict';
/**
 * memory-lint.cjs — health check over the Claude Code memory store.
 *
 * WHY THIS EXISTS
 *
 * The memory palace's best asset is that all 348 memories carry a
 * natural-language `description` — and until 2026-08-27 nothing ever checked
 * that the store was internally consistent. Six memories had frontmatter that
 * failed YAML parse (a `description:` opening with `"` or a backtick, which
 * YAML reads as a complete scalar and then chokes on the trailing text), and
 * 75 body wikilinks pointed at names that no longer existed.
 *
 * 🔑 A DANGLING [[LINK]] IS NOT AUTOMATICALLY A DEFECT. The convention is that
 * a link to a memory not yet written marks something worth writing later. What
 * IS a defect is a link to a memory that exists under a DIFFERENT name — the
 * reader gets nothing, and the target is right there. This separates the two.
 *
 * Usage:
 *   memory-lint.cjs [--dir <memory-dir>] [--vault <vault>] [--json] [--fix-renames]
 *
 *   --fix-renames  rewrite links whose target exists under a near-identical
 *                  slug (article-prefix drift, a stray `.md`). Nothing else is
 *                  ever rewritten automatically.
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = argv.includes('--json');
const FIX = argv.includes('--fix-renames');

const HOME = process.env.HOME;
const MEM = flag('--dir', path.join(HOME, '.claude/projects/-Users-brendankeane-Desktop-Claude-Memory-Palace/memory'));
const VAULT = flag('--vault', process.env.ORCH_VAULT || '/path/to/vault');

if (!fs.existsSync(MEM)) { console.error(`memory-lint: no such dir ${MEM}`); process.exit(2); }

const files = fs.readdirSync(MEM).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
const names = new Set(files.map(f => f.slice(0, -3)));

/** Every .md/.png basename in the vault — a link may legitimately target a wiki page. */
const vault = new Set();
(function walk(d, depth) {
  if (depth > 6) return;
  let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!['.git', 'node_modules', '.worktrees'].includes(e.name)) walk(path.join(d, e.name), depth + 1); }
    else if (/\.(md|png|jpg)$/.test(e.name)) vault.add(e.name.replace(/\.md$/, ''));
  }
})(VAULT, 0);

/** Article-prefix drift is the observed rename shape: `a-`/`an-`/`the-` gained or lost. */
const strip = s => s.replace(/^(a|an|the)-/, '');
const byStripped = new Map();
for (const n of names) { const k = strip(n); if (!byStripped.has(k)) byStripped.set(k, n); }

const report = { memories: files.length, links: 0, resolved: 0, unparseable: [], renames: [], vaultLinks: [], dangling: {} };

for (const f of files) {
  const fp = path.join(MEM, f);
  let text = fs.readFileSync(fp, 'utf8');

  const fm = text.match(/^---\n([\s\S]*?\n)---\n/);
  if (!fm) report.unparseable.push({ file: f, why: 'no frontmatter' });
  else {
    // Cheap YAML sanity: a value that opens with " or ` and has trailing text.
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w[\w-]*): *(["`])(.*)$/);
      if (m && m[3].includes(m[2]) && !m[3].trim().endsWith(m[2])) {
        report.unparseable.push({ file: f, why: `${m[1]}: opens with ${m[2]} and has trailing text` });
      }
    }
  }

  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  let changed = false;
  for (const raw of body.match(/\[\[[^\]]+\]\]/g) || []) {
    const target = raw.slice(2, -2).split(/[|#]/)[0].trim();
    report.links++;
    if (names.has(target)) { report.resolved++; continue; }

    const noExt = target.replace(/\.md$/, '');
    const alt = names.has(noExt) ? noExt : byStripped.get(strip(noExt));
    if (alt && alt !== target) {
      report.renames.push({ file: f, from: target, to: alt });
      if (FIX) { text = text.split(`[[${target}]]`).join(`[[${alt}]]`); changed = true; }
      continue;
    }
    if (vault.has(noExt)) { report.vaultLinks.push({ file: f, target }); continue; }
    (report.dangling[target] ||= []).push(f.slice(0, -3));
  }
  if (changed) fs.writeFileSync(fp, text);
}

if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const danglingCount = Object.values(report.dangling).reduce((n, a) => n + a.length, 0);
console.log(`memory-lint — ${MEM}`);
console.log(`  memories        ${report.memories}`);
console.log(`  body wikilinks  ${report.links}  (resolved ${report.resolved})`);
console.log(`  unparseable frontmatter   ${report.unparseable.length}`);
console.log(`  🔴 renamed targets        ${report.renames.length}${FIX ? '  — REWRITTEN' : '  — run --fix-renames'}`);
console.log(`  ·  links to vault pages   ${report.vaultLinks.length}  (valid in Obsidian, not memories)`);
console.log(`  ·  forward references     ${danglingCount} links / ${Object.keys(report.dangling).length} targets not yet written`);

for (const u of report.unparseable) console.log(`     UNPARSEABLE  ${u.file} — ${u.why}`);
for (const r of report.renames) console.log(`     RENAME  ${r.file}: [[${r.from}]] -> [[${r.to}]]`);

const top = Object.entries(report.dangling).sort((a, b) => b[1].length - a[1].length);
if (top.length) {
  console.log('\n  most-referenced unwritten memories — each is a memory worth writing:');
  for (const [t, srcs] of top.slice(0, 10)) console.log(`     ${String(srcs.length).padStart(3)}x  [[${t}]]`);
}
process.exit(report.unparseable.length || report.renames.length ? 1 : 0);

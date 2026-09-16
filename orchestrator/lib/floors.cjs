/**
 * floors.cjs — resolve a floor to a MEASURED value, or to UNKNOWN. Never to 0.
 *
 * This file exists because of one bug and one contradiction, both live on
 * 2026-08-11:
 *
 *   1. THE SILENT ZERO. `sync-state.cjs:127` reads
 *          floors[branch] ?? floors.default ?? 0
 *      and the vault floor file contains a real `"default": 0` entry. So a
 *      branch with no floor resolves to 0 and prints `test floor 0`. The `?? 0`
 *      never even fires — the guard added in 99b921c ("Absent or unparseable
 *      reports UNKNOWN, never 0 — a silent 0 reads as 'perfect' when it means
 *      'not measured'") was defeated by data, not by logic. Hence: a resolved
 *      value of 0 is treated as ABSENT here, always.
 *
 *   2. TWO FLOOR FILES. `gates.cjs:26` hardcodes FLOOR_FILE to the VAULT copy,
 *      while bbc5b29 (2026-08-09) created a second one inside the app repo.
 *      They disagree on `main`: vault 2878, repo 2846. Rather than silently
 *      pick one, this reports CONFLICT and names both, so the disagreement is
 *      visible in the packet instead of being resolved by accident.
 *
 * Every result carries a `status` and a `source`. A caller that renders a bare
 * number without checking `status` has reintroduced the bug.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const gates = require(path.join(__dirname, '..', '..', 'helpers', 'gates.cjs'));

const OK = 'ok';
const UNKNOWN = 'unknown';
const CONFLICT = 'conflict';

/** Read and parse JSON. Returns null on any failure — never throws. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/** Resolve a floor spec's file to an absolute path. */
function resolveFile(spec, cfg) {
  const root = spec.scope === 'vault' ? cfg.vault : cfg.repo;
  return path.join(root, spec.file);
}

/**
 * Sum the numeric top-level values, ignoring keys that start with underscore.
 * The design baseline's own _comment defines this rule. Returns null if the
 * object has no numeric fields at all, which is a corrupt file, not a floor of
 * zero.
 */
function sumNumeric(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let sum = 0;
  let seen = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    sum += v;
    seen += 1;
  }
  return seen === 0 ? null : sum;
}

/**
 * Pull a branch-keyed count out of a floor file. Tolerates both shapes in use:
 * a bare number (older entries) and an object with a `count` field.
 */
function branchCount(obj, branch, field) {
  if (!obj || typeof obj !== 'object') return null;
  const entry = obj[branch];
  if (entry === undefined || entry === null) return null;
  const n = typeof entry === 'number' ? entry : entry[field || 'count'];
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  // A resolved 0 means "not measured", never "perfect". See header note 1.
  if (n === 0) return null;
  return n;
}

/**
 * Read one spec into {value|null, file}.
 *
 * When `ref` is set the file is read out of git (`git show <ref>:<path>`)
 * rather than off the working tree. That is the correct source for a dispatch
 * packet: a window branches from origin/main, so the floors it must beat are
 * origin/main's floors — not whatever the root checkout happens to be holding,
 * which may be dirty or mid-rebase. The pre-existing designFloor() in
 * sync-state.cjs already did this; the resolver had to learn it.
 */
function readSpec(spec, cfg, branch, ref) {
  const file = resolveFile(spec, cfg);
  let obj;
  if (ref) {
    const root = spec.scope === 'vault' ? cfg.vault : cfg.repo;
    const r = gates.run('git', ['show', `${ref}:${spec.file}`], root, 20000);
    obj = r.ok ? (() => { try { return JSON.parse(r.out); } catch (e) { return null; } })() : null;
    if (obj === null) return { value: null, file: `${ref}:${spec.file}`, reason: `not present or unparseable at ${ref}` };
  } else {
    obj = readJson(file);
  }
  if (obj === null) return { value: null, file, reason: 'missing or unparseable' };
  // `keyBy: 'none'` — a floor file that is NOT branch-keyed.
  //
  // 2026-08-12 (D83): W2's packet quoted 3062 — the FLUTTER floor — to a backend
  // window whose own suite measures 342. The packet was not consulting
  // functions/test-floor.json at all, and the block is headed
  // "generated · DO NOT HAND-EDIT", so the wrong number carried the authority of
  // a measured one.
  //
  // 📌 W0's FIRST fix was also wrong, and in the way this file exists to prevent:
  // it set field to 'count' after reading a probe that had printed the file's
  // `unit` SUB-OBJECT as though it were the top level. The file is nested —
  // {unit:{count},rules:{count}} — so obj['count'] is undefined and it resolved
  // UNKNOWN. Loud, not silent, which is the only reason it was caught in one
  // step instead of shipping.
  const value = spec.mode === 'sum-numeric'
    ? sumNumeric(obj)
    : (spec.keyBy === 'none'
      ? (() => {
        // field may be a DOTTED PATH — functions/test-floor.json is nested as
        // {unit:{count},rules:{count}} because the two backend suites move
        // independently and one combined number would let a drop in one hide
        // behind a rise in the other.
        const n = String(spec.field || 'count').split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
        return (typeof n === 'number' && Number.isFinite(n) && n > 0) ? n : null;
      })()
      : branchCount(obj, branch, spec.field));
  return { value, file, reason: value === null ? 'no usable entry' : null };
}

/**
 * Resolve one named floor.
 *
 * @returns {{name, status, value, text, source, detail}}
 *   status ok       — one measured value, or two that agree
 *   status unknown  — nothing measurable. `value` is null and `text` is a
 *                     warning. NEVER 0.
 *   status conflict — primary and legacy both parsed and disagree. `value` is
 *                     the PRIMARY (the repo file travels with the code), and
 *                     `text` names both so the disagreement is not hidden.
 */
function resolve(name, cfg, branch, ref) {
  const spec = (cfg.floors || {})[name];
  if (!spec) {
    return { name, status: UNKNOWN, value: null, source: null,
             text: `⚠️ UNKNOWN — no '${name}' floor configured for this project`,
             detail: null };
  }

  const primary = readSpec(spec, cfg, branch, ref);
  const legacySpec = (cfg.legacyFloors || {})[name];
  // The legacy copy is read off the working tree deliberately — it lives in the
  // vault at mode 0600 and is not necessarily tracked, so a `git show` against
  // the app repo's ref would report "absent" and hide the very conflict this
  // comparison exists to surface.
  const legacy = legacySpec ? readSpec(legacySpec, cfg, branch) : null;

  if (primary.value === null) {
    // Do not fall back to legacy silently — that is how the wrong file became
    // authoritative in the first place. Report it, name it, refuse to guess.
    const extra = legacy && legacy.value !== null
      ? ` (legacy copy has ${legacy.value} — NOT used, reconcile it)`
      : '';
    return {
      name, status: UNKNOWN, value: null, source: primary.file,
      text: `⚠️ UNKNOWN — ${primary.reason} for '${branch}' in ${path.basename(spec.file)}${extra}`,
      detail: 'never 0 — an unmeasured floor is not a floor of zero; measure it before gating on it',
    };
  }

  if (legacy && legacy.value !== null && legacy.value !== primary.value) {
    return {
      name, status: CONFLICT, value: primary.value, source: primary.file,
      text: `${primary.value}  ⚠️ CONFLICT — ${legacySpec.scope} copy says ${legacy.value}`,
      detail: `${spec.file} (authoritative, travels with the code) vs `
            + `${legacySpec.scope}:${legacySpec.file} (read by gates.cjs:26). Reconcile before trusting either.`,
    };
  }

  return {
    name, status: OK, value: primary.value, source: primary.file,
    text: String(primary.value),
    detail: spec.direction || null,
  };
}

module.exports = { resolve, sumNumeric, branchCount, readJson, OK, UNKNOWN, CONFLICT };

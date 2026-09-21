# Orchestrator

A gate-first control layer for running several coding agents in parallel against one repository.

The agents here are Claude Code sessions ("windows") working concurrently on the same
codebase. The hard problems are not prompting — they are **mutual exclusion**, **making a
claim checkable**, and **refusing work that only looks finished**. This is the code that
does those three things.

~6,500 lines of dependency-free Node (CommonJS) and bash (6,554 by `git ls-files '*.js' '*.cjs' '*.mjs' '*.sh' | xargs cat | wc -l`). No npm install, no `package.json`,
no third-party imports anywhere in `orchestrator/`.

## The problem

Five agents share one git repo. Each is given a written brief, works in its own worktree, and
reports back. Three failure modes dominate, and all three are silent:

1. **Two agents edit the same path.** The second merge quietly reverts the first.
2. **An agent reports success it did not verify.** "Tests pass" is a claim; `+4180 ~2` is a
   measurement. Only one of those can be checked.
3. **A batch of individually-green branches is not a green tree.** Fifteen PRs each gated on
   its own branch, merged in one sitting, with none gated on the combination.

Every component below exists because one of these actually happened.

## Components

| File | Lines | What it does |
|---|---:|---|
| `orchestrator/claim.cjs` | 713 | The path lock. `claim` / `ack` / `release` / `check`. Writes `claims/W<n>.json` with a mandatory expiry; `check` exits 1 if another window holds an overlapping path. Matching is deliberately coarse — a false collision is cheap, a missed one is not. |
| `orchestrator/lint-brief.cjs` | 544 | The input contract. Six required headings, and no bare number outside a measured `PACKET` block. Written because "a template nothing checks is advice." |
| `orchestrator/tick.cjs` | 476 | The whole observability layer. Reads five outbox headers, five claim files, worktree warmth, and reconciles claims against dispatched briefs. |
| `orchestrator/return-gate.cjs` | 412 | The only component that can refuse a model mid-turn. Five-step check: identity → adapter → landed marker → outbox → return shape. **Fail-open by design** — a gate that wedges a session gets disabled within a day. |
| `orchestrator/packet.cjs` | 383 | Generates the measured block injected into a brief: base sha, both test floors, worktree command, claim, budget. `--verify` exits 1 if the base moved underneath it. |
| `orchestrator/dispatch.cjs` | 306 | Drives premise → claim → packet → lint → pending-marker. **Deliberately does not send the message** — automating that step would replace a *visible* omission with an invisible one. |
| `helpers/gates.cjs` | 503 | The landing gates: analyze, test, floors. |
| `orchestrator/record-floor.cjs` | 295 | Writes a measured test floor, then re-reads and prints what is actually on disk. |
| `orchestrator/return.cjs` | 221 | Grades the **shape** of a return, never its truth. Requires literal gate output, a floor mention, and an `UNANSWERED BY THE BRIEF` section; flags an unannounced `-N` failure tail. |
| `orchestrator/premise.cjs` | 214 | Executes a brief's `premise` block *before* a claim is taken. A premise that cannot run is VACUOUS and fails — absence is not evidence. |
| `orchestrator/check-merge-diff.cjs` | 204 | Diffs `origin/main…HEAD`, not your own commit stat. Built after a stale branch's two-dot diff would have deleted 458 lines belonging to three other lanes while `git diff --stat` read "1 file changed". |
| `orchestrator/rp.cjs` | 180 | Three consistency checks over generated data: claim-vs-packet, filename-vs-window-vs-claim, adapter key presence. |
| `orchestrator/route.cjs` | 178 | Picks a work tier from **counts only**. Nothing here reads the prose of the request, and that is the design. |
| `orchestrator/lib/floors.cjs` | 192 | Resolves a test floor to a measured value **or `UNKNOWN` — never `0`**. |
| `orchestrator/hooks/pre-commit-claim` | 145 | The installed lock. Enforces path ownership, not correctness. |

Also: `brief-status.cjs`, `memory-recall.cjs` (IDF-ranked recall, ~350 tokens vs ~4,300 for a
full index), `memory-index.cjs`, `memory-lint.cjs`, `sync-state.cjs`, `secure-fs.js` (0600
atomic writes), `install-hooks.sh`, `node-wrapper.sh`.

## Design commitments

These are the parts worth reviewing, and each is visible in the code rather than only here.

**An exit code must distinguish "found nothing" from "did not run."** `check-test-floor`
returns `0` pass, `1` below floor, `2` floor undeterminable, `3` environment failure, `4`
unbanked rise. Code 4 exists because the rise branch returned `0` for months while the
recorded floor sat 24 tests behind the tree.

**A floor resolves to `UNKNOWN`, never `0`.** `lib/floors.cjs`. A missing measurement that
defaults to zero is a gate that always passes.

**Grade the shape, not the truth.** `return.cjs` cannot know whether a test really passed. It
can require that the literal output was pasted, which makes the claim checkable by a human in
one glance.

**Refuse to automate the visible omission.** `dispatch.cjs` prepares everything and then stops
short of sending. If the send were automatic, a forgotten dispatch would look identical to a
completed one.

**Fail open, and log.** `return-gate.cjs` allows on any internal error. A blocking gate that
misfires gets switched off permanently; a logging gate that misfires gets fixed.

## Running it

**Prerequisite: a project adapter.** Every script is generic; everything project-specific
lives in one JSON file at `orchestrator/projects/<name>.json`. A second project is a second
file there, never a second script. Copy the example and point it at real directories:

```bash
cp orchestrator/projects/example.json orchestrator/projects/mine.json
# edit "vault" and "repo" to absolute paths on your machine
export ORCH_PROJECT=mine
```

Then:

```bash
node orchestrator/claim.cjs list                     # who holds what
node orchestrator/claim.cjs check W2 lib/foo.dart    # exits 1 on collision
node orchestrator/tick.cjs                           # full status read
node orchestrator/route.cjs                          # work-tier routing, from counts only
node orchestrator/lint-brief.cjs path/to/brief.md    # brief contract; exits 1 on a bad brief
node orchestrator/return.cjs path/to/return.md       # grades the shape of a return
node orchestrator/memory-recall.cjs <query>          # IDF-ranked recall
```

All seven verified against a scratch vault and repo: `claim list`, `claim check`, `tick`,
`route` and `memory-recall` exit 0; `lint-brief` and `return` exit 1 on an empty file, which
is them working. `node --check` passes on all 23 JS files, `bash -n` on both shell files.

**Layout note.** `orchestrator/` and `helpers/` are siblings because the code requires across
that boundary (`helpers/gates.cjs` ← `orchestrator/lib/floors.cjs`). Renaming either directory
breaks three requires.

## Not included

State logs, the planning vault, and the dispatch corpus are omitted — they carry project
content and third-party personal data. Two files retired on 2026-09-13 (`bind.cjs`,
`lib/handshake.cjs`, a challenge-response identity protocol) are kept because `claim.cjs`
still loads `bind.cjs` on a live path; they are marked dead in their own headers and the
distinction is real.

## Provenance

Extracted from a private monorepo on 2026-09-16. The commit history of the development period is
not part of this extract; the commits here are the extract and fixes made after it.

The helper scaffolding came from [claude-flow](https://github.com/ruvnet/claude-flow)
(`helpers/secure-fs.js:3` still says so; `orchestrator/install-hooks.sh:6` names the claude-flow
pre-commit boilerplate it deliberately does not install). The pipeline design and everything
built on that scaffolding is mine.

Development was agent-assisted: the majority
of commits in the source repository carry `Co-Authored-By` trailers naming an AI coding agent.
The design commitments above were human decisions; the implementations were largely
agent-written under review.
